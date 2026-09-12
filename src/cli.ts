#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { stdin as nodeStdin, stdout as nodeStdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import {
  hasApiKey,
  nonInteractiveResolver,
  type RunOptions,
  runPrompt,
} from "./commands/run.js";
import { loadGlobalConfig, saveGlobalConfig } from "./config/load.js";
import { CredentialStore } from "./security/credentials.js";
import type { GlobalConfig, ProviderKind } from "./types/domain.js";
import type { TuiSettingsValues } from "./ui/settings.js";
import { defaultModelFor, SetupApp, type SetupValues } from "./ui/setup.js";
import {
  createTuiApprovalResolver,
  TuiApp,
  type TuiTranscript,
} from "./ui/tui.js";
import { resolveProjectDir } from "./utils/paths.js";

const program = new Command();
program
  .name("chisel")
  .description("Безопасный помощник для работы с кодом")
  .version("0.1.12")
  .option(
    "--provider <provider>",
    "anthropic, anthropic-compatible, openai или openai-compatible",
  )
  .option("--model <model>", "название модели")
  .option("--base-url <url>", "адрес OpenAI-compatible API")
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
    if (options.provider && !isProvider(options.provider)) {
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
    "anthropic, anthropic-compatible, openai или openai-compatible",
  )
  .action(async (raw: Record<string, unknown>) => {
    const provider = raw.provider as string | undefined;
    if (provider && !isProvider(provider))
      throw new Error(`Неизвестный сервис: ${provider}`);
    await startSetup(provider as ProviderKind | undefined);
    await pauseBeforeExit();
  });

program
  .command("doctor")
  .description("Проверить настройку, не раскрывая ключи")
  .action(async () => {
    const config = await loadGlobalConfig();
    const provider = config.defaultProvider ?? "anthropic";
    const providerConfig = config.providers[provider];
    const ready = await hasApiKey(provider, providerConfig?.apiKeyRef);
    process.stdout.write("ChiselCode: проверка настройки\n");
    process.stdout.write(`Сервис: ${providerLabel(provider)}\n`);
    process.stdout.write(
      `Модель: ${providerConfig?.defaultModel ?? config.defaultModel ?? "не выбрана"}\n`,
    );
    process.stdout.write(`API-ключ: ${ready ? "сохранён" : "не настроен"}\n`);
    if (provider === "anthropic-compatible" || provider === "openai-compatible")
      process.stdout.write(
        `Адрес API: ${providerConfig?.baseUrl ?? "не настроен"}\n`,
      );
    process.stdout.write(
      ready
        ? "Готово. Запустите chisel в папке проекта и напишите задачу.\n"
        : "Следующий шаг: chisel setup\n",
    );
    process.exitCode = ready ? 0 : 2;
    await pauseBeforeExit();
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
    provider: raw.provider as ProviderKind | undefined,
    model: raw.model as string | undefined,
    baseUrl: raw.baseUrl as string | undefined,
    yes: Boolean(raw.yes),
    allow: raw.allow as string | undefined,
    json: Boolean(raw.json),
    resume: raw.resume as string | undefined,
    cwd: raw.cwd as string | undefined,
  };
}

function isProvider(value: string): value is ProviderKind {
  return (
    value === "anthropic" ||
    value === "anthropic-compatible" ||
    value === "openai" ||
    value === "openai-compatible"
  );
}

async function startTui(options: RunOptions): Promise<void> {
  const config = await loadGlobalConfig();
  const configuredProvider = options.provider ?? config.defaultProvider;
  const provider = configuredProvider ?? "anthropic";
  const providerConfig = config.providers[provider];
  if (!(await hasApiKey(provider, providerConfig?.apiKeyRef))) {
    process.stdout.write(
      "Добро пожаловать в ChiselCode. Сначала настроим доступ к выбранному сервису.\n",
    );
    const configured = await startSetup(configuredProvider);
    if (configured) await startTui(options);
    return;
  }

  const resolver = createTuiApprovalResolver();
  let activeOptions: RunOptions = { ...options };
  let transcript: TuiTranscript | undefined;
  let active = false;
  let restartSetup = false;
  let instance: ReturnType<typeof render> | undefined;
  try {
    instance = render(
      React.createElement(TuiApp, {
        approvalResolver: resolver,
        provider,
        providerLabel: providerLabel(provider),
        model:
          options.model ??
          providerConfig?.defaultModel ??
          config.defaultModel ??
          (defaultModelFor(provider) || "не выбрана"),
        baseUrl: options.baseUrl ?? providerConfig?.baseUrl,
        bindTranscript: (nextTranscript: TuiTranscript) => {
          transcript = nextTranscript;
        },
        onStatus: async () => {
          const current = await loadGlobalConfig();
          const currentProvider =
            activeOptions.provider ?? current.defaultProvider ?? provider;
          const currentConfig = current.providers[currentProvider];
          const ready = await hasApiKey(
            currentProvider,
            currentConfig?.apiKeyRef,
          );
          return [
            "Состояние ChiselCode:",
            `Сервис: ${providerLabel(currentProvider)}`,
            `Модель: ${activeOptions.model ?? currentConfig?.defaultModel ?? current.defaultModel ?? "не выбрана"}`,
            `Проект: ${activeOptions.cwd ?? process.cwd()}`,
            `API-ключ: ${ready ? "настроен" : "не настроен"}`,
            activeOptions.resume
              ? `Сессия: ${activeOptions.resume}`
              : "Сессия: новая для следующего запроса",
          ].join("\n");
        },
        onSwitchProject: async (arg: string) => {
          const base = activeOptions.cwd ?? process.cwd();
          if (!arg.trim())
            return `Проект: ${base}\nЧтобы сменить папку: /cwd <путь>`;
          const resolved = await resolveProjectDir(arg, base);
          activeOptions = {
            ...activeOptions,
            cwd: resolved,
            resume: undefined,
          };
          return `Проект сменён: ${resolved}\nСледующий запрос начнёт новую сессию в этой папке.`;
        },
        onSaveSettings: async (values: TuiSettingsValues) => {
          const current = await loadGlobalConfig();
          const previous = current.providers[values.provider];
          const next: GlobalConfig = {
            ...current,
            defaultProvider: values.provider,
            defaultModel: values.model,
            providers: {
              ...current.providers,
              [values.provider]: {
                provider: values.provider,
                apiKeyRef: previous?.apiKeyRef,
                defaultModel: values.model,
                baseUrl:
                  values.provider === "anthropic-compatible" ||
                  values.provider === "openai-compatible"
                    ? values.baseUrl
                    : undefined,
              },
            },
          };
          await saveGlobalConfig(next);
          activeOptions = {
            ...activeOptions,
            provider: values.provider,
            model: values.model,
            baseUrl: values.baseUrl,
          };
          return (await hasApiKey(values.provider, previous?.apiKeyRef))
            ? "saved"
            : "setup_required";
        },
        onRestartSetup: () => {
          restartSetup = true;
        },
        onSubmit: async (prompt: string) => {
          if (active || !transcript) return;
          active = true;
          transcript.append(`› ${prompt}`, "user");
          let responseOpen = false;
          try {
            const { result } = await runPrompt(
              prompt,
              activeOptions,
              resolver,
              {
                onText: (text) => {
                  if (responseOpen) transcript?.appendToLast(text);
                  else transcript?.append(text);
                  responseOpen = true;
                },
                onToolStart: (name, input) => {
                  responseOpen = false;
                  transcript?.append(
                    `[chisel] ${name} ${JSON.stringify(input)}`,
                    "tool",
                  );
                },
                onToolResult: (name, result) => {
                  if (result.isError)
                    transcript?.append(
                      `[chisel] ${name}: ${result.output}`,
                      "error",
                    );
                },
              },
            );
            if (!responseOpen)
              transcript.append(
                result.text ||
                  result.error ||
                  "Сервис завершил запрос без текстового ответа. Повторите запрос или проверьте адрес API и модель в chisel setup.",
                result.error ? "error" : "assistant",
              );
            if (result.status === "approval_required")
              transcript.append(
                `Нужно подтверждение: ${result.pendingApproval?.preview ?? "(нет preview)"}`,
                "warn",
              );
          } catch (error) {
            transcript.append(
              `Ошибка: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          } finally {
            active = false;
          }
        },
      }),
    );
  } catch {
    // Ink требует raw mode терминала. В урезанных консолях Windows
    // (двойной клик, старый conhost) render() бросает исключение —
    // переключаемся на простой построчный режим, чтобы окно не мигало и не закрывалось.
    process.stdout.write(
      "Интерактивный интерфейс не запустился в этой консоли, включаю простой текстовый режим.\n",
    );
    await startTuiFallback(options);
    return;
  }
  try {
    await instance.waitUntilExit();
  } catch {
    await startTuiFallback(options);
    return;
  }
  if (restartSetup && (await startSetup())) await startTui(options);
}

async function startTuiFallback(options: RunOptions): Promise<void> {
  const config = await loadGlobalConfig();
  const configuredProvider = options.provider ?? config.defaultProvider;
  const provider = configuredProvider ?? "anthropic";
  const providerConfig = config.providers[provider];
  if (!(await hasApiKey(provider, providerConfig?.apiKeyRef))) {
    process.stdout.write(
      "Добро пожаловать в ChiselCode. Сначала настроим доступ к выбранному сервису.\n",
    );
    const configured = await startSetup(configuredProvider);
    if (!configured) return;
  }
  let activeOptions: RunOptions = { ...options };
  const rl = createInterface({ input: nodeStdin, output: nodeStdout });
  try {
    process.stdout.write(
      "Простой режим: введите задачу и нажмите Enter. Команды: /help, /status, /cwd <путь>, /exit.\n",
    );
    for (;;) {
      let line: string;
      try {
        line = (await rl.question("› ")).trim();
      } catch {
        return;
      }
      if (!line) continue;
      if (line === "/exit") return;
      if (line === "/help") {
        process.stdout.write(
          "/help — помощь\n/status — состояние\n/cwd <путь> — сменить папку проекта\n/exit — выход\nОбычный текст — задача для помощника.\n",
        );
        continue;
      }
      if (line === "/cwd" || line.startsWith("/cwd ")) {
        const arg = line.slice("/cwd".length).trim();
        try {
          const base = activeOptions.cwd ?? process.cwd();
          if (!arg) {
            process.stdout.write(`Проект: ${base}\n`);
          } else {
            const resolved = await resolveProjectDir(arg, base);
            activeOptions = {
              ...activeOptions,
              cwd: resolved,
              resume: undefined,
            };
            process.stdout.write(`Проект сменён: ${resolved}\n`);
          }
        } catch (error) {
          process.stdout.write(
            `Ошибка: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
        continue;
      }
      if (line === "/clear") {
        process.stdout.write("\n".repeat(2));
        continue;
      }
      if (line === "/status") {
        const current = await loadGlobalConfig();
        const currentProvider =
          activeOptions.provider ?? current.defaultProvider ?? provider;
        const currentConfig = current.providers[currentProvider];
        const ready = await hasApiKey(
          currentProvider,
          currentConfig?.apiKeyRef,
        );
        process.stdout.write(
          [
            "Состояние ChiselCode:",
            `Сервис: ${providerLabel(currentProvider)}`,
            `Модель: ${activeOptions.model ?? currentConfig?.defaultModel ?? current.defaultModel ?? "не выбрана"}`,
            `Проект: ${activeOptions.cwd ?? process.cwd()}`,
            `API-ключ: ${ready ? "настроен" : "не настроен"}`,
            "",
          ].join("\n"),
        );
        continue;
      }
      if (line === "/settings" || line === "/model") {
        process.stdout.write(
          "В простом режиме настройки меняются через: chisel setup\n",
        );
        continue;
      }
      const resolver = {
        requestApproval: async (request: {
          tool: string;
          preview: string;
        }): Promise<"approved" | "denied" | "unavailable"> => {
          process.stdout.write(
            `Нужно подтверждение для ${request.tool}\n${request.preview}\nРазрешить? [y/N]: `,
          );
          let answer = "";
          try {
            answer = (await rl.question("")).trim().toLowerCase();
          } catch {
            return "unavailable";
          }
          return answer === "y" || answer === "д" ? "approved" : "denied";
        },
      };
      try {
        const { result } = await runPrompt(line, activeOptions, resolver);
        process.stdout.write(
          `${result.text || result.error || "Сервис завершил запрос без текстового ответа."}\n`,
        );
      } catch (error) {
        process.stdout.write(
          `Ошибка: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  } finally {
    rl.close();
  }
}

async function startSetup(initialProvider?: ProviderKind): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Первичная настройка требует интерактивного терминала. Запустите chisel setup в PowerShell.",
    );
  let completed = false;
  try {
    const instance = render(
      React.createElement(SetupApp, {
        initialProvider,
        onComplete: async (values) => {
          await saveSetup(values);
          completed = true;
        },
      }),
    );
    await instance.waitUntilExit();
  } catch {
    return startSetupFallback(initialProvider);
  }
  return completed;
}

async function startSetupFallback(
  initialProvider?: ProviderKind,
): Promise<boolean> {
  const rl = createInterface({ input: nodeStdin, output: nodeStdout });
  try {
    process.stdout.write("ChiselCode — простая настройка (текстовый режим).\n");
    process.stdout.write(
      "Выберите сервис: [1] Anthropic (Claude)  [2] OpenAI  [3] OpenAI-совместимый  [4] Anthropic-совместимый proxy\n",
    );
    let provider = initialProvider;
    if (!provider) {
      const answer = (
        (await rl.question("Сервис [1-4, по умолчанию 1]: ")) || "1"
      ).trim();
      provider =
        answer === "2"
          ? "openai"
          : answer === "3"
            ? "openai-compatible"
            : answer === "4"
              ? "anthropic-compatible"
              : "anthropic";
    }
    const selected = provider as ProviderKind;
    const apiKey = (
      await rl.question("Вставьте API-ключ и нажмите Enter: ")
    ).trim();
    if (!apiKey) {
      process.stdout.write("API-ключ не введён. Настройка отменена.\n");
      return false;
    }
    let baseUrl: string | undefined;
    if (
      selected === "anthropic-compatible" ||
      selected === "openai-compatible"
    ) {
      const raw = (
        await rl.question(
          "Адрес API (OpenAI: с /v1, например http://localhost:11434/v1): ",
        )
      ).trim();
      if (!raw) {
        process.stdout.write("Адрес API не введён. Настройка отменена.\n");
        return false;
      }
      baseUrl = raw;
    }
    const fallbackModel = defaultModelFor(selected) || "";
    const modelInput = (
      await rl.question(
        fallbackModel ? `Модель [по умолчанию ${fallbackModel}]: ` : "Модель: ",
      )
    ).trim();
    const model = modelInput || fallbackModel;
    if (!model) {
      process.stdout.write("Модель не введена. Настройка отменена.\n");
      return false;
    }
    await saveSetup({ provider: selected, apiKey, baseUrl, model });
    return true;
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

async function saveSetup(values: SetupValues): Promise<void> {
  const config = await loadGlobalConfig();
  const credentialName = `${values.provider}-default`;
  await new CredentialStore().set(credentialName, values.apiKey);
  const next: GlobalConfig = {
    ...config,
    defaultProvider: values.provider,
    defaultModel: values.model,
    providers: {
      ...config.providers,
      [values.provider]: {
        provider: values.provider,
        apiKeyRef: credentialName,
        baseUrl: values.baseUrl,
        defaultModel: values.model,
      },
    },
  };
  await saveGlobalConfig(next);
  process.stdout.write("\nГотово! Настройка сохранена.\n");
}

function providerLabel(provider: ProviderKind): string {
  if (provider === "anthropic") return "Anthropic (Claude)";
  if (provider === "anthropic-compatible") return "Anthropic-совместимый API";
  if (provider === "openai") return "OpenAI";
  return "OpenAI-совместимый API";
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
