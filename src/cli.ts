#!/usr/bin/env bun
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
import { defaultModelFor, SetupApp, type SetupValues } from "./ui/setup.js";
import {
  createTuiApprovalResolver,
  TuiApp,
  type TuiTranscript,
} from "./ui/tui.js";

const program = new Command();
program
  .name("chisel")
  .description("Безопасный помощник для работы с кодом")
  .version("0.1.4")
  .argument("[prompt]", "задача обычным языком")
  .option("--provider <provider>", "anthropic, openai или openai-compatible")
  .option("--model <model>", "название модели")
  .option("--base-url <url>", "адрес OpenAI-compatible API")
  .option("--yes", "разрешить все изменения без подтверждения")
  .option("--allow <tools>", "разрешить конкретные инструменты через запятую")
  .option("--json", "вывести один JSON-объект")
  .option("--resume <session-id>", "продолжить предыдущую сессию")
  .option("--cwd <path>", "папка проекта", process.cwd())
  .action(async (prompt: string | undefined, raw: Record<string, unknown>) => {
    const options = toOptions(raw);
    if (options.provider && !isProvider(options.provider)) {
      throw new Error(`Неизвестный сервис: ${options.provider}`);
    }
    if (!prompt) {
      if (!process.stdin.isTTY || options.json) {
        throw new Error(
          "Укажите задачу или запустите chisel setup для первичной настройки.",
        );
      }
      await startTui(options);
      return;
    }

    const { exitCode } = await runPrompt(
      prompt,
      options,
      nonInteractiveResolver,
    );
    process.exitCode = exitCode;
  });

program
  .command("setup")
  .description("Настроить ключ API и сервис через понятный мастер")
  .option("--provider <provider>", "anthropic, openai или openai-compatible")
  .action(async (raw: Record<string, unknown>) => {
    const provider = raw.provider as string | undefined;
    if (provider && !isProvider(provider))
      throw new Error(`Неизвестный сервис: ${provider}`);
    await startSetup(provider as ProviderKind | undefined);
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
    if (provider === "openai-compatible")
      process.stdout.write(
        `Адрес API: ${providerConfig?.baseUrl ?? "не настроен"}\n`,
      );
    process.stdout.write(
      ready
        ? "Готово. Запустите chisel в папке проекта и напишите задачу.\n"
        : "Следующий шаг: chisel setup\n",
    );
    process.exitCode = ready ? 0 : 2;
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

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(
    `ChiselCode: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

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
    value === "anthropic" || value === "openai" || value === "openai-compatible"
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
  let transcript: TuiTranscript | undefined;
  let active = false;
  const instance = render(
    React.createElement(TuiApp, {
      approvalResolver: resolver,
      providerLabel: providerLabel(provider),
      model:
        options.model ??
        providerConfig?.defaultModel ??
        config.defaultModel ??
        (defaultModelFor(provider) || "не выбрана"),
      bindTranscript: (nextTranscript: TuiTranscript) => {
        transcript = nextTranscript;
      },
      onSubmit: async (prompt: string) => {
        if (active || !transcript) return;
        active = true;
        transcript.append(`› ${prompt}`);
        let responseOpen = false;
        try {
          const { result } = await runPrompt(prompt, options, resolver, {
            onText: (text) => {
              if (responseOpen) transcript?.appendToLast(text);
              else transcript?.append(text);
              responseOpen = true;
            },
            onToolStart: (name, input) => {
              responseOpen = false;
              transcript?.append(`[chisel] ${name} ${JSON.stringify(input)}`);
            },
            onToolResult: (name, result) => {
              if (result.isError)
                transcript?.append(`[chisel] ${name}: ${result.output}`);
            },
          });
          if (!responseOpen)
            transcript.append(result.text || result.error || result.status);
          if (result.status === "approval_required")
            transcript.append(
              `Нужно подтверждение: ${result.pendingApproval?.preview ?? "(нет preview)"}`,
            );
        } catch (error) {
          transcript.append(
            `Ошибка: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          active = false;
        }
      },
    }),
  );
  await instance.waitUntilExit();
}

async function startSetup(initialProvider?: ProviderKind): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Первичная настройка требует интерактивного терминала. Запустите chisel setup в PowerShell.",
    );
  let completed = false;
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
  return completed;
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
  if (provider === "openai") return "OpenAI";
  return "совместимый API";
}
