/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import {
  checkProviderConnection,
  hasApiKey,
  listProviderModels,
  type RunOptions,
  runPrompt,
} from "../commands/run.js";
import {
  checkAssetAvailable,
  checkForUpdates,
  downloadReleaseAsset,
  launchWindowsInstaller,
  NSIS_SILENT_ARGS,
  planSelfUpdate,
  RELEASES_PAGE_URL,
} from "../commands/update.js";
import { loadGlobalConfig, saveGlobalConfig } from "../config/load.js";
import { normalizeBaseUrlForProvider } from "../providers/base-url.js";
import { CredentialStore } from "../security/credentials.js";
import {
  projectSessionStore,
  SessionProjectRegistry,
} from "../sessions/project-store.js";
import { shortSessionId } from "../sessions/store.js";
import {
  buildActiveSkillsPrompt,
  expandSkill,
  invocableSkills,
  loadSkills,
} from "../skills/skills.js";
import type { GlobalConfig, Session } from "../types/domain.js";
import { resolveProjectDir } from "../utils/paths.js";
import { VERSION } from "../version.js";
import { themePalette } from "./appearance.js";
import { commandHelpText, suggestSimilarCommand } from "./commands.js";
import { attachTranscriptScrollback } from "./opentui-scrollback.js";
import type { OpenTuiSessionsActions } from "./opentui-sessions.js";
import type { OpenTuiSettingsActions } from "./opentui-settings.js";
import type { OpenTuiSkillsActions } from "./opentui-skills.js";
import { OpenTuiSpike } from "./opentui-spike.js";
import { defaultModelFor } from "./setup-values.js";
import { formatStatusDashboard } from "./theme.js";
import { toolTranscriptHandlers } from "./tool-transcript.js";
import { createTuiApprovalResolver } from "./tui-contract.js";
import type { TuiController } from "./tui-controller.js";
import { TuiWorkspace } from "./tui-workspace.js";

/** The sole interactive terminal renderer. */
export async function runOpenTuiAgent(
  options: RunOptions,
  initialSession?: Session,
  setupRequired = false,
  setupOnly = false,
): Promise<void> {
  let activeOptions = { ...options, resume: undefined };
  const workspace = new TuiWorkspace(options.cwd ?? process.cwd());
  if (initialSession) workspace.openSession(initialSession);
  const currentController = () => workspace.controller;
  const approvalResolver = createTuiApprovalResolver();
  const config = await loadGlobalConfig();
  let currentTheme = config.ui?.theme ?? "obsidian";
  const classic =
    process.env.CHISEL_ALT_SCREEN === "0" ||
    process.env.CHISEL_NO_ALT_SCREEN === "1";
  const renderer = await createCliRenderer({
    screenMode: classic ? "split-footer" : "alternate-screen",
    footerHeight: 12,
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const scrollbackDetachments = new Map<TuiController, () => void>();
  const syncScrollback = () => {
    if (!classic) return;
    for (const tab of workspace.tabs) {
      if (!scrollbackDetachments.has(tab.controller))
        scrollbackDetachments.set(
          tab.controller,
          attachTranscriptScrollback(tab.controller, renderer, () =>
            themePalette(currentTheme, config.ui?.accent),
          ),
        );
    }
  };
  const detachWorkspace = workspace.subscribe(syncScrollback);
  syncScrollback();
  const detachScrollback = classic
    ? attachTranscriptScrollback(workspace.home, renderer, () =>
        themePalette(currentTheme, config.ui?.accent),
      )
    : undefined;
  const root = createRoot(renderer);
  const abort = new AbortController();
  let activeRun: Promise<void> | undefined;
  let selfUpdateRunning = false;
  const pendingPrompts: Array<{ input: string; controller: TuiController }> =
    [];
  const skillNames = new WeakMap<TuiController, Set<string>>();
  const activeSkills = (controller = currentController()) => {
    let names = skillNames.get(controller);
    if (!names) {
      names = new Set<string>();
      skillNames.set(controller, names);
    }
    return names;
  };
  let pendingSave: Promise<void> = Promise.resolve();
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shutdown = () => {
    abort.abort();
    approvalResolver.dispose();
    finish?.();
  };
  const sessionStore = () =>
    projectSessionStore(currentController().snapshot.projectPath);
  const resume = async (ref: string): Promise<void> => {
    const store = await sessionStore();
    const session = await store.load((await store.resolve(ref)).id);
    workspace.openSession(session);
  };
  const loadProjects = () => new SessionProjectRegistry().list();
  const sessionPicker: OpenTuiSessionsActions = {
    load: async () => (await sessionStore()).list(),
    preview: async (id) => (await sessionStore()).load(id),
    resume,
    rename: async (id, title) => {
      const store = await sessionStore();
      await store.rename(id, title);
      const session = await store.load(id);
      for (const tab of workspace.tabs) {
        if (tab.controller.snapshot.sessionId === session.id)
          tab.controller.setSessionUsage(session);
      }
    },
    delete: async (id) => {
      const projectPath = currentController().snapshot.projectPath;
      const tabs = workspace.tabs.filter(
        ({ controller }) =>
          controller.snapshot.sessionId === id &&
          controller.snapshot.projectPath === projectPath,
      );
      if (tabs.some(({ controller }) => controller.snapshot.busy))
        throw new Error("Дождитесь завершения запроса перед удалением сессии.");
      await (await sessionStore()).delete(id);
      for (const tab of tabs) workspace.close(tab.key);
    },
    activeId: () => currentController().snapshot.sessionId,
  };
  const settingsActions: OpenTuiSettingsActions = {
    load: async () => {
      const current = await loadGlobalConfig();
      const provider =
        activeOptions.provider ?? current.defaultProvider ?? "anthropic";
      const selected = current.providers[provider];
      return {
        values: {
          provider,
          model:
            activeOptions.model ??
            selected?.defaultModel ??
            current.defaultModel ??
            defaultModelFor(provider),
          baseUrl: activeOptions.baseUrl ?? selected?.baseUrl,
        },
        hasKey: await hasApiKey(provider, selected?.apiKeyRef),
      };
    },
    hasKey: async (provider) => {
      const current = await loadGlobalConfig();
      return hasApiKey(provider, current.providers[provider]?.apiKeyRef);
    },
    save: async (values) => {
      const current = await loadGlobalConfig();
      const previous = current.providers[values.provider];
      const typedKey = values.apiKey?.trim();
      const keyRef = typedKey
        ? (previous?.apiKeyRef ?? `${values.provider}-default`)
        : previous?.apiKeyRef;
      if (typedKey && keyRef) await new CredentialStore().set(keyRef, typedKey);
      const baseUrl =
        values.provider === "anthropic-compatible" ||
        values.provider === "openai-compatible" ||
        values.provider === "agentrouter"
          ? normalizeBaseUrlForProvider(values.provider, values.baseUrl)
          : undefined;
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
            baseUrl,
          },
        },
      };
      await saveGlobalConfig(next);
      activeOptions = {
        ...activeOptions,
        provider: values.provider,
        model: values.model,
        baseUrl,
      };
      for (const tab of workspace.tabs)
        tab.controller.setActiveModel(values.provider, values.model);
      return (await hasApiKey(values.provider, keyRef))
        ? "saved"
        : "setup_required";
    },
    check: async (values) => {
      const result = await checkProviderConnection(values);
      return `${result.ok ? "✓" : "✗"} ${result.message}`;
    },
    models: async (values) => {
      const result = await listProviderModels(values);
      return result.ok
        ? {
            ok: true,
            models: result.models.map(({ id, displayName }) => ({
              id,
              hint: displayName,
            })),
          }
        : { ok: false, error: result.error };
    },
  };
  const skillsActions: OpenTuiSkillsActions = {
    load: () => loadSkills(currentController().snapshot.projectPath),
    activeNames: () => [...activeSkills()],
    toggle: (name) => {
      const activeSkillNames = activeSkills();
      if (activeSkillNames.has(name)) activeSkillNames.delete(name);
      else activeSkillNames.add(name);
      currentController().append(
        `Скилл /${name} ${activeSkillNames.has(name) ? "задействован" : "отключён"}`,
        "info",
      );
    },
  };
  const statusText = async (
    controller: TuiController,
    diagnostic = false,
  ): Promise<string> => {
    const current = await loadGlobalConfig();
    const provider = diagnostic
      ? (current.defaultProvider ?? "anthropic")
      : (activeOptions.provider ?? current.defaultProvider ?? "anthropic");
    const selected = current.providers[provider];
    const usage = diagnostic ? undefined : controller.snapshot.usage;
    return formatStatusDashboard({
      providerLabel: {
        anthropic: "Anthropic (Claude)",
        "anthropic-compatible": "Anthropic-совместимый API",
        openai: "OpenAI",
        "openai-compatible": "OpenAI-совместимый API",
        agentrouter: "AgentRouter",
      }[provider],
      model: diagnostic
        ? (selected?.defaultModel ?? current.defaultModel ?? "не выбрана")
        : (activeOptions.model ??
          selected?.defaultModel ??
          current.defaultModel ??
          "не выбрана"),
      cwd: controller.snapshot.projectPath,
      keyReady: await hasApiKey(provider, selected?.apiKeyRef),
      sessionId:
        diagnostic || !controller.snapshot.sessionId
          ? undefined
          : shortSessionId(controller.snapshot.sessionId),
      sessionTitle: diagnostic ? undefined : controller.snapshot.sessionTitle,
      totalTokens: diagnostic
        ? undefined
        : (usage?.totalTokens.inputTokens ?? 0) +
          (usage?.totalTokens.outputTokens ?? 0),
      totalCost: diagnostic ? undefined : usage?.totalCost,
    });
  };
  const selfUpdate = async (controller: TuiController): Promise<void> => {
    if (selfUpdateRunning) {
      controller.append(
        "Обновление уже выполняется, дождитесь завершения.",
        "warn",
      );
      return;
    }
    selfUpdateRunning = true;
    controller.append("Проверяю обновления ChiselCode…", "info");
    try {
      const plan = planSelfUpdate(await checkForUpdates(VERSION), VERSION);
      if (abort.signal.aborted) return;
      if (plan.error) {
        controller.append(
          `⚠ Не удалось проверить обновление: ${plan.error}\n${RELEASES_PAGE_URL}`,
          "warn",
        );
        return;
      }
      if (!plan.updateAvailable) {
        controller.append(
          `✓ У вас последняя версия ChiselCode v${plan.current}`,
          "success",
        );
        return;
      }
      const version = plan.latest ?? plan.current;
      if (plan.assetReady === false) {
        controller.append(
          `Установщик ${plan.asset} ещё собирается: ${plan.latestUrl ?? RELEASES_PAGE_URL}`,
          "warn",
        );
        return;
      }
      if (!plan.installedBinary) {
        controller.append(
          `Доступна версия v${version}. Запущено из исходников; установите вручную: ${plan.latestUrl ?? RELEASES_PAGE_URL}`,
          "info",
        );
        return;
      }
      const decision = await approvalResolver.requestApproval({
        tool: "self_update",
        preview: `Установить ChiselCode v${version}? Сейчас v${plan.current}.\nФайл: ${plan.asset}`,
      });
      if (abort.signal.aborted) return;
      if (decision !== "approved") {
        controller.append("Обновление отменено.", "info");
        return;
      }
      if (plan.assetReady !== true && !(await checkAssetAvailable(plan.url))) {
        controller.append(
          `Файл ${plan.asset} ещё не опубликован: ${plan.latestUrl ?? RELEASES_PAGE_URL}`,
          "warn",
        );
        return;
      }
      if (abort.signal.aborted) return;
      controller.append(`Скачиваю ${plan.asset}…`, "info");
      const downloaded = await downloadReleaseAsset(plan.url, plan.asset, {
        expectedBytes: plan.assetSize,
        expectedSha256: plan.sha256,
      });
      if (abort.signal.aborted) return;
      controller.append(
        `Скачано ${(downloaded.bytes / 1024 / 1024).toFixed(1)} МБ: ${downloaded.path}`,
        "info",
      );
      if (!plan.autoInstall) {
        controller.append(
          `Завершите установку вручную: ${plan.manualCommand ?? plan.url}`,
          "info",
        );
        return;
      }
      await launchWindowsInstaller(downloaded.path, NSIS_SILENT_ARGS);
      controller.append("Установщик запущен. Закрываю ChiselCode…", "info");
      shutdown();
    } catch (error) {
      controller.append(`Ошибка обновления: ${String(error)}`, "error");
    } finally {
      selfUpdateRunning = false;
    }
  };
  const submit = async (
    input: string,
    target = currentController(),
  ): Promise<void> => {
    let controller = target;
    if (abort.signal.aborted) return;
    if (input === "/exit") return shutdown();
    if (selfUpdateRunning) {
      controller.append("Дождитесь завершения обновления.", "warn");
      return;
    }
    if (input === "/home") return workspace.select();
    if (input === "/clear" || input === "/new") {
      workspace.newTab(controller.snapshot.projectPath);
      return;
    }
    if (input === "/help") {
      controller.append(
        `${commandHelpText(invocableSkills(skillsActions.load()))}\n/sidebar [auto|show|hide] · показать или скрыть контекст`,
        "info",
      );
      return;
    }
    if (input === "/status" || input === "/doctor") {
      try {
        controller.append(
          await statusText(controller, input === "/doctor"),
          "info",
        );
      } catch (error) {
        controller.append(String(error), "error");
      }
      return;
    }
    if (input === "/update") {
      if (activeRun) {
        controller.append(
          "Дождитесь завершения запроса перед обновлением.",
          "warn",
        );
        return;
      }
      return selfUpdate(controller);
    }
    if (input === "/sessions") {
      const sessions = await sessionPicker.load();
      controller.append(
        sessions
          .map((s) => `${s.id} · ${s.title ?? "без названия"}`)
          .join("\n") || "Сессий нет",
        "info",
      );
      return;
    }
    if (input.startsWith("/resume ")) {
      try {
        await resume(input.slice(8).trim());
      } catch (error) {
        controller.append(String(error), "error");
      }
      return;
    }
    if (input.startsWith("/cwd ")) {
      try {
        const cwd = await resolveProjectDir(
          input.slice(5).trim(),
          controller.snapshot.projectPath,
        );
        workspace.home.switchSession(undefined, cwd);
        workspace.select();
      } catch (error) {
        controller.append(String(error), "error");
      }
      return;
    }
    if (input === "/cwd") {
      controller.append(
        `Проект: ${controller.snapshot.projectPath}\nЧтобы сменить папку: /cwd <путь>`,
        "info",
      );
      return;
    }
    const availableSkills = loadSkills(controller.snapshot.projectPath);
    const command = input.split(/\s/, 1)[0] ?? input;
    const skill = input.startsWith("/")
      ? invocableSkills(availableSkills).find(
          (item) => `/${item.name}` === command,
        )
      : undefined;
    if (input.startsWith("/") && !skill) {
      const hint = suggestSimilarCommand(
        input,
        invocableSkills(availableSkills),
      );
      controller.append(
        `Неизвестная команда ${command}${hint ? ` · возможно, ${hint}` : ""}`,
        "warn",
      );
      return;
    }
    if (activeRun) {
      if (controller === workspace.home)
        controller = workspace.newTab(controller.snapshot.projectPath);
      pendingPrompts.push({ input, controller });
      controller.setBusy(true);
      controller.append(
        `В очереди: ${pendingPrompts.length} · ${input}`,
        "info",
      );
      return;
    }
    if (controller === workspace.home) {
      const selectedSkills = activeSkills(controller);
      controller = workspace.newTab(controller.snapshot.projectPath);
      skillNames.set(controller, new Set(selectedSkills));
    }
    controller.setBusy(true);
    controller.append(`❯ ${input}`, "user");
    const expanded = skill
      ? expandSkill(skill, input.slice(command.length).trim())
      : input;
    const prompt = buildActiveSkillsPrompt(
      availableSkills.filter((item) => activeSkills(controller).has(item.name)),
      expanded,
    );
    const tools = toolTranscriptHandlers(() => controller);
    const work = (async () => {
      try {
        let hasText = false;
        const { result } = await runPrompt(
          prompt,
          {
            ...activeOptions,
            cwd: controller.snapshot.projectPath,
            resume: controller.snapshot.sessionId,
          },
          approvalResolver,
          {
            onText: (text) => {
              controller.appendToLast(text);
              hasText = true;
            },
            onThinking: (text) =>
              controller.setToolActivity(`Размышление: ${text.slice(-200)}`),
            onToolStart: tools.onToolStart,
            onToolResult: (name, outcome) => {
              tools.onToolResult?.(name, outcome);
              if (
                [
                  "write_file",
                  "edit_file",
                  "delete_file",
                  "run_shell",
                  "git_commit",
                ].includes(name)
              )
                controller.refreshGitChanges();
            },
          },
          abort.signal,
        );
        controller.setSessionUsage(result.session);
        controller.setToolActivity();
        if (result.error) controller.append(result.error, "error");
        else if (!hasText)
          controller.append(
            result.text || "Запрос завершён без текстового ответа",
            "assistant",
          );
      } catch (error) {
        if (!abort.signal.aborted) controller.append(String(error), "error");
      } finally {
        activeRun = undefined;
        controller.setBusy(
          pendingPrompts.some((item) => item.controller === controller),
        );
        const next = pendingPrompts.shift();
        if (next && !abort.signal.aborted)
          void submit(next.input, next.controller);
      }
    })();
    activeRun = work;
    await work;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    root.render(
      React.createElement(OpenTuiSpike, {
        onExit: shutdown,
        workspace,
        classic,
        approvalResolver,
        sessionPicker,
        loadProjects,
        settingsActions,
        skillsActions,
        initialSettingsOpen: setupRequired || setupOnly,
        onSetupComplete: setupOnly ? shutdown : undefined,
        onSubmit: submit,
        initialMode: config.ui?.sidebarMode ?? "auto",
        initialTheme: config.ui?.theme ?? "obsidian",
        accent: config.ui?.accent,
        onThemeChange: (theme) => {
          currentTheme = theme;
          pendingSave = pendingSave
            .then(async () => {
              const current = await loadGlobalConfig();
              await saveGlobalConfig({
                ...current,
                ui: { ...current.ui, theme },
              });
            })
            .catch(() => {});
        },
        onModeChange: (mode) => {
          pendingSave = pendingSave
            .then(async () => {
              const current = await loadGlobalConfig();
              await saveGlobalConfig({
                ...current,
                ui: { ...current.ui, sidebarMode: mode },
              });
            })
            .catch(() => {});
        },
      }),
    );
    await finished;
    await activeRun;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    abort.abort();
    approvalResolver.dispose();
    root.unmount();
    detachScrollback?.();
    detachWorkspace();
    for (const detach of scrollbackDetachments.values()) detach();
    workspace.dispose();
    renderer.destroy();
    await pendingSave;
  }
}
