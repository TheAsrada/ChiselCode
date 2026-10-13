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

export function registerExtensionCommands(program: Command): void {
  const extensions = program
    .command("extensions")
    .description(
      "Подготовленные внешние пакеты: проверка и точное доверие к содержимому",
    );
  extensions
    .command("path")
    .description("Каталог подготовленных пакетов в ChiselCode Home")
    .action(async () => {
      stdout.write((await extensionsDirectory()) + "\n");
    });
  extensions
    .command("inspect <path>")
    .description(`Проверить ${EXTENSION_MANIFEST} и bytes без выполнения кода`)
    .option("--json", "JSON результат")
    .action(async (path: string, options: { json?: boolean }) => {
      const candidate = await inspectPackage(path);
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
            ? { description: safeExtensionText(candidate.manifest.description) }
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
    });
  extensions
    .command("status")
    .alias("list")
    .description(
      "User trust/enabled и состояние bytes без import; active проверяется в живом workspace",
    )
    .option("--json", "JSON результат")
    .action(async (options: { json?: boolean }) => {
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
            }) + "\n"
          : diagnostics.length
            ? diagnostics
                .map(
                  (item) =>
                    `${item.name ?? item.id} · ${item.id} · ${item.version ?? "?"} · ${item.state}\n${item.reason ?? ""}\n${item.location ?? ""} · SHA-256 ${item.digest ?? "?"}`,
                )
                .join("\n\n") + "\n"
            : "Внешних пакетов в user реестре нет.\n",
      );
    });
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
    .action(
      async (
        path: string,
        options: {
          id: string;
          digest: string;
          enable?: boolean;
          disabled?: boolean;
          ackProcessAccess?: boolean;
        },
      ) => {
        if (!!options.enable === !!options.disabled)
          throw new Error("Укажите один явный выбор: --enable или --disabled.");
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
        await approvePackage(
          candidate.location,
          options.id,
          options.digest,
          !!options.enable,
        );
        stdout.write(
          `Доверие сохранено; пакет ${options.enable ? "включён" : "выключен"}. Перезапустите ChiselCode.\n`,
        );
      },
    );
}
