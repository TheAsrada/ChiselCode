import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { safeExtensionText } from "../extensions/external/loader.js";
import { PackageManagementError } from "../extensions/packages/errors.js";
import type { PackageOutcome } from "../extensions/packages/journal.js";
import {
  PackageManagementService,
  type PackagePreview,
} from "../extensions/packages/service.js";
import { packageAction } from "./extension-package-output.js";

interface Options {
  json?: boolean;
  digest?: string;
  ackProcessAccess?: boolean;
  trust?: boolean;
  enable?: boolean;
  disabled?: boolean;
  allowDowngrade?: boolean;
}
const accessExplanation =
  "Доверенный JS выполняется с доступом процесса к файлам, сети и программам. Это не OS sandbox; SHA-256 связывает bytes, а не подтверждает автора.";
function displayPreview(preview: Readonly<PackagePreview>): string {
  return `${preview.name} · ${preview.id} · ${preview.oldVersion ? preview.oldVersion + " → " : ""}${preview.version}${preview.downgrade ? " (downgrade)" : ""}\nПуть установленной версии: ${preview.location}\nSHA-256: ${preview.digest}\nФайлов: ${preview.files} · bytes: ${preview.bytes}\n${preview.incompatible ?? "Совместим"}. Код не выполнялся.\n`;
}
async function trustCandidate(
  preview: Readonly<PackagePreview>,
  options: Options,
): Promise<boolean> {
  if (options.digest && options.digest !== preview.digest)
    throw new PackageManagementError(
      "PACKAGE_DENIED",
      "Digest отличается от captured candidate. Выполните inspect заново.",
    );
  if (options.ackProcessAccess && !options.digest)
    throw new PackageManagementError(
      "PACKAGE_DENIED",
      "Для noninteractive trust укажите точный --digest вместе с --ack-process-access.",
    );
  if (!options.trust && !options.digest && !options.enable) return false;
  process.stderr.write(displayPreview(preview) + accessExplanation + "\n");
  if (options.digest && options.ackProcessAccess) return true;
  if (!stdin.isTTY || !stdout.isTTY)
    throw new PackageManagementError(
      "PACKAGE_DENIED",
      "Без TTY trust/enable требуют --digest <точный SHA-256> --ack-process-access.",
    );
  const input = createInterface({ input: stdin, output: stdout });
  try {
    return (
      (await input.question("Доверить именно эти bytes? Введите «да»: "))
        .trim()
        .toLowerCase() === "да"
    );
  } finally {
    input.close();
  }
}
export function registerPackageManagementCommands(
  extensions: Command,
  program: Command,
): void {
  const service = new PackageManagementService();
  const json = (options: Options) => options.json || program.opts().json;
  const write = (value: unknown, text: string, options: Options) =>
    stdout.write(json(options) ? JSON.stringify(value) + "\n" : text + "\n");
  const outcome = (value: Readonly<PackageOutcome>, options: Options) =>
    write(
      value,
      `${value.id}: ${value.outcome}; ${value.enabled ? "включён" : "выключен"}, доверие ${value.trusted ? "подтверждено" : "не выдано"}.\n${value.location ?? ""}\n${value.deferred ? "Bytes сохранены, физическое удаление/cleanup отложено.\n" : ""}${value.warning ? value.warning + "\n" : ""}${value.restartRequired ? "Перезапустите ChiselCode; загруженный JS продолжает работать до выхода приложения." : "Выбор не изменился."}${!value.trusted && value.location ? "\nСледующий шаг: extensions approve <этот путь> --id <id> --digest <SHA-256> --enable --ack-process-access." : ""}`,
      options,
    );
  const run = <T extends unknown[]>(action: (...args: T) => Promise<void>) =>
    packageAction(program, action);
  const options = (command: Command) =>
    command
      .option("--json", "JSON результат")
      .option("--digest <sha256>", "точный digest candidate для нового trust")
      .option(
        "--ack-process-access",
        "подтверждаю выполнение этих JS bytes с доступом процесса",
      )
      .option(
        "--trust",
        "показать interactive trust конкретного captured candidate",
      )
      .option("--enable", "явно включить после точного trust и restart")
      .option("--disabled", "сохранить выключенным");
  options(
    extensions
      .command("install <source>")
      .description(
        "Установить локальную папку/ZIP; по умолчанию выключено без доверия",
      ),
  ).action(
    run(async (source: string, opts: Options) => {
      if (opts.enable && opts.disabled)
        throw new Error("Выберите --enable или --disabled.");
      const candidate = await service.prepareInstall(source);
      let committed = false;
      try {
        const trusted = await trustCandidate(candidate.preview, opts);
        const result = await service.commitCandidate(candidate, {
          ...(trusted
            ? {
                digest: candidate.preview.digest,
                acknowledgeProcessAccess: true,
              }
            : {}),
          enabled: trusted && !!opts.enable,
        });
        committed = result.outcome === "committed";
        outcome(result, opts);
      } finally {
        if (!committed) await service.abortCandidate(candidate);
      }
    }),
  );
  options(
    extensions
      .command("update <id> <source>")
      .description(
        "Заменить выбранную версию явно указанным локальным пакетом",
      ),
  )
    .option(
      "--allow-downgrade",
      "явно разрешить replacement более ранней версией",
    )
    .action(
      run(async (id: string, source: string, opts: Options) => {
        if (opts.enable && opts.disabled)
          throw new Error("Выберите --enable или --disabled.");
        const candidate = await service.prepareUpdate(id, source, {
          allowDowngrade: !!opts.allowDowngrade,
        });
        let committed = false;
        try {
          const trusted = await trustCandidate(candidate.preview, opts);
          if (!trusted)
            throw new PackageManagementError(
              "PACKAGE_DENIED",
              "Новое доверие не выдано; прежняя выбранная версия сохранена.",
            );
          const result = await service.commitCandidate(candidate, {
            digest: candidate.preview.digest,
            acknowledgeProcessAccess: true,
            ...(opts.enable
              ? { enabled: true }
              : opts.disabled
                ? { enabled: false }
                : {}),
          });
          committed = result.outcome === "committed";
          outcome(result, opts);
        } finally {
          if (!committed) await service.abortCandidate(candidate);
        }
      }),
    );
  for (const enabled of [true, false])
    extensions
      .command(`${enabled ? "enable" : "disable"} <id>`)
      .description(
        enabled
          ? "Включить неизменный пакет с уже выданным точным trust"
          : "Выключить при следующем запуске, сохранив bytes/данные/trust",
      )
      .option("--json", "JSON результат")
      .option("--digest <sha256>", "ожидаемый selected digest")
      .action(
        run(async (id: string, opts: Options) => {
          const status = await service.status(id);
          outcome(
            await service.setEnabled(id, enabled, {
              digest: opts.digest ?? status.selected?.digest ?? "",
              revision: status.revision,
            }),
            opts,
          );
        }),
      );
  extensions
    .command("versions <id>")
    .description("Сохранённые immutable версии и known uses; без загрузки JS")
    .option("--json", "JSON результат")
    .action(
      run(async (id: string, opts: Options) => {
        const status = await service.status(id);
        write(
          status,
          status.versions
            .map(
              (v) =>
                `${v.key === status.selected?.key ? "* " : "  "}${v.version} · ${v.digest} · ${v.approvedAt ? "trust" : "без доверия"}\n${v.location}`,
            )
            .join("\n"),
          opts,
        );
      }),
    );
  extensions
    .command("rollback <id> <version>")
    .description(
      "Явно выбрать сохранённую версию по digest/key; требуется restart",
    )
    .option("--json", "JSON результат")
    .option(
      "--digest <sha256>",
      "точный digest retained версии для утраченного trust",
    )
    .option(
      "--ack-process-access",
      "подтверждаю выполнение указанных bytes с доступом процесса",
    )
    .action(
      run(async (id: string, version: string, opts: Options) => {
        const status = await service.status(id);
        outcome(
          await service.rollback(
            id,
            version,
            {
              digest: status.selected?.digest ?? "",
              revision: status.revision,
            },
            {
              digest: opts.digest,
              acknowledgeProcessAccess: opts.ackProcessAccess,
            },
          ),
          opts,
        );
      }),
    );
  extensions
    .command("remove <id>")
    .description(
      "Удалить подключение и safely unused managed bytes; пользовательские данные сохраняются",
    )
    .option("--json", "JSON результат")
    .option("--digest <sha256>", "ожидаемый selected digest")
    .action(
      run(async (id: string, opts: Options) => {
        const status = await service.status(id);
        outcome(
          await service.remove(id, {
            digest: opts.digest ?? status.selected?.digest ?? "",
            revision: status.revision,
          }),
          opts,
        );
      }),
    );
  extensions
    .command("recover")
    .description(
      "Проверить journals и убрать доказанно owned abandoned staging/unused версии; без import",
    )
    .option("--json", "JSON результат")
    .action(
      run(async (opts: Options) => {
        const recovery = await service.recover();
        write(
          { recovery, codeExecuted: false },
          recovery
            .map(
              (row) =>
                `${row.operationId}: ${row.state}${row.reason ? " · " + row.reason : ""}`,
            )
            .join("\n") || "Незавершённых операций нет.",
          opts,
        );
        if (recovery.some((row) => row.state === "recovery_required"))
          process.exitCode = 1;
      }),
    );
}
