/** @jsxImportSource @opentui/react */

import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import { runExtensionCommand } from "../app/run-command.js";
import {
  checkProviderConnection,
  getModelCapabilities,
  hasApiKey,
  listProviderModels,
  type RunOptions,
  runPrompt,
} from "../commands/run.js";
import { resolveSlashCommand, splitSlashCommand } from "../commands/slash.js";
import {
  launchWindowsInstaller,
  windowsUpdateArguments,
} from "../commands/update.js";
import {
  loadGlobalConfig,
  loadProjectConfig,
  saveGlobalConfig,
} from "../config/load.js";
import {
  defaultExtensions,
  withOwnedExtensionHost,
} from "../extensions/composition.js";
import type { ChiselExtension } from "../extensions/contracts.js";
import type { ExtensionHost } from "../extensions/host.js";
import { safeDiagnostic } from "../extensions/lifecycle.js";
import { McpController } from "../mcp/controller.js";
import { McpConnectionManager } from "../mcp/manager.js";
import { McpConfigStore } from "../mcp/storage.js";
import { getProviderCatalog } from "../providers/catalog.js";
import { selectProfile } from "../providers/profiles.js";
import {
  AGENT_MODE_LABELS,
  DEFAULT_AGENT_MODE,
} from "../runtime/agent-mode.js";
import {
  APPROVAL_MODE_LABELS,
  resolveApprovalMode,
} from "../security/approval-mode.js";
import { projectSessionStore } from "../sessions/project-store.js";
import { shortSessionId } from "../sessions/store.js";
import {
  buildActiveSkillsPrompt,
  expandSkill,
  invocableSkills,
  loadSkills,
} from "../skills/skills.js";
import type { Session } from "../types/domain.js";
import { resolveProjectDir } from "../utils/paths.js";
import { clipText } from "../utils/text.js";
import { VERSION } from "../version.js";
import { resolveWebConfig } from "../web/schema.js";
import { WebSettingsStore } from "../web/settings.js";
import { themePalette } from "./appearance.js";
import { commandHelpText, suggestSimilarCommand } from "./commands.js";
import type { OpenTuiModelsActions } from "./opentui-models.js";
import { attachTranscriptScrollback } from "./opentui-scrollback.js";
import type { OpenTuiSessionsActions } from "./opentui-sessions.js";
import type { OpenTuiSettingsActions } from "./opentui-settings.js";
import type { OpenTuiSkillsActions } from "./opentui-skills.js";
import { OpenTuiSpike } from "./opentui-spike.js";
import {
  saveProviderSettings,
  settingsDraft,
  settingsKeyReady,
} from "./provider-settings.js";
import { FAIL_MARK, formatStatusDashboard, OK_MARK } from "./theme.js";
import { toolTranscriptHandlers } from "./tool-transcript.js";
import type { TuiController } from "./tui-controller.js";
import type { QueuedTabOperation } from "./tui-tab-execution.js";
import { TuiWorkspace } from "./tui-workspace.js";
import { UpdateController } from "./update-controller.js";
import { WorkspaceCommands } from "./workspace-commands.js";

/** The sole interactive terminal renderer. */
export async function runOpenTuiAgent(
  options: RunOptions,
  initialSession?: Session,
  setupRequired = false,
  setupOnly = false,
  extensions: readonly ChiselExtension[] = defaultExtensions(),
  rendererFactory: typeof createCliRenderer = createCliRenderer,
): Promise<void> {
  return withOwnedExtensionHost(extensions, (host) =>
    runApplication(
      options,
      initialSession,
      setupRequired,
      setupOnly,
      host,
      rendererFactory,
    ),
  );
}

async function runApplication(
  options: RunOptions,
  initialSession: Session | undefined,
  setupRequired: boolean,
  setupOnly: boolean,
  extensionHost: ExtensionHost,
  rendererFactory: typeof createCliRenderer,
): Promise<void> {
  let activeOptions = { ...options, resume: undefined };
  const config = await loadGlobalConfig();
  let bypassAvailable = config.permissions?.allowBypassPermissions === true;
  let webConfigLive = resolveWebConfig(config.web);
  const webSettingsStore = new WebSettingsStore(options.configPath);
  const projectConfig = await loadProjectConfig(options.cwd ?? process.cwd());
  const initialApprovalMode = resolveApprovalMode({
    ...options,
    saved: initialSession?.approvalMode,
    autoApprove: projectConfig.autoApprove,
    allowBypassPermissions: bypassAvailable,
  });
  const workspace = new TuiWorkspace(
    options.cwd ?? process.cwd(),
    options.mode ?? DEFAULT_AGENT_MODE,
    initialApprovalMode,
  );
  if (initialSession) workspace.openSession(initialSession);
  workspace.controller.setApprovalMode(initialApprovalMode);
  if (options.mode) workspace.controller.setAgentMode(options.mode);
  const currentController = () => workspace.controller;
  const mcpProjects = new Map<string, McpController>();
  const getMcpController = (projectRoot: string) => {
    let controller = mcpProjects.get(projectRoot);
    if (!controller) {
      controller = new McpController(
        new McpConnectionManager(
          new McpConfigStore(projectRoot, { globalPath: options.configPath }),
        ),
      );
      mcpProjects.set(projectRoot, controller);
    }
    return controller;
  };
  const catalog = await getProviderCatalog();
  const homeModel = settingsDraft(config, catalog.registry, activeOptions);
  workspace.home.setActiveModel(
    homeModel.provider,
    homeModel.model,
    homeModel.profileId,
    homeModel.baseUrl,
  );
  const initialModel = settingsDraft(
    config,
    catalog.registry,
    initialSession
      ? {
          ...activeOptions,
          profile:
            options.profile ??
            (options.provider ? undefined : initialSession.profileId),
          provider:
            options.provider ??
            (options.profile ? undefined : initialSession.providerId),
          model:
            options.model ??
            ((options.provider ??
              (options.profile
                ? config.profiles[options.profile]?.providerId
                : initialSession.providerId)) === initialSession.providerId
              ? initialSession.model
              : undefined),
        }
      : activeOptions,
  );
  workspace.controller.setActiveModel(
    initialModel.provider,
    initialModel.model,
    initialModel.profileId,
    initialModel.baseUrl,
  );
  let defaultModel = homeModel.model;
  const modelOptions = (controller: TuiController): RunOptions => {
    const selected = controller.snapshot.modelSelection;
    return selected
      ? {
          provider: selected.provider,
          profile: selected.profileId,
          model: selected.model,
          baseUrl: selected.baseUrl,
        }
      : activeOptions;
  };
  const modelCache = new Map<
    string,
    { expires: number; result: Awaited<ReturnType<typeof listProviderModels>> }
  >();
  let modelCacheGeneration = 0;
  const capabilityRequests = new Map<
    string,
    ReturnType<typeof getModelCapabilities>
  >();
  const warmModelCapabilities = (controller: TuiController) => {
    const selection = controller.snapshot.modelSelection;
    if (!selection) return;
    const generation = controller.currentGeneration;
    const key = JSON.stringify(selection);
    let request = capabilityRequests.get(key);
    if (!request) {
      request = getModelCapabilities({
        provider: selection.provider,
        profileId: selection.profileId,
        model: selection.model,
        baseUrl: selection.baseUrl,
      });
      capabilityRequests.set(key, request);
    }
    void request.then((capabilities) => {
      if (controller.isCurrent(generation))
        controller.setModelCapabilities(selection, capabilities);
    });
  };
  warmModelCapabilities(workspace.home);
  warmModelCapabilities(workspace.controller);
  const modelRequests = new Map<string, number>();
  let currentTheme = config.ui?.theme ?? "obsidian";
  const classic =
    process.env.CHISEL_ALT_SCREEN === "0" ||
    process.env.CHISEL_NO_ALT_SCREEN === "1";
  const renderer = await rendererFactory({
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
  const commandActions = new WorkspaceCommands(extensionHost, abort.signal);
  void commandActions.load(currentController().snapshot.projectPath);
  let homeOperationTarget:
    | { generation: number; root: string; controller: TuiController }
    | undefined;
  const skillNames = new WeakMap<
    TuiController,
    { generation: number; names: Set<string> }
  >();
  const activeSkills = (controller = currentController()) => {
    let entry = skillNames.get(controller);
    if (!entry || entry.generation !== controller.currentGeneration) {
      entry = {
        generation: controller.currentGeneration,
        names: new Set<string>(),
      };
      skillNames.set(controller, entry);
    }
    return entry.names;
  };
  let pendingSave: Promise<void> = Promise.resolve();
  const persistExecutionModes = (controller: TuiController) => {
    if (!controller.snapshot.sessionId || controller.snapshot.busy) return;
    pendingSave = pendingSave
      .then(async () => {
        const {
          sessionId,
          projectPath,
          agentMode,
          approvalMode,
          busy,
          modelSelection,
        } = controller.snapshot;
        if (!sessionId || busy) return;
        const store = await projectSessionStore(projectPath);
        await store.setPreferences(sessionId, {
          mode: agentMode,
          approvalMode,
          ...(modelSelection
            ? {
                providerId: modelSelection.provider,
                profileId: modelSelection.profileId,
                model: modelSelection.model,
              }
            : {}),
        });
      })
      .catch((error) =>
        controller.append(
          `Не удалось сохранить выбор сессии: ${String(error)}`,
          "error",
        ),
      );
  };
  if (
    initialSession &&
    (options.mode ||
      options.approvalMode ||
      options.yes ||
      initialSession.approvalMode !== initialApprovalMode)
  )
    persistExecutionModes(workspace.controller);
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shutdown = () => {
    abort.abort();
    workspace.cancelAll();
    for (const { controller } of workspace.tabs) {
      if (!controller.snapshot.runningMode) {
        controller.setBusy(false);
        persistExecutionModes(controller);
      }
    }
    finish?.();
  };
  const cancel = () => workspace.execution().cancel();
  const sessionStore = () =>
    projectSessionStore(currentController().snapshot.projectPath);
  const resume = async (ref: string): Promise<void> => {
    const store = await sessionStore();
    const session = await store.load((await store.resolve(ref)).id);
    const project = await loadProjectConfig(session.projectPath);
    session.approvalMode = resolveApprovalMode({
      saved: session.approvalMode,
      autoApprove: project.autoApprove,
      allowBypassPermissions: bypassAvailable,
    });
    const controller = workspace.openSession(session);
    persistExecutionModes(controller);
    warmModelCapabilities(controller);
  };
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
    web: {
      load: () => webSettingsStore.load(),
      save: async (webConfig, apiKey) => {
        const saved = pendingSave.then(async () => {
          const state = await webSettingsStore.save(webConfig, apiKey);
          webConfigLive = state.config;
          return state;
        });
        pendingSave = saved.then(
          () => {},
          () => {},
        );
        return saved;
      },
    },
    catalog: async () => ({
      providers: catalog.registry.list(),
      profiles: (await loadGlobalConfig()).profiles,
    }),
    load: async (profileId) => {
      const current = await loadGlobalConfig();
      const selection = profileId
        ? { profile: profileId }
        : modelOptions(currentController());
      const values = settingsDraft(current, catalog.registry, selection);
      const profile = values.profileId
        ? current.profiles[values.profileId]
        : undefined;
      return {
        values,
        hasKey: await settingsKeyReady(
          catalog.registry,
          profile ?? { providerId: values.provider },
        ),
      };
    },
    hasKey: async (provider, profileId) => {
      const current = await loadGlobalConfig();
      return settingsKeyReady(
        catalog.registry,
        profileId
          ? (current.profiles[profileId] ?? { providerId: provider })
          : { providerId: provider },
      );
    },
    save: async (values) => {
      const outcome = await saveProviderSettings(values, catalog.registry);
      defaultModel = values.model;
      const profile =
        values.profileId ?? `${values.provider.replaceAll("/", "-")}-default`;
      activeOptions = {
        ...activeOptions,
        profile,
        provider: undefined,
        model: values.model,
        baseUrl: values.baseUrl,
      };
      modelCache.clear();
      capabilityRequests.clear();
      modelCacheGeneration++;
      currentController().setActiveModel(
        values.provider,
        values.model,
        profile,
        values.baseUrl,
      );
      warmModelCapabilities(currentController());
      return outcome;
    },
    check: async (values) => {
      const result = await checkProviderConnection(values);
      return `${result.ok ? OK_MARK : FAIL_MARK} ${result.message}`;
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
  const getModelsActions = (): OpenTuiModelsActions => {
    const controller = currentController();
    const generation = controller.currentGeneration;
    return {
      load: async () => {
        const currentConfig = await loadGlobalConfig();
        const current =
          controller.snapshot.modelSelection ??
          settingsDraft(
            currentConfig,
            catalog.registry,
            modelOptions(controller),
          );
        const profiles = Object.entries(currentConfig.profiles).flatMap(
          ([id, entry]) => {
            const provider = catalog.registry.get(entry.providerId);
            if (!provider) return [];
            return [
              {
                key: id,
                label: entry.label ?? id,
                providerLabel: provider.label,
                selection: settingsDraft(currentConfig, catalog.registry, {
                  profile: id,
                }),
              },
            ];
          },
        );
        const matching = profiles.find(
          (item) =>
            item.selection.profileId === current.profileId &&
            item.selection.provider === current.provider,
        );
        if (matching) matching.selection = { ...current };
        return { current: { ...current }, profiles };
      },
      models: async (selection, refresh) => {
        const key = JSON.stringify([
          selection.provider,
          selection.profileId,
          selection.baseUrl,
        ]);
        const cached = modelCache.get(key);
        const cacheHit = !refresh && cached && cached.expires > Date.now();
        const generation = modelCacheGeneration;
        const request = cacheHit
          ? modelRequests.get(key)
          : (modelRequests.get(key) ?? 0) + 1;
        if (!cacheHit && request !== undefined) modelRequests.set(key, request);
        const result = cacheHit
          ? cached.result
          : await listProviderModels(selection);
        if (result.ok) {
          if (
            !cacheHit &&
            generation === modelCacheGeneration &&
            request === modelRequests.get(key)
          )
            modelCache.set(key, { expires: Date.now() + 300_000, result });
          return {
            ok: true,
            models: result.models.map(
              ({ id, displayName, contextWindow, maxOutputTokens }) => ({
                id,
                hint: displayName,
                contextWindow,
                maxOutputTokens,
              }),
            ),
          };
        }
        return { ok: false, error: result.error };
      },
      select: async (selection) => {
        if (abort.signal.aborted || !controller.isCurrent(generation))
          throw new Error("Эта сессия уже закрыта.");
        const currentConfig = await loadGlobalConfig();
        if (abort.signal.aborted || !controller.isCurrent(generation))
          throw new Error("Эта сессия уже закрыта.");
        catalog.registry.require(selection.provider);
        const { profileId } = selectProfile(currentConfig, {
          provider: selection.provider,
          profile: selection.profileId,
        });
        if (
          !selection.model.trim() ||
          [...selection.model].some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        )
          throw new Error("Введите корректный ID модели.");
        const { sessionId, projectPath, busy } = controller.snapshot;
        if (sessionId && !busy) {
          const saved = pendingSave.then(async () => {
            const store = await projectSessionStore(projectPath);
            if (abort.signal.aborted || !controller.isCurrent(generation))
              throw new Error("Эта сессия уже закрыта.");
            await store.setPreferences(sessionId, {
              providerId: selection.provider,
              profileId,
              model: selection.model,
            });
          });
          pendingSave = saved.catch(() => {});
          await saved;
        }
        if (abort.signal.aborted || !controller.isCurrent(generation)) return;
        controller.setActiveModel(
          selection.provider,
          selection.model,
          profileId,
          selection.baseUrl,
        );
        warmModelCapabilities(controller);
      },
    };
  };
  const skillsActions: OpenTuiSkillsActions = {
    load: () => loadSkills(currentController().snapshot.projectPath),
    activeNames: () => [...activeSkills()],
    toggle: (name) => {
      const activeSkillNames = activeSkills();
      if (activeSkillNames.has(name)) activeSkillNames.delete(name);
      else activeSkillNames.add(name);
      currentController().append(
        `Скилл /${name} ${activeSkillNames.has(name) ? "закреплён для этой вкладки" : "откреплён"}`,
        "info",
      );
    },
    editSource: (name) => {
      const skill = loadSkills(currentController().snapshot.projectPath).find(
        (item) => item.name === name && item.source === "user",
      );
      if (!skill) throw new Error("Пользовательский скилл больше не доступен.");
      const file = join(skill.dir, "SKILL.md");
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Не удалось безопасно открыть инструкции скилла.");
      return readFileSync(file, "utf8");
    },
  };
  const statusText = async (
    controller: TuiController,
    diagnostic = false,
  ): Promise<string> => {
    const current = await loadGlobalConfig();
    const draft = settingsDraft(
      current,
      catalog.registry,
      diagnostic ? {} : modelOptions(controller),
    );
    const provider = draft.provider;
    const selected = draft.profileId
      ? current.profiles[draft.profileId]
      : undefined;
    const usage = diagnostic ? undefined : controller.snapshot.usage;
    return formatStatusDashboard({
      providerLabel: catalog.registry.get(provider)?.label ?? provider,
      model: draft.model || "не выбрана",
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
  const updater = new UpdateController(VERSION, {
    canRestart: () => !workspace.busy,
    launch: async (downloaded) => {
      await pendingSave;
      if (abort.signal.aborted)
        throw new DOMException("Обновление отменено.", "AbortError");
      if (workspace.busy)
        throw new Error("Дождитесь завершения запроса перед перезапуском.");
      const { projectPath, sessionId } = currentController().snapshot;
      await launchWindowsInstaller(
        downloaded.path,
        windowsUpdateArguments(resolve(projectPath), sessionId),
      );
      shutdown();
    },
  });
  const submit = async (
    input: string,
    target = currentController(),
    turnMode = target.snapshot.agentMode,
    turnApprovalMode = target.snapshot.approvalMode,
    turnModelOptions = { ...modelOptions(target) },
  ): Promise<void> => {
    let controller = target;
    const originGeneration = controller.currentGeneration;
    const originRoot = controller.snapshot.projectPath;
    const priorHomeOperationTarget = homeOperationTarget;
    input = input.trim();
    const parsed = splitSlashCommand(input);
    if (abort.signal.aborted) return;
    turnApprovalMode = resolveApprovalMode({
      saved: turnApprovalMode,
      allowBypassPermissions: bypassAvailable,
    });
    if (input === "/exit") return shutdown();
    if (updater.snapshot.phase === "launching") {
      controller.append("Дождитесь перезапуска ChiselCode.", "warn");
      return;
    }
    if (input === "/home") return workspace.select();
    if (input === "/clear" || input === "/new") {
      workspace.newDraft(controller.snapshot.projectPath);
      return;
    }
    if (input === "/help") {
      const snapshot = commandActions.current(originRoot);
      if (snapshot.error) controller.append(snapshot.error, "error");
      controller.append(commandHelpText(snapshot.projection), "info");
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
    if (input === "/update") return updater.check();
    if (input === "/sessions") {
      const sessions = await sessionPicker.load();
      controller.append(
        sessions
          .map((s) => `${s.id} | ${s.title ?? "без названия"}`)
          .join("\n") || "Сессий нет",
        "info",
      );
      return;
    }
    if (parsed?.name === "/resume" && parsed.args) {
      try {
        await resume(parsed.args);
      } catch (error) {
        controller.append(String(error), "error");
      }
      return;
    }
    if (parsed?.name === "/cwd" && parsed.args) {
      try {
        const cwd = await resolveProjectDir(
          parsed.args,
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
    let snapshot:
      | import("./workspace-commands.js").WorkspaceCommandSnapshot
      | undefined;
    const submission = new AbortController();
    if (parsed) {
      const execution = workspace.execution(controller);
      execution.pendingSubmissions.add(submission);
      try {
        snapshot = await commandActions.load(
          originRoot,
          AbortSignal.any([abort.signal, submission.signal]),
        );
      } finally {
        execution.pendingSubmissions.delete(submission);
      }
    }
    if (
      !controller.isCurrent(originGeneration) ||
      abort.signal.aborted ||
      submission.signal.aborted
    )
      return;
    const availableSkills = snapshot?.skills ?? loadSkills(originRoot);
    const descriptor = snapshot
      ? resolveSlashCommand(snapshot.projection, input)
      : undefined;
    const skillName =
      descriptor?.source.type === "skill" ? descriptor.source.name : undefined;
    const skill = skillName
      ? availableSkills.find((item) => item.name === skillName)
      : undefined;
    let prepared:
      | import("../app/run-command.js").PreparedExtensionCommand
      | undefined;
    if (descriptor?.source.type === "extension" && snapshot?.scope) {
      const command = snapshot.scope.commands.get(descriptor.source.name);
      try {
        prepared = { command, input: command.parse(parsed?.args ?? "") };
      } catch {
        controller.append(
          `[extension] /${command.name} · ${command.source.extensionId}: неверные аргументы.${command.usage ? ` Использование: ${safeDiagnostic(command.usage)}` : ""}`,
          "error",
        );
        return;
      }
    }
    if (parsed && !skill && !prepared) {
      if (snapshot?.error) controller.append(snapshot.error, "error");
      const hint = suggestSimilarCommand(
        input,
        snapshot?.projection ?? invocableSkills([...availableSkills]),
      );
      controller.append(
        `Неизвестная команда ${safeDiagnostic(parsed.name)}${hint ? ` | возможно, ${hint}` : ""}`,
        "warn",
      );
      return;
    }
    if (
      controller === workspace.home &&
      homeOperationTarget !== priorHomeOperationTarget &&
      homeOperationTarget?.generation === originGeneration &&
      homeOperationTarget.root === originRoot &&
      workspace.tabs.some(
        (tab) => tab.controller === homeOperationTarget?.controller,
      )
    )
      controller = homeOperationTarget.controller;
    if (controller === workspace.home) {
      const selectedTab = workspace.activeKey;
      const selectedSkills = activeSkills(controller);
      const inputHistory = controller.presentation.history;
      controller = workspace.newTab(
        controller.snapshot.projectPath,
        turnMode,
        turnApprovalMode,
        target.snapshot.modelSelection,
      );
      // A late home submission owns a new conversation, not the screen selected in the meantime.
      if (selectedTab) workspace.select(selectedTab);
      controller.setSessionTitle(
        clipText(input.split("\n", 1)[0] ?? input, 120),
      );
      homeOperationTarget = {
        generation: originGeneration,
        root: originRoot,
        controller,
      };
      if (!prepared) warmModelCapabilities(controller);
      controller.presentation.history = inputHistory;
      skillNames.set(controller, {
        generation: controller.currentGeneration,
        names: new Set(selectedSkills),
      });
    }
    const item: QueuedTabOperation =
      prepared && snapshot?.scope
        ? {
            kind: "command",
            input,
            prepared,
            scope: snapshot.scope,
            root: originRoot,
            mode: turnMode,
            approvalMode: turnApprovalMode,
            modelOptions: turnModelOptions,
            generation: controller.currentGeneration,
          }
        : {
            kind: "prompt",
            input,
            root: originRoot,
            mode: turnMode,
            approvalMode: turnApprovalMode,
            modelOptions: turnModelOptions,
            generation: controller.currentGeneration,
          };
    const execution = workspace.execution(controller);
    if (execution.activeRun) {
      execution.pendingOperations.push(item);
      controller.setBusy(true);
      controller.append(
        `В очереди: ${execution.pendingOperations.length} | ${AGENT_MODE_LABELS[turnMode]} | ${APPROVAL_MODE_LABELS[turnApprovalMode]} | ${input}`,
        "info",
      );
      return;
    }
    await executeOperation(controller, item);
  };
  const executeOperation = async (
    controller: TuiController,
    item: QueuedTabOperation,
  ): Promise<void> => {
    if (
      abort.signal.aborted ||
      !controller.isCurrent(item.generation) ||
      controller.snapshot.projectPath !== item.root
    )
      return;
    const execution = workspace.execution(controller);
    const {
      input,
      mode: turnMode,
      approvalMode: turnApprovalMode,
      modelOptions: turnModelOptions,
    } = item;
    const requestGeneration = controller.currentGeneration;
    const turnAbort = new AbortController();
    execution.abort = turnAbort;
    const signal = AbortSignal.any([abort.signal, turnAbort.signal]);
    controller.startRequest();
    controller.setRunningMode(turnMode);
    controller.setRunningApprovalMode(turnApprovalMode);
    controller.append(`> ${input}`, "user");
    const tools = toolTranscriptHandlers(() => controller);
    // Install the owner before any provider callback can complete the request.
    const work = Promise.resolve().then(async () => {
      let status: "completed" | "failed" | "cancelled" | "approval_required" =
        "failed";
      let elapsedMs: number | undefined;
      try {
        if (item.kind === "command") {
          const snapshot = await commandActions.load(item.root, signal);
          const descriptor = resolveSlashCommand(snapshot.projection, input);
          if (!controller.isCurrent(requestGeneration) || signal.aborted)
            return;
          if (
            snapshot.error ||
            snapshot.scope !== item.scope ||
            descriptor?.source.type !== "extension" ||
            descriptor.source.extensionId !==
              item.prepared.command.source.extensionId ||
            descriptor.source.name !== item.prepared.command.name
          ) {
            controller.append(
              snapshot.error ??
                "Команда больше не принадлежит выбранному расширению.",
              "error",
            );
            return;
          }
          const heading = `[extension] /${item.prepared.command.name} · ${item.prepared.command.source.extensionId}`;
          controller.append(heading, "tool");
          controller.setToolActivity(heading);
          const outcome = await runExtensionCommand(
            item.prepared,
            item.scope,
            {
              ...options,
              ...turnModelOptions,
              cwd: item.root,
              resume: controller.snapshot.sessionId,
              mode: turnMode,
              approvalMode: turnApprovalMode,
              interactive: true,
              isBypassAllowed: () => bypassAvailable,
              getWebConfig: () => webConfigLive,
              mcpManager: getMcpController(item.root).manager,
            },
            execution.approvalResolver,
            {
              onEvent: (event) => {
                if (!controller.isCurrent(requestGeneration) || signal.aborted)
                  return;
                if (event.type === "checkpoint_saved")
                  controller.setSessionId(event.sessionId);
                if (event.type === "tool_progress")
                  controller.setToolActivity(
                    `${event.name ?? "MCP"} · ${event.text ?? "Выполняется"}`,
                  );
              },
              onToolStart: (name, input, source) => {
                if (controller.isCurrent(requestGeneration) && !signal.aborted)
                  tools.onToolStart?.(name, input, source);
              },
              onToolResult: (name, result) => {
                if (!controller.isCurrent(requestGeneration) || signal.aborted)
                  return;
                tools.onToolResult?.(name, result);
                if (result.diffs?.length || result.fileDiff)
                  for (const tab of workspace.tabs)
                    tab.controller.refreshGitChanges();
              },
            },
            signal,
          );
          status =
            signal.aborted || outcome.result.errorCode === "CANCELLED"
              ? "cancelled"
              : outcome.result.requiresApproval
                ? "approval_required"
                : outcome.result.isError
                  ? "failed"
                  : "completed";
          if (!controller.isCurrent(requestGeneration) || signal.aborted)
            return;
          controller.setSessionUsage(outcome.session);
          controller.append(
            outcome.result.output,
            outcome.result.isError || outcome.result.requiresApproval
              ? "error"
              : "info",
          );
          return;
        }
        const availableSkills = loadSkills(item.root);
        const parsed = splitSlashCommand(input);
        const skill = parsed
          ? invocableSkills(availableSkills).find(
              (skill) => `/${skill.name}` === parsed.name,
            )
          : undefined;
        if (parsed && !skill) {
          controller.append("Скилл больше не доступен.", "error");
          return;
        }
        const expanded = skill ? expandSkill(skill, parsed?.args ?? "") : input;
        const prompt = buildActiveSkillsPrompt(
          availableSkills.filter((item) =>
            activeSkills(controller).has(item.name),
          ),
          expanded,
        );
        let hasText = false;
        const { result } = await runPrompt(
          prompt,
          {
            ...(controller.snapshot.sessionId ? options : activeOptions),
            ...turnModelOptions,
            cwd: controller.snapshot.projectPath,
            resume: controller.snapshot.sessionId,
            mode: turnMode,
            approvalMode: turnApprovalMode,
            interactive: true,
            isBypassAllowed: () => bypassAvailable,
            getWebConfig: () => webConfigLive,
            mcpManager: getMcpController(controller.snapshot.projectPath)
              .manager,
          },
          execution.approvalResolver,
          {
            onEvent: (event) => {
              if (!controller.isCurrent(requestGeneration) || signal.aborted)
                return;
              if (event.type === "checkpoint_saved")
                controller.setSessionId(event.sessionId);
              if (event.type === "tool_progress")
                controller.setToolActivity(
                  `${event.name ?? "MCP"} · ${event.text ?? "Выполняется"}${event.total ? ` ${Math.min(100, Math.round(((event.progress ?? 0) / event.total) * 100))}%` : ""}`,
                );
              if (
                event.type === "context_compaction_started" &&
                event.compactionId
              )
                controller.beginCompaction(event.compactionId);
              if (
                event.type === "context_compaction_completed" &&
                event.compaction
              )
                controller.finishCompaction(event.compaction);
              if (
                event.type === "context_compaction_failed" &&
                event.compactionId
              )
                controller.abortCompaction(event.compactionId);
              if (
                controller.isCurrent(requestGeneration) &&
                event.type === "context_updated" &&
                event.contextSnapshot
              ) {
                const selection = controller.snapshot.modelSelection;
                if (selection)
                  controller.setContextSnapshot(
                    {
                      provider: turnModelOptions.provider ?? selection.provider,
                      profileId: turnModelOptions.profile,
                      model:
                        turnModelOptions.model ?? event.contextSnapshot.model,
                      baseUrl: turnModelOptions.baseUrl,
                    },
                    event.contextSnapshot,
                  );
              }
              if (event.type === "provider_response_recovery") {
                controller.discardStreaming();
                hasText = false;
              }
            },
            onText: (text) => {
              if (!controller.isCurrent(requestGeneration) || signal.aborted)
                return;
              controller.appendToLast(text);
              hasText = true;
            },
            onThinking: () => {},
            onToolStart: (name, input, source) => {
              if (!controller.isCurrent(requestGeneration) || signal.aborted)
                return;
              tools.onToolStart?.(name, input, source);
            },
            onToolResult: (name, outcome) => {
              if (!controller.isCurrent(requestGeneration) || signal.aborted)
                return;
              tools.onToolResult?.(name, outcome);
              if (
                [
                  "write_file",
                  "edit_file",
                  "apply_patch",
                  "delete_file",
                  "run_shell",
                  "git_commit",
                ].includes(name)
              )
                for (const tab of workspace.tabs)
                  tab.controller.refreshGitChanges();
            },
          },
          signal,
          { host: extensionHost },
        );
        status = signal.aborted ? "cancelled" : result.status;
        elapsedMs = result.elapsedMs;
        if (!controller.isCurrent(requestGeneration)) return;
        controller.setSessionUsage(result.session, {
          provider: result.session.providerId,
          profileId: result.session.profileId,
          model: result.session.model,
          baseUrl: turnModelOptions.baseUrl,
        });
        controller.setToolActivity();
        if (result.error && !signal.aborted)
          controller.append(result.error, "error");
        else if (!hasText && !signal.aborted)
          controller.append(
            result.text || "Запрос завершён без текстового ответа",
            "assistant",
          );
      } catch (error) {
        status = signal.aborted ? "cancelled" : "failed";
        if (!signal.aborted && controller.isCurrent(requestGeneration))
          controller.append(
            item.kind === "command"
              ? `[extension] /${item.prepared.command.name} · ${item.prepared.command.source.extensionId}: ${safeDiagnostic(error instanceof Error ? error.message : "Command failed.")}`
              : String(error),
            "error",
          );
      } finally {
        execution.activeRun = undefined;
        execution.abort = undefined;
        execution.approvalResolver.cancel();
        if (controller.isCurrent(requestGeneration)) {
          controller.finishRequest(status, elapsedMs);
          controller.setRunningMode();
          controller.setRunningApprovalMode();
          controller.setBusy(execution.pendingOperations.length > 0);
          persistExecutionModes(controller);
        }
        let next = execution.pendingOperations.shift();
        while (next && !controller.isCurrent(next.generation))
          next = execution.pendingOperations.shift();
        if (next && !abort.signal.aborted)
          void executeOperation(controller, next);
      }
    });
    execution.activeRun = work;
    await work;
  };
  process.on("SIGINT", cancel);
  process.once("SIGTERM", shutdown);
  let applicationFailure: unknown;
  let applicationFailed = false;
  const cleanupErrors: unknown[] = [];
  try {
    root.render(
      React.createElement(OpenTuiSpike, {
        onExit: shutdown,
        onCancel: cancel,
        workspace,
        classic,
        sessionPicker,
        settingsActions,
        updater,
        getModelsActions,
        getDefaultModel: () => defaultModel,
        onAgentModeChange: () => persistExecutionModes(currentController()),
        onApprovalModeChange: () => persistExecutionModes(currentController()),
        allowBypassPermissions: bypassAvailable,
        onBypassAvailabilityChange: (allowed) => {
          const saved = pendingSave.then(async () => {
            const current = await loadGlobalConfig();
            await saveGlobalConfig({
              ...current,
              permissions: {
                ...current.permissions,
                allowBypassPermissions: allowed,
              },
            });
            bypassAvailable = allowed;
            if (!allowed) {
              for (const controller of [
                workspace.home,
                ...workspace.tabs.map((tab) => tab.controller),
              ]) {
                for (const queued of workspace.execution(controller)
                  .pendingOperations)
                  if (queued.approvalMode === "bypassPermissions")
                    queued.approvalMode = "default";
                if (controller.snapshot.approvalMode === "bypassPermissions") {
                  controller.setApprovalMode("default");
                  persistExecutionModes(controller);
                }
              }
            }
          });
          pendingSave = saved.catch(() => {});
          return saved;
        },
        skillsActions,
        commandActions,
        getMcpActions: () =>
          getMcpController(currentController().snapshot.projectPath),
        initialSettingsOpen: setupRequired || setupOnly,
        onSetupComplete: setupOnly ? shutdown : undefined,
        onSubmit: submit,
        initialMode: config.ui?.sidebarMode ?? "auto",
        initialTheme: config.ui?.theme ?? "obsidian",
        initialUnicodeDecorations: config.ui?.unicodeDecorations === true,
        onUnicodeDecorationsChange: (unicodeDecorations) => {
          const saved = pendingSave.then(async () => {
            const current = await loadGlobalConfig();
            await saveGlobalConfig({
              ...current,
              ui: { ...current.ui, unicodeDecorations },
            });
          });
          pendingSave = saved.catch(() => {});
          return saved;
        },
        accent: config.ui?.accent,
        onThemeChange: (theme) => {
          const saved = pendingSave.then(async () => {
            const current = await loadGlobalConfig();
            await saveGlobalConfig({
              ...current,
              ui: { ...current.ui, theme },
            });
            currentTheme = theme;
          });
          pendingSave = saved.catch(() => {});
          return saved;
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
    void updater.check();
    await finished;
    await workspace.waitForRuns();
  } catch (error) {
    applicationFailed = true;
    applicationFailure = error;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", shutdown);
    abort.abort();
    workspace.cancelAll();
    await workspace.waitForRuns();
    const cleanup = async (dispose: () => unknown | Promise<unknown>) => {
      try {
        await dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await cleanup(() => root.unmount());
    await cleanup(() => updater.dispose());
    for (const controller of mcpProjects.values()) {
      await cleanup(() => controller.discard());
      await cleanup(() => controller.manager.dispose());
    }
    await cleanup(() => detachScrollback?.());
    await cleanup(detachWorkspace);
    for (const detach of scrollbackDetachments.values()) await cleanup(detach);
    await cleanup(() => workspace.dispose());
    await cleanup(() => renderer.destroy());
    await cleanup(() => pendingSave);
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      applicationFailed
        ? [applicationFailure, ...cleanupErrors]
        : cleanupErrors,
      "Application shutdown failed; all cleanup operations were attempted.",
    );
  if (applicationFailed) throw applicationFailure;
}
