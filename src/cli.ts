#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { stdin as nodeStdin, stdout as nodeStdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import {
  hasApiKey,
  nonInteractiveResolver,
  type RunOptions,
  runPrompt,
} from "./commands/run.js";
import {
  checkForUpdates,
  installerAssetHint,
  RELEASES_PAGE_URL,
} from "./commands/update.js";
import { loadGlobalConfig } from "./config/load.js";
import { ensureChiselHomeLayout, providersRootDir } from "./paths/home.js";
import { getProviderCatalog } from "./providers/catalog.js";
import { formatProviderDiagnostic } from "./providers/custom/diagnostics.js";
import { resolveEndpoint } from "./providers/endpoint.js";
import { selectProfile } from "./providers/profiles.js";
import { CredentialStore } from "./security/credentials.js";
import { projectSessionStore } from "./sessions/project-store.js";
import {
  describeTerminalSize,
  formatTerminalSizeLine,
} from "./ui/terminal-size.js";
import { paint, supportsColor } from "./ui/theme.js";
import { VERSION } from "./version.js";

const program = new Command();
program
  .name("chisel")
  .description("Безопасный помощник для работы с кодом")
  .version(VERSION)
  .option(
    "--provider <provider>",
    "provider ID из chisel providers list (compatibility selection)",
  )
  .option("--profile <profile-id>", "профиль провайдера")
  .option("--model <model>", "название модели")
  .option("--base-url <url>", "base URL выбранного API")
  .option("--yes", "разрешить все изменения без подтверждения")
  .option("--allow <tools>", "разрешить конкретные инструменты через запятую")
  .option("--json", "вывести один JSON-объект")
  .option("--resume <session-id>", "продолжить предыдущую сессию")
  .option("--cwd <path>", "папка проекта", process.cwd())
  .option("--pause", "ждать Enter перед выходом (для запуска двойным кликом)")
  .option("--no-pause", "никогда не ждать Enter перед выходом")
  .argument("[prompt...]", "задача для одноразового выполнения")
  .action(async (promptParts: string[], raw: Record<string, unknown>) => {
    const options = toOptions(raw);
    const prompt =
      (Array.isArray(promptParts) ? promptParts.join(" ") : "").trim() ||
      undefined;
    if (
      options.provider &&
      !(await getProviderCatalog()).registry.has(options.provider)
    ) {
      throw new Error(`Неизвестный сервис: ${options.provider}`);
    }
    if (!prompt) {
      if (options.json) {
        throw new Error(
          "Укажите задачу или запустите chisel setup для первичной настройки.",
        );
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stdout.write(
          "ChiselCode запускается в интерактивном режиме.\n" +
            "Похоже, терминал недоступен (двойной клик без консоли или pipe).\n" +
            "Откройте PowerShell в папке проекта и запустите:\n" +
            "  chisel setup\n" +
            '  chisel "ваша задача"\n',
        );
        await pauseBeforeExit(raw);
        process.exitCode = 2;
        return;
      }
      await startTui(options);
      await pauseBeforeExit(raw);
      return;
    }

    const { exitCode } = await runPrompt(
      prompt,
      options,
      nonInteractiveResolver,
    );
    process.exitCode = exitCode;
    await pauseBeforeExit(raw);
  });

program
  .command("setup")
  .description("Настроить ключ API и сервис через понятный мастер")
  .option(
    "--provider <provider>",
    "provider ID из chisel providers list (compatibility selection)",
  )
  .option("--profile <profile-id>", "создать или настроить профиль")
  .action(async (raw: Record<string, unknown>) => {
    const provider =
      (raw.provider as string | undefined) ?? argvFlagValue("--provider");
    if (provider && !(await getProviderCatalog()).registry.has(provider))
      throw new Error(`Неизвестный сервис: ${provider}`);
    const { runOpenTuiAgent } = await import("./ui/opentui-agent.js");
    await runOpenTuiAgent(
      {
        provider,
        profile:
          (raw.profile as string | undefined) ?? argvFlagValue("--profile"),
      },
      undefined,
      true,
      true,
    );
    await pauseBeforeExit();
  });

program
  .command("doctor")
  .description("Проверить настройку, не раскрывая ключи")
  .action(async () => {
    const color = supportsColor(process.stdout);
    process.stdout.write(
      `${paint("◈ ChiselCode", "cyan", color)} ${paint(`v${VERSION}`, "gray", color)} — проверка настройки\n`,
    );
    const config = await loadGlobalConfig();
    const catalog = await getProviderCatalog();
    let selected: ReturnType<typeof selectProfile>;
    try {
      selected = selectProfile(config, {
        profile: argvFlagValue("--profile"),
        provider: argvFlagValue("--provider"),
      });
    } catch (error) {
      process.stdout.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
      return;
    }
    const definition = catalog.registry.get(selected.profile.providerId);
    const keyReady =
      Boolean(definition) &&
      (await hasApiKey(
        selected.profile.providerId,
        selected.profile.apiKeyRef,
      ));
    const providerConfig = selected.profile;
    const model =
      argvFlagValue("--model") ??
      providerConfig.defaultModel ??
      definition?.defaults.model;
    let endpoint: string | undefined;
    let endpointReady = false;
    try {
      if (definition) {
        endpoint = resolveEndpoint(
          definition,
          argvFlagValue("--base-url") ?? providerConfig.baseUrl,
        );
        endpointReady = Boolean(endpoint);
      }
    } catch {}
    const ready = keyReady && endpointReady && Boolean(model);
    const mark = (ok: boolean): string =>
      paint(ok ? "✓" : "✗", ok ? "green" : "red", color);
    process.stdout.write(
      `${mark(Boolean(definition))} Сервис: ${definition?.label ?? selected.profile.providerId} · профиль ${selected.profileId}\n`,
    );
    process.stdout.write(
      `${mark(Boolean(model))} Модель: ${model ?? "не выбрана"}\n`,
    );
    process.stdout.write(
      `${mark(keyReady)} API-ключ: ${definition?.auth.required === false ? "не требуется" : keyReady ? "доступен" : "не настроен"}\n`,
    );
    if (definition)
      process.stdout.write(
        `${mark(endpointReady)} Адрес API: ${endpoint ?? "не настроен или невалидный baseUrl"}\n`,
      );
    for (const d of catalog.diagnostics)
      process.stderr.write(`${formatProviderDiagnostic(d)}\n`);
    process.stdout.write(
      `${mark(true)} ${formatTerminalSizeLine(describeTerminalSize())}\n`,
    );
    process.stdout.write(
      ready
        ? "Готово. Запустите chisel в папке проекта и напишите задачу.\n"
        : "Следующий шаг: chisel setup\n",
    );
    process.exitCode = ready ? 0 : 2;
    await pauseBeforeExit();
  });

program
  .command("update")
  .description("Проверить обновление ChiselCode на GitHub Releases")
  .option("--json", "вывести результат проверки одним JSON-объектом")
  .action(async (raw: Record<string, unknown>) => {
    // Commander возвращает сабкоманде {}, если флаг совпадает с корневым
    // (update --json, setup --provider), — смотрим напрямую в argv.
    const json = Boolean(raw.json) || process.argv.includes("--json");
    const color = supportsColor(process.stdout) && !json;
    const result = await checkForUpdates(VERSION);
    if (json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.error ? 1 : 0;
      return;
    }
    if (result.error) {
      process.stdout.write(
        `${paint("⚠", "yellow", color)} Не удалось проверить обновление: ${result.error}\n`,
      );
      process.stdout.write(`Релизы вручную: ${RELEASES_PAGE_URL}\n`);
      process.exitCode = 1;
      return;
    }
    if (result.updateAvailable) {
      process.stdout.write(
        `${paint("◈ ChiselCode", "cyan", color)}: доступна новая версия ${paint(`v${result.latest}`, "green", color)} (у вас v${result.current})\n`,
      );
      process.stdout.write(
        `Скачайте ${installerAssetHint(result.latest ?? result.current)} со страницы:\n  ${result.latestUrl}\n`,
      );
    } else {
      process.stdout.write(
        `${paint(`✓ У вас последняя версия ChiselCode v${result.current}`, "green", color)}\n`,
      );
    }
  });

const providersCommand = program
  .command("providers")
  .description("Каталог встроенных и пользовательских провайдеров");
providersCommand
  .command("path")
  .description("Путь Home/providers")
  .action(async () => {
    await ensureChiselHomeLayout();
    process.stdout.write(`${resolve(providersRootDir())}\n`);
  });
providersCommand
  .command("list")
  .description("Показать definitions и drivers")
  .action(async () => {
    const catalog = await getProviderCatalog();
    process.stdout.write("ID\tSource\tDriver\tStatus\n");
    for (const d of catalog.registry.list())
      process.stdout.write(
        `${d.id}\t${catalog.registry.source(d.id)?.type === "builtin" ? "builtin" : "custom"}\t${d.driverId}\tready\n`,
      );
    for (const d of catalog.diagnostics)
      process.stderr.write(`${formatProviderDiagnostic(d)}\n`);
  });
providersCommand
  .command("validate")
  .description("Проверить manifests без API requests")
  .action(async () => {
    const catalog = await getProviderCatalog();
    for (const d of catalog.diagnostics)
      process.stderr.write(`${formatProviderDiagnostic(d)}\n`);
    const errors = catalog.diagnostics.filter((d) => d.severity === "error");
    process.stdout.write(
      errors.length
        ? `Provider validation failed: ${errors.length} errors.\n`
        : "Provider manifests valid.\n",
    );
    process.exitCode = errors.length ? 1 : 0;
  });

const auth = program
  .command("auth")
  .description("Управление сохранёнными ключами API");
auth
  .command("set")
  .argument("<name>", "имя ключа, например anthropic-default")
  .argument("<secret>", "API-ключ")
  .description("Сохранить API-ключ в зашифрованном локальном хранилище")
  .action(async (name: string, secret: string) => {
    await new CredentialStore().set(name, secret);
    process.stdout.write(`Ключ ${name} сохранён.\n`);
  });
auth
  .command("get")
  .argument("<name>", "имя ключа")
  .description("Проверить наличие ключа, не показывая его")
  .action(async (name: string) => {
    const value = await new CredentialStore().get(name);
    process.stdout.write(
      value ? `Ключ ${name} доступен.\n` : `Ключ ${name} не найден.\n`,
    );
    process.exitCode = value ? 0 : 1;
  });

try {
  await program.parseAsync();
} catch (error: unknown) {
  process.stderr.write(
    `ChiselCode: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  if (isTooManyArgumentsError(error)) {
    process.stderr.write(
      'Подсказка: передавайте задачу в кавычках: chisel "ваша задача".\n',
    );
  }
  if (process.platform === "win32" && nodeStdout.isTTY) {
    process.stdout.write(
      "Запускайте из PowerShell в папке проекта: chisel setup, затем chisel.\n",
    );
  }
  process.exitCode = 1;
  await pauseOnFatalError();
}

function toOptions(raw: Record<string, unknown>): RunOptions {
  return {
    provider: raw.provider as string | undefined,
    profile: raw.profile as string | undefined,
    model: raw.model as string | undefined,
    baseUrl: raw.baseUrl as string | undefined,
    yes: Boolean(raw.yes),
    allow: raw.allow as string | undefined,
    json: Boolean(raw.json),
    resume: raw.resume as string | undefined,
    cwd: raw.cwd as string | undefined,
  };
}

/**
 * Значение флага напрямую из argv. Нужно сабкомандам, чьи флаги совпадают
 * с корневыми (setup --provider, update --json): commander в этом случае
 * отдаёт обработчику сабкоманды пустой объект опций.
 */
function argvFlagValue(flag: string): string | undefined {
  const equal = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (equal) return equal.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

async function startTui(options: RunOptions): Promise<void> {
  const config = await loadGlobalConfig();
  const initialSession = options.resume
    ? await (async () => {
        const store = await projectSessionStore(options.cwd ?? process.cwd());
        return store.load((await store.resolve(options.resume ?? "")).id);
      })()
    : undefined;
  let keyReady = false;
  try {
    const selected = selectProfile(
      config,
      options.profile || options.provider
        ? options
        : initialSession
          ? {
              profile:
                initialSession.profileId ??
                `${initialSession.providerId.replaceAll("/", "-")}-default`,
            }
          : {},
    );
    keyReady = await hasApiKey(
      selected.profile.providerId,
      selected.profile.apiKeyRef,
    );
  } catch (error) {
    if (
      !initialSession &&
      (options.profile || options.provider || config.defaultProfileId)
    )
      throw error;
  }
  const { runOpenTuiAgent } = await import("./ui/opentui-agent.js");
  await runOpenTuiAgent(options, initialSession, !keyReady && !initialSession);
}

function isTooManyArgumentsError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === "commander.excessArguments") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("too many arguments");
}

function parsePauseFlags(): Record<string, unknown> {
  const argv = process.argv.slice(2);
  return {
    pause: argv.includes("--pause")
      ? true
      : argv.includes("--no-pause")
        ? false
        : undefined,
    json: argv.includes("--json"),
  };
}

/**
 * Держит окно открытым, если exe запустили двойным кликом в Проводнике.
 * В обычном терминале (PowerShell/cmd/WT) и в скриптах (--json, pipe,
 * --no-pause) завершается сразу без паузы.
 */
async function pauseBeforeExit(raw?: Record<string, unknown>): Promise<void> {
  const flags = raw ?? parsePauseFlags();
  if (flags.json) return;
  if (flags.pause === false) return;
  if (process.platform !== "win32") return;
  if (flags.pause === true) {
    await waitForEnter();
    return;
  }
  if (!nodeStdin.isTTY || !nodeStdout.isTTY) return;
  if (await wasLaunchedFromExplorer()) await waitForEnter();
}

/** На фатальной ошибке окно держим всегда, когда есть видимая консоль. */
async function pauseOnFatalError(): Promise<void> {
  const flags = parsePauseFlags();
  if (flags.json) return;
  if (flags.pause === false) return;
  if (process.platform !== "win32") return;
  if (!nodeStdout.isTTY) return;
  if (
    flags.pause === true ||
    nodeStdin.isTTY ||
    (await wasLaunchedFromExplorer())
  ) {
    await waitForEnter();
  }
}

async function wasLaunchedFromExplorer(): Promise<boolean> {
  try {
    if (process.platform !== "win32") return false;
    const ppid = process.ppid;
    if (!ppid) return false;
    const output = execFileSync(
      "tasklist",
      ["/FI", `PID eq ${ppid}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const firstLine =
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)[0] ?? "";
    const parentName = (firstLine.split(",")[0] ?? "")
      .replace(/"/g, "")
      .trim()
      .toLowerCase();
    return parentName.includes("explorer");
  } catch {
    return false;
  }
}

async function waitForEnter(): Promise<void> {
  try {
    nodeStdout.write("\nНажмите Enter, чтобы закрыть окно...");
    const rl = createInterface({ input: nodeStdin, output: nodeStdout });
    await rl.question("");
    rl.close();
  } catch {
    // Игнорируем: окно закроется как обычно.
  }
}
