#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { stdin as nodeStdin, stdout as nodeStdout } from "node:process";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline/promises";
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import {
  checkProviderConnection,
  hasApiKey,
  listProviderModels,
  nonInteractiveResolver,
  type RunOptions,
  runPrompt,
} from "./commands/run.js";
import {
  checkAssetAvailable,
  checkForUpdates,
  downloadReleaseAsset,
  installerAssetHint,
  launchWindowsInstaller,
  NSIS_SILENT_ARGS,
  planSelfUpdate,
  RELEASES_PAGE_URL,
} from "./commands/update.js";
import { loadGlobalConfig, saveGlobalConfig } from "./config/load.js";
import { AGENTROUTER_BASE_URL } from "./providers/agentrouter.js";
import { normalizeBaseUrlForProvider } from "./providers/base-url.js";
import { CredentialStore } from "./security/credentials.js";
import { projectSessionStore } from "./sessions/project-store.js";
import {
  formatSessionList,
  listSessions,
  loadSession,
  resolveSessionRef,
  shortSessionId,
} from "./sessions/store.js";
import { expandSkill, invocableSkills, loadSkills } from "./skills/skills.js";
import type { GlobalConfig, ProviderKind, Session } from "./types/domain.js";
import { SGR_DISABLE, SGR_ENABLE, shouldEnableMouse } from "./ui/mouse.js";
import type { TuiSettingsValues } from "./ui/settings.js";
import { defaultModelFor, SetupApp, type SetupValues } from "./ui/setup.js";
import { createTerminalCursorGuard } from "./ui/terminal-cursor.js";
import {
  formatDoneSummary,
  formatStatusDashboard,
  paint,
  supportsColor,
} from "./ui/theme.js";
import {
  replaySessionIntoTranscript,
  toolTranscriptHandlers,
} from "./ui/tool-transcript.js";
import {
  createTuiApprovalResolver,
  describeTerminalSize,
  formatTerminalSizeLine,
  shouldUseAltScreen,
  syncTerminalSizeToStdout,
  TuiApp,
  type TuiTranscript,
} from "./ui/tui.js";
import { resolveProjectDir } from "./utils/paths.js";
import { VERSION } from "./version.js";

const program = new Command();
program
  .name("chisel")
  .description("Безопасный помощник для работы с кодом")
  .version(VERSION)
  .option(
    "--provider <provider>",
    "anthropic, anthropic-compatible, openai, openai-compatible или agentrouter",
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
    "anthropic, anthropic-compatible, openai, openai-compatible или agentrouter",
  )
  .action(async (raw: Record<string, unknown>) => {
    const provider =
      (raw.provider as string | undefined) ?? argvFlagValue("--provider");
    if (provider && !isProvider(provider))
      throw new Error(`Неизвестный сервис: ${provider}`);
    await startSetup(provider as ProviderKind | undefined);
    await pauseBeforeExit();
  });

program
  .command("doctor")
  .description("Проверить настройку, не раскрывая ключи")
  .action(async () => {
    const color = supportsColor(process.stdout);
    const config = await loadGlobalConfig();
    const provider = config.defaultProvider ?? "anthropic";
    const providerConfig = config.providers[provider];
    const ready = await hasApiKey(provider, providerConfig?.apiKeyRef);
    const mark = (ok: boolean): string =>
      paint(ok ? "✓" : "✗", ok ? "green" : "red", color);
    process.stdout.write(
      `${paint("◈ ChiselCode", "cyan", color)} ${paint(`v${VERSION}`, "gray", color)} — проверка настройки\n`,
    );
    process.stdout.write(`${mark(true)} Сервис: ${providerLabel(provider)}\n`);
    process.stdout.write(
      `${mark(true)} Модель: ${providerConfig?.defaultModel ?? config.defaultModel ?? "не выбрана"}\n`,
    );
    process.stdout.write(
      `${mark(ready)} API-ключ: ${ready ? "сохранён" : "не настроен"}\n`,
    );
    if (
      provider === "anthropic-compatible" ||
      provider === "openai-compatible" ||
      provider === "agentrouter"
    )
      process.stdout.write(
        `${mark(Boolean(providerConfig?.baseUrl))} Адрес API: ${providerConfig?.baseUrl ?? "не настроен"}\n`,
      );
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
    value === "openai-compatible" ||
    value === "agentrouter"
  );
}

/**
 * Значение флага напрямую из argv. Нужно сабкомандам, чьи флаги совпадают
 * с корневыми (setup --provider, update --json): commander в этом случае
 * отдаёт обработчику сабкоманды пустой объект опций.
 */
function argvFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

async function doctorText(): Promise<string> {
  const config = await loadGlobalConfig();
  const provider = config.defaultProvider ?? "anthropic";
  const providerConfig = config.providers[provider];
  const ready = await hasApiKey(provider, providerConfig?.apiKeyRef);
  return formatStatusDashboard({
    providerLabel: providerLabel(provider),
    model: providerConfig?.defaultModel ?? config.defaultModel ?? "не выбрана",
    cwd: process.cwd(),
    keyReady: ready,
  });
}

/**
 * `/update` в простом текстовом режиме: полный флоу, как в TUI —
 * проверка → подтверждение → скачивание → тихая установка и выход.
 * Возвращает true, если установщик запущен и пора закрываться.
 */
async function runUpdateFallback(rl: ReadlineInterface): Promise<boolean> {
  const write = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };
  const check = await checkForUpdates(VERSION);
  if (check.error) {
    write(
      `⚠ Не удалось проверить обновление: ${check.error}\nРелизы вручную: ${RELEASES_PAGE_URL}`,
    );
    return false;
  }
  if (!check.updateAvailable) {
    write(`✓ У вас последняя версия ChiselCode v${check.current}`);
    return false;
  }
  const plan = planSelfUpdate(check, VERSION);
  const version = plan.latest ?? plan.current;
  if (!plan.installedBinary) {
    write(
      [
        `◈ ChiselCode: доступна новая версия v${version} (у вас v${plan.current})`,
        "Запущено из исходников, поэтому ставлю вручную: скачайте установщик со страницы релиза",
        `${plan.latestUrl ?? RELEASES_PAGE_URL}`,
        "или обновите код: git pull",
      ].join("\n"),
    );
    return false;
  }
  process.stdout.write(
    `Установить ChiselCode v${version}? Сейчас v${plan.current}. Файл: ${plan.asset}\nНичего кликать не придётся: установщик всё сделает тихо сам и перезапустит приложение.\nРазрешить? [y/N]: `,
  );
  let answer = "";
  try {
    answer = (await rl.question("")).trim().toLowerCase();
  } catch {
    return false;
  }
  if (answer !== "y" && answer !== "н") {
    write("Обновление отменено.");
    return false;
  }
  let assetReady = true;
  try {
    assetReady = await checkAssetAvailable(plan.url);
  } catch {
    assetReady = true;
  }
  if (!assetReady) {
    write(
      `⚠ Файл ${plan.asset} пока не опубликован в релизе v${version} — установщики собираются несколько минут после выхода версии.\nПопробуйте чуть позже или скачайте вручную: ${plan.latestUrl ?? RELEASES_PAGE_URL}`,
    );
    return false;
  }
  write(`Скачиваю ${plan.asset}…`);
  let downloaded: { path: string; bytes: number };
  try {
    downloaded = await downloadReleaseAsset(plan.url, plan.asset);
  } catch (error) {
    write(
      `Ошибка обновления: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  write(`Скачано ${(downloaded.bytes / 1024 / 1024).toFixed(1)} МБ.`);
  if (!plan.autoInstall) {
    write(
      `Автоматическая установка на этой платформе требует прав. Завершите вручную:\n${plan.manualCommand ?? plan.url}`,
    );
    return false;
  }
  write("Устанавливаю тихо и перезапускаюсь…");
  try {
    await launchWindowsInstaller(downloaded.path, [...NSIS_SILENT_ARGS]);
  } catch (error) {
    write(
      `Ошибка обновления: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  return true;
}

/** Сводка сессии для /status: не падает, если файл пропал. */
async function readSessionSummary(
  id: string,
  projectPath = process.cwd(),
): Promise<{ id: string; title?: string; totalTokens: number } | undefined> {
  try {
    const session = await loadSession(id, projectPath);
    return {
      id: session.id,
      title: session.title?.trim() || undefined,
      totalTokens:
        session.totalTokens.inputTokens + session.totalTokens.outputTokens,
    };
  } catch {
    return undefined;
  }
}

async function startTui(options: RunOptions): Promise<void> {
  const config = await loadGlobalConfig();
  const initialSession = options.resume
    ? await (async () => {
        const store = await projectSessionStore(options.cwd ?? process.cwd());
        return store.load((await store.resolve(options.resume ?? "")).id);
      })()
    : undefined;
  const configuredProvider =
    options.provider ?? initialSession?.provider ?? config.defaultProvider;
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
  let activeOptions: RunOptions = { ...options, resume: initialSession?.id };
  let transcript: TuiTranscript | undefined;
  let active = false;
  let cachedSessionList: Session[] = [];
  let instance: ReturnType<typeof render> | undefined;
  // Первый кадр должен сразу знать полноэкранный размер: проталкиваем живой
  // сисколл getWindowSize() в stdout.columns/rows до создания Yoga-корня Ink.
  // Иначе Ink стартует с кэшированных 80x24 — ввод узкий посреди экрана,
  // а выравнивание приходит только после ввода текста.
  syncTerminalSizeToStdout();
  // Fullscreen is the default on every platform, including launches from a
  // Windows shortcut without WT_SESSION. The input stays below a bounded feed;
  // native terminal scrollback cannot move the footer or scroll into empty rows.
  // Explicit opt-out: CHISEL_ALT_SCREEN=0 / CHISEL_NO_ALT_SCREEN=1.
  const useAltScreen = shouldUseAltScreen(process.env);
  const terminalCursor = await createTerminalCursorGuard(useAltScreen);
  // SGR-захват мыши живёт шире render-блока: гасим его в finally
  // у waitUntilExit (иначе шелл после нас получал бы SGR-мусор).
  let mouseOn = false;
  try {
    instance = render(
      React.createElement(TuiApp, {
        initialSession,
        approvalResolver: resolver,
        provider,
        providerLabel: providerLabel(provider),
        model:
          options.model ??
          initialSession?.model ??
          providerConfig?.defaultModel ??
          config.defaultModel ??
          (defaultModelFor(provider) || "не выбрана"),
        baseUrl: options.baseUrl ?? providerConfig?.baseUrl,
        version: VERSION,
        cwd: activeOptions.cwd ?? process.cwd(),
        classic: !useAltScreen,
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
          const resumed = activeOptions.resume
            ? await readSessionSummary(
                activeOptions.resume,
                activeOptions.cwd ?? process.cwd(),
              )
            : undefined;
          return formatStatusDashboard({
            providerLabel: providerLabel(currentProvider),
            model:
              activeOptions.model ??
              currentConfig?.defaultModel ??
              current.defaultModel ??
              "не выбрана",
            cwd: activeOptions.cwd ?? process.cwd(),
            keyReady: ready,
            sessionId: resumed ? shortSessionId(resumed.id) : undefined,
            sessionTitle: resumed?.title,
            totalTokens: resumed?.totalTokens,
          });
        },
        onDoctor: async () => doctorText(),
        onPlanUpdate: async () =>
          planSelfUpdate(await checkForUpdates(VERSION), VERSION),
        onDownloadUpdate: async (plan) =>
          downloadReleaseAsset(plan.url, plan.asset),
        onCheckAssetUpdate: async (plan) => checkAssetAvailable(plan.url),
        onLaunchInstaller: async (path, silent) => {
          launchWindowsInstaller(path, silent ? [...NSIS_SILENT_ARGS] : []);
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
          return `✓ Проект сменён: ${resolved}\nСледующий запрос начнёт новую сессию в этой папке.`;
        },
        onSaveSettings: async (values: TuiSettingsValues) => {
          const current = await loadGlobalConfig();
          const previous = current.providers[values.provider];
          // Новый ключ из /settings сохраняем в хранилище (в конфиг пишется
          // только ссылка). Без нового ключа остаётся прежняя ссылка.
          const typedKey = values.apiKey?.trim() || undefined;
          const keyRef =
            typedKey != null
              ? (previous?.apiKeyRef ?? `${values.provider}-default`)
              : previous?.apiKeyRef;
          if (typedKey != null && keyRef != null)
            await new CredentialStore().set(keyRef, typedKey);
          const next: GlobalConfig = {
            ...current,
            defaultProvider: values.provider,
            defaultModel: values.model,
            providers: {
              ...current.providers,
              [values.provider]: {
                provider: values.provider,
                apiKeyRef: keyRef,
                defaultModel: values.model,
                baseUrl:
                  values.provider === "anthropic-compatible" ||
                  values.provider === "openai-compatible" ||
                  values.provider === "agentrouter"
                    ? normalizeBaseUrlForProvider(
                        values.provider,
                        values.baseUrl,
                      )
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
          return (await hasApiKey(values.provider, keyRef))
            ? "saved"
            : "setup_required";
        },
        onKeyStatus: async (provider) => {
          const current = await loadGlobalConfig();
          return hasApiKey(provider, current.providers[provider]?.apiKeyRef);
        },
        onCompleteSetup: async (values: SetupValues) => {
          await persistSetup(values);
          activeOptions = {
            ...activeOptions,
            provider: values.provider,
            model: values.model,
            baseUrl: values.baseUrl,
          };
        },
        onCheckConnection: async (values: TuiSettingsValues) => {
          const result = await checkProviderConnection({
            provider: values.provider,
            apiKey: values.apiKey?.trim() || undefined,
            baseUrl: normalizeBaseUrlForProvider(
              values.provider,
              values.baseUrl,
            ),
            model: values.model,
          });
          return result.ok ? `✓ ${result.message}` : `✗ ${result.message}`;
        },
        onListModels: async (values: TuiSettingsValues) => {
          const result = await listProviderModels({
            provider: values.provider,
            apiKey: values.apiKey?.trim() || undefined,
            baseUrl: normalizeBaseUrlForProvider(
              values.provider,
              values.baseUrl,
            ),
            model: values.model,
          });
          if (!result.ok) return { ok: false as const, error: result.error };
          return {
            ok: true as const,
            models: result.models.map((model) => ({
              id: model.id,
              hint:
                model.displayName && model.displayName !== model.id
                  ? model.displayName
                  : undefined,
            })),
          };
        },
        onNewSession: async () => {
          if (activeOptions.resume) {
            const store = await projectSessionStore(
              activeOptions.cwd ?? process.cwd(),
            );
            const current = await store.load(activeOptions.resume);
            if (activeOptions.model) current.model = activeOptions.model;
            await store.save(current);
          }
          activeOptions = { ...activeOptions, resume: undefined };
          return "Начат новый сеанс: следующее сообщение откроет новую сессию.";
        },
        onListSessions: async () => {
          cachedSessionList = await listSessions(
            activeOptions.cwd ?? process.cwd(),
          );
          return formatSessionList(cachedSessionList);
        },
        activeSessionId: () => activeOptions.resume,
        onSessionSummaries: async () =>
          (
            await projectSessionStore(activeOptions.cwd ?? process.cwd())
          ).list(),
        onPreviewSession: async (id: string) =>
          (await projectSessionStore(activeOptions.cwd ?? process.cwd())).load(
            id,
          ),
        onRenameSession: async (id: string, title: string) =>
          (
            await projectSessionStore(activeOptions.cwd ?? process.cwd())
          ).rename(id, title),
        onDeleteSession: async (id: string) => {
          await (
            await projectSessionStore(activeOptions.cwd ?? process.cwd())
          ).delete(id);
          if (activeOptions.resume === id) {
            activeOptions = { ...activeOptions, resume: undefined };
            transcript?.clear();
          }
        },
        onResumeSession: async (ref: string) => {
          const trimmed = ref.trim();
          const store = await projectSessionStore(
            activeOptions.cwd ?? process.cwd(),
          );
          const found = await store.load((await store.resolve(trimmed)).id);
          activeOptions = { ...activeOptions, resume: found.id };
          transcript?.clear();
          if (transcript) replaySessionIntoTranscript(transcript, found);
          const title = found.title?.trim() || "без названия";
          return (
            `✓ Возобновлён сеанс «${title}» (${found.model}, ` +
            `${found.messages.length} сообщ., контекст восстановлен).`
          );
        },
        onSubmit: async (prompt: string, display?: string) => {
          if (active || !transcript) return;
          active = true;
          transcript.append(`❯ ${display ?? prompt}`, "user");
          // Весь текстовый стрим идёт в одну незавершённую строку через
          // appendToLast: первый чанк тоже, иначе он фиксировался отдельной
          // записью (одиночные "I"/"The" на скрине) и рвал ответ на куски.
          // Вызов инструмента сам коммитит накопленный стриминг через append,
          // следующий текст естественно начинает новую строку.
          let hasAnyText = false;
          const started = Date.now();
          try {
            const { result } = await runPrompt(
              prompt,
              activeOptions,
              resolver,
              {
                onText: (text) => {
                  if (!text) return;
                  transcript?.appendToLast(text);
                  hasAnyText = true;
                },
                ...toolTranscriptHandlers(() => transcript),
              },
            );
            // Сессия живёт между сообщениями: следующее продолжит эту же.
            activeOptions = { ...activeOptions, resume: result.session.id };
            if (!hasAnyText)
              transcript.append(
                result.text ||
                  result.error ||
                  "Сервис завершил запрос без текстового ответа. Повторите запрос или проверьте адрес API и модель в chisel setup.",
                result.error ? "error" : "assistant",
              );
            if (result.status === "approval_required")
              transcript.append(
                `⚠ Нужно подтверждение: ${result.pendingApproval?.preview ?? "(нет preview)"}`,
                "warn",
              );
            if (result.status === "completed") {
              const tokens =
                result.session.totalTokens.inputTokens +
                result.session.totalTokens.outputTokens;
              transcript.append(
                formatDoneSummary({
                  elapsedMs: Date.now() - started,
                  totalTokens: tokens,
                  totalCost: result.session.totalCost,
                  sessionId: result.session.id,
                }),
                "success",
              );
            }
          } catch (error) {
            transcript.append(
              `✗ Ошибка: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          } finally {
            active = false;
          }
        },
      }),
      // Fullscreen alt-screen как у Claude: выход восстанавливает
      // primary screen, история alt-буфера не сыплется в scrollback.
      // В классике флага нет — обычный буфер, история остаётся в окне.
      { alternateScreen: useAltScreen },
    );
    // Ink hides the VT cursor. In legacy Windows consoles also hide the
    // native cursor, which otherwise blinks below the pinned input.
    terminalCursor.hide();
    // SGR-захват мыши ПОСЛЕ входа в alt-screen (Ink включает его синхронно
    // в конструкторе): порядок важен, иначе режимы сбросятся переключением
    // буфера. Выключаем строго наоборот (1006→1000) в finally ниже.
    mouseOn =
      useAltScreen &&
      process.stdout.isTTY === true &&
      shouldEnableMouse(process.env);
    if (mouseOn) {
      try {
        process.stdout.write(SGR_ENABLE);
      } catch {
        // Не-TTY/pipe: трекинг просто не включится, скролл клавиатурой жив.
      }
    }
  } catch {
    terminalCursor.restore();
    // Ink требует raw mode терминала. В урезанных консолях Windows
    // (двойной клик, старый conhost) render() бросает исключение —
    // переключаемся на простой построчный режим, чтобы окно не мигало и не закрывалось.
    process.stdout.write(
      "Интерактивный интерфейс не запустился в этой консоли, включаю простой текстовый режим.\n",
    );
    await startTuiFallback(options);
    return;
  }
  // Bun on Windows can miss resize events; keep Ink's own dimensions current.
  const sizeSync =
    process.platform === "win32" && process.stdout.isTTY
      ? setInterval(() => syncTerminalSizeToStdout(), 250)
      : undefined;
  sizeSync?.unref();
  let failed = false;
  try {
    await instance.waitUntilExit();
  } catch {
    failed = true;
  } finally {
    if (sizeSync) clearInterval(sizeSync);
    if (mouseOn) {
      try {
        process.stdout.write(SGR_DISABLE);
      } catch {
        // Best effort if stdout has already closed.
      }
    }
    terminalCursor.restore();
  }
  if (failed) await startTuiFallback(options);
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
      `◈ ChiselCode v${VERSION} — простой режим: введите задачу и нажмите Enter.\nКоманды: /help, /status, /doctor, /update, /skills, /cwd <путь>, /exit.\n`,
    );
    for (;;) {
      let line: string;
      try {
        line = (await rl.question("❯ ")).trim();
      } catch {
        return;
      }
      if (!line) continue;
      if (line === "/exit") return;
      if (line === "/help") {
        process.stdout.write(
          "/help — помощь\n/status — состояние\n/doctor — проверка настройки\n/update — проверить и тихо установить обновление\n/skills — доступные скиллы\n/new — новый сеанс\n/sessions — список сеансов\n/resume <номер> — вернуться к сеансу\n/cwd <путь> — сменить папку проекта\n/exit — выход\nОбычный текст — задача для помощника.\n",
        );
        continue;
      }
      if (line === "/skills") {
        const found = loadSkills(activeOptions.cwd ?? process.cwd());
        if (found.length === 0) {
          process.stdout.write(
            "Скиллов нет. Пользовательские навыки находятся в ChiselCode Home/skills/user/<имя>/SKILL.md.\n",
          );
        } else {
          for (const skill of found)
            process.stdout.write(`/${skill.name} — ${skill.description}\n`);
        }
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
            process.stdout.write(`✓ Проект сменён: ${resolved}\n`);
          }
        } catch (error) {
          process.stdout.write(
            `Ошибка: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
        continue;
      }
      if (line === "/clear") {
        process.stdout.write("Экран очищен; история сессии сохранена.\n");
        continue;
      }
      if (line === "/new") {
        activeOptions = { ...activeOptions, resume: undefined };
        process.stdout.write(
          "Начат новый сеанс: следующее сообщение откроет новую сессию.\n",
        );
        continue;
      }
      if (line === "/sessions") {
        const sessions = await listSessions(activeOptions.cwd ?? process.cwd());
        process.stdout.write(`${formatSessionList(sessions)}\n`);
        continue;
      }
      if (line === "/resume" || line.startsWith("/resume ")) {
        const ref = line.slice("/resume".length).trim();
        if (!ref) {
          process.stdout.write(
            "Укажите номер из /sessions или начало id: /resume <номер>.\n",
          );
          continue;
        }
        const sessions = await listSessions(activeOptions.cwd ?? process.cwd());
        const found = resolveSessionRef(sessions, ref);
        if (!found) {
          process.stdout.write(
            `Сеанс «${ref}» не найден. Покажите /sessions.\n`,
          );
          continue;
        }
        activeOptions = { ...activeOptions, resume: found.id };
        process.stdout.write(
          `✓ Возобновлён сеанс «${found.title?.trim() || "без названия"}» (${found.model}, ${found.messages.length} сообщ.).\n`,
        );
        continue;
      }
      if (line === "/status" || line === "/doctor") {
        const current = await loadGlobalConfig();
        const currentProvider =
          activeOptions.provider ?? current.defaultProvider ?? provider;
        const currentConfig = current.providers[currentProvider];
        const ready = await hasApiKey(
          currentProvider,
          currentConfig?.apiKeyRef,
        );
        const resumed = activeOptions.resume
          ? await readSessionSummary(
              activeOptions.resume,
              activeOptions.cwd ?? process.cwd(),
            )
          : undefined;
        process.stdout.write(
          `${formatStatusDashboard({
            providerLabel: providerLabel(currentProvider),
            model:
              activeOptions.model ??
              currentConfig?.defaultModel ??
              current.defaultModel ??
              "не выбрана",
            cwd: activeOptions.cwd ?? process.cwd(),
            keyReady: ready,
            sessionId: resumed ? shortSessionId(resumed.id) : undefined,
            sessionTitle: resumed?.title,
            totalTokens: resumed?.totalTokens,
          })}\n`,
        );
        continue;
      }
      if (line === "/update") {
        if (await runUpdateFallback(rl)) return;
        continue;
      }
      if (line === "/settings" || line === "/model") {
        process.stdout.write(
          "В простом режиме настройки меняются через: chisel setup\n",
        );
        continue;
      }
      {
        // Вызов скилла как /имя args: выполняются инструкции из SKILL.md.
        const space = line.search(/\s/);
        const head = space === -1 ? line : line.slice(0, space);
        if (head.startsWith("/") && head.length > 1) {
          const skill = invocableSkills(
            loadSkills(activeOptions.cwd ?? process.cwd()),
          ).find((candidate) => `/${candidate.name}` === head);
          if (skill) {
            const args = space === -1 ? "" : line.slice(space).trim();
            process.stdout.write(
              `◈ Скилл /${skill.name}: выполняю инструкции.\n`,
            );
            line = expandSkill(skill, args);
          }
        }
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
          return answer === "y" || answer === "н" ? "approved" : "denied";
        },
      };
      try {
        const { result } = await runPrompt(line, activeOptions, resolver);
        activeOptions = { ...activeOptions, resume: result.session.id };
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
  // Тот же прогрев размера, что и для TUI: иначе мастер на полном экране
  // стартует с кэшированных 80x24.
  syncTerminalSizeToStdout();
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
      "Выберите сервис: [1] Anthropic (Claude)  [2] OpenAI  [3] OpenAI-совместимый  [4] Anthropic-совместимый proxy  [5] AgentRouter\n",
    );
    let provider = initialProvider;
    if (!provider) {
      const answer = (
        (await rl.question("Сервис [1-5, по умолчанию 1]: ")) || "1"
      ).trim();
      provider =
        answer === "2"
          ? "openai"
          : answer === "3"
            ? "openai-compatible"
            : answer === "4"
              ? "anthropic-compatible"
              : answer === "5"
                ? "agentrouter"
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
      selected === "openai-compatible" ||
      selected === "agentrouter"
    ) {
      const raw = (
        await rl.question(
          selected === "agentrouter"
            ? `Адрес API [по умолчанию ${AGENTROUTER_BASE_URL}]: `
            : "Адрес API (OpenAI: с /v1, например http://localhost:11434/v1): ",
        )
      ).trim();
      if (!raw) {
        if (selected === "agentrouter") baseUrl = AGENTROUTER_BASE_URL;
        else {
          process.stdout.write("Адрес API не введён. Настройка отменена.\n");
          return false;
        }
      } else baseUrl = raw;
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
  await persistSetup(values);
  process.stdout.write(`\n✓ Готово! ChiselCode v${VERSION} настроен.\n`);
}

/**
 * Сохраняет ключ и конфиг без вывода в stdout.
 * Отдельно от saveSetup: встроенный в TUI мастер работает внутри
 * Ink-интерфейса, где прямой write в stdout портит вывод, — итог там
 * показывает сам интерфейс строкой в журнале.
 */
async function persistSetup(values: SetupValues): Promise<void> {
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
        baseUrl: normalizeBaseUrlForProvider(values.provider, values.baseUrl),
        defaultModel: values.model,
      },
    },
  };
  await saveGlobalConfig(next);
}

function providerLabel(provider: ProviderKind): string {
  if (provider === "anthropic") return "Anthropic (Claude)";
  if (provider === "anthropic-compatible") return "Anthropic-совместимый API";
  if (provider === "openai") return "OpenAI";
  if (provider === "agentrouter") return "AgentRouter";
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
