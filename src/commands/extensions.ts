import { lstat, realpath } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  inspectRecord,
  safeExtensionText,
} from "../extensions/external/loader.js";
import { EXTENSION_MANIFEST } from "../extensions/external/manifest.js";
import {
  extensionsDirectory,
  inspectPackage,
} from "../extensions/external/package.js";
import {
  approvePackage,
  extensionRecords,
  receiptMatches,
} from "../extensions/external/registry.js";
import { inside } from "../extensions/packages/paths.js";
import { PackageManagementService } from "../extensions/packages/service.js";
import { packageAction } from "./extension-package-output.js";
import { registerPackageManagementCommands } from "./extension-packages.js";

export function registerExtensionCommands(program: Command): void {
  const extensions = program
    .command("extensions")
    .description(
      "Локальные пакеты расширений: установка, версии и точное доверие",
    );
  extensions
    .command("path")
    .description("Каталог подготовленных пакетов в ChiselCode Home")
    .action(
      packageAction(program, async () => {
        stdout.write((await extensionsDirectory()) + "\n");
      }),
    );
  extensions
    .command("inspect <path>")
    .description(`Проверить ${EXTENSION_MANIFEST} и bytes без выполнения кода`)
    .option("--json", "JSON результат")
    .action(
      packageAction(
        program,
        async (path: string, options: { json?: boolean }) => {
          const actual = await realpath(path),
            info = await lstat(path);
          if (info.isSymbolicLink())
            throw new Error("Source root не может быть ссылкой/junction.");
          const candidate =
            info.isDirectory() && inside(await extensionsDirectory(), actual)
              ? await inspectPackage(path)
              : await new PackageManagementService().inspectSource(path);
          const prior = (await extensionRecords()).find(
            (record) => record.id === candidate.manifest.id,
          );
          const trusted = !!prior && receiptMatches(prior, candidate);
          const state = candidate.incompatible
            ? "incompatible"
            : prior && !trusted
              ? "modified"
              : trusted
                ? prior.enabled
                  ? "pending_restart"
                  : "disabled"
                : "not_trusted";
          const value = {
            ...candidate,
            location: safeExtensionText(candidate.location),
            state,
            manifest: {
              ...candidate.manifest,
              displayName: safeExtensionText(candidate.manifest.displayName),
              ...(candidate.manifest.description
                ? {
                    description: safeExtensionText(
                      candidate.manifest.description,
                    ),
                  }
                : {}),
            },
            trusted,
            enabled: prior?.enabled ?? false,
          };
          stdout.write(
            options.json || program.opts().json
              ? JSON.stringify(value) + "\n"
              : `${value.manifest.displayName} · ${value.manifest.id} · ${value.manifest.version}\nAPI ${value.manifest.apiVersion} · ${value.incompatible ?? "Совместим"}\nПуть: ${safeExtensionText(value.location)}\nSHA-256: ${value.digest}\nФайлов: ${value.files} · bytes: ${value.bytes}\nКод не выполнялся. Доверие: ${trusted ? "совпадает" : "не подтверждено"}. Состояние: ${state}.\n`,
          );
        },
      ),
    );
  extensions
    .command("status")
    .alias("list")
    .description(
      "User trust/enabled и состояние bytes без import; active проверяется в живом workspace",
    )
    .option("--json", "JSON результат")
    .action(
      packageAction(program, async (options: { json?: boolean }) => {
        const packages = await new PackageManagementService().list();
        const diagnostics = await Promise.all(
          (await extensionRecords()).map(
            async (record) => (await inspectRecord(record)).diagnostic,
          ),
        );
        stdout.write(
          options.json || program.opts().json
            ? JSON.stringify({
                extensions: diagnostics,
                runtime: "not_inspected",
                packages,
              }) + "\n"
            : packages.length
              ? packages
                  .map(
                    (item) =>
                      `${item.name} · ${item.id} · ${item.selected?.version ?? "?"} · ${item.state}\nВыбор: ${item.enabled ? "включён" : "выключен"} · доверие ${item.trusted ? "подтверждено" : "не подтверждено"}\n${item.selected?.location ?? ""} · SHA-256 ${item.selected?.digest ?? "?"}\n${item.uses.length ? "Используемые версии: " + item.uses.map((use) => `${use.digest.slice(0, 12)} ${use.phase}/${use.confidence}`).join(", ") + ". Физическое удаление отложено до подтверждённого выхода." : "Живой workspace этим status не проверяется."}${item.reason ? "\n" + item.reason : ""}`,
                  )
                  .join("\n\n") + "\n"
              : "Внешних пакетов в user реестре нет.\n",
        );
      }),
    );
  extensions
    .command("approve <path>")
    .description(
      "Доверить точному inspected id/digest; изменение применяется после перезапуска",
    )
    .requiredOption("--id <id>", "id из inspect")
    .requiredOption("--digest <sha256>", "точный SHA-256 из inspect")
    .option("--enable", "включить после перезапуска")
    .option("--disabled", "сохранить доверие, оставив выключенным")
    .option(
      "--ack-process-access",
      "подтверждаю выполнение JS с доступом процесса (обязательно без TTY)",
    )
    .option("--json", "JSON результат")
    .action(
      packageAction(
        program,
        async (
          path: string,
          options: {
            id: string;
            digest: string;
            enable?: boolean;
            disabled?: boolean;
            ackProcessAccess?: boolean;
            json?: boolean;
          },
        ) => {
          if (!!options.enable === !!options.disabled)
            throw new Error(
              "Укажите один явный выбор: --enable или --disabled.",
            );
          const candidate = await inspectPackage(path);
          if (
            candidate.manifest.id !== options.id ||
            candidate.digest !== options.digest ||
            candidate.incompatible
          )
            throw new Error(
              "Inspect candidate изменился или несовместим; подтвердите новое содержимое отдельно.",
            );
          const explanation = `${safeExtensionText(candidate.manifest.displayName)} · ${candidate.manifest.id} · ${candidate.manifest.version}\n${safeExtensionText(candidate.location)}\nSHA-256 ${candidate.digest}\nДоверенный JS выполняется с доступом процесса к файлам, сети и запуску программ. Это не OS sandbox; SHA-256 определяет bytes, а не честность автора.\n`;
          process.stderr.write(explanation);
          if (!options.ackProcessAccess) {
            if (!stdin.isTTY || !stdout.isTTY)
              throw new Error(
                "Без TTY необходимо --ack-process-access вместе с точным --id/--digest.",
              );
            const input = createInterface({ input: stdin, output: stdout });
            try {
              if (
                (
                  await input.question(
                    "Подтвердить именно этот пакет? Введите «да»: ",
                  )
                )
                  .trim()
                  .toLowerCase() !== "да"
              )
                throw new Error("Доверие не выдано.");
            } finally {
              input.close();
            }
          }
          const record = await approvePackage(
            candidate.location,
            options.id,
            options.digest,
            !!options.enable,
          );
          stdout.write(
            options.json || program.opts().json
              ? JSON.stringify({
                  outcome: "committed",
                  id: record.id,
                  digest: record.digest,
                  enabled: record.enabled,
                  trusted: true,
                  location: safeExtensionText(record.location),
                  restartRequired: true,
                }) + "\n"
              : `Доверие сохранено; пакет ${options.enable ? "включён" : "выключен"}. Перезапустите ChiselCode.\n`,
          );
        },
      ),
    );
  registerPackageManagementCommands(extensions, program);
}
