/** @jsxImportSource @opentui/react */

import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import {
  type CapturedCommandModel,
  runSideQueryCommand,
} from "../app/model-command.js";
import {
  captureModelConfiguration,
  captureUnavailableModel,
} from "../app/model-runtime.js";
import { runExtensionCommand } from "../app/run-command.js";
import { subagentControls } from "../app/subagent-inspection.js";
import {
  assertUiToolInvocation,
  prepareUiToolInvocation,
} from "../app/ui-tool.js";
import { BackgroundSettingsStore } from "../background/settings.js";
import {
  checkProviderConnection,
  getModelCapabilities,
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
  loadProjectInstructions,
  updateGlobalConfig,
} from "../config/load.js";
import { backgroundServiceToken } from "../extensions/builtins/background.js";
import { subagentServiceToken } from "../extensions/builtins/subagents.js";
import {
  applicationExtensions,
  withOwnedExtensionHost,
} from "../extensions/composition.js";
import type { ChiselExtension } from "../extensions/contracts.js";
import {
  canonicalWorkspaceRoot,
  type ExtensionHost,
} from "../extensions/host.js";
import { abortable, safeDiagnostic } from "../extensions/lifecycle.js";
import { ExtensionManagementService } from "../extensions/management.js";
import { UiExtensionRuntime } from "../extensions/ui-runtime.js";
import { lspServiceToken } from "../lsp/service.js";
import { LspSettingsStore } from "../lsp/settings.js";
import { McpController } from "../mcp/controller.js";
import { McpConnectionManager } from "../mcp/manager.js";
import { McpConfigStore } from "../mcp/storage.js";
import {
  isModelRequestActive,
  type SideQueryRecord,
} from "../models/contracts.js";
import { ModelRequestService } from "../models/service.js";
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
import { CredentialStore } from "../security/credentials.js";
import { SecretRedactor } from "../security/redaction.js";
import { projectSessionStore } from "../sessions/project-store.js";
import { createSession } from "../sessions/store.js";
import {
  buildActiveSkillsPrompt,
  expandSkill,
  invocableSkills,
  loadSkills,
} from "../skills/skills.js";
import { effectiveSubagentConfig } from "../subagents/config.js";
import { SubagentSettingsStore } from "../subagents/settings.js";
import type { Session, ToolExecutionResult } from "../types/domain.js";
import { resolveProjectDir } from "../utils/paths.js";
import { clipText } from "../utils/text.js";
import { VERSION } from "../version.js";
import { resolveWebConfig } from "../web/schema.js";
import { WebSettingsStore } from "../web/settings.js";
import type { ThemeName } from "./appearance.js";
import {
  appendChatPresentation,
  extensionCommandLabel,
  resultChatPresentation,
} from "./chat-presentation.js";
import { suggestSimilarCommand } from "./commands.js";
import type { InteractiveExitReason } from "./interactive-exit.js";
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
import { loadTerminalDraft, saveTerminalDraft } from "./terminal-drafts.js";
import { FAIL_MARK, OK_MARK } from "./theme.js";
import { toolTranscriptHandlers } from "./tool-transcript.js";
import type { TuiController } from "./tui-controller.js";
import type { QueuedTabOperation } from "./tui-tab-execution.js";
import { TuiWorkspace } from "./tui-workspace.js";
import { UpdateController } from "./update-controller.js";
import { WorkspaceCommands } from "./workspace-commands.js";
import { sameWorktreePath } from "./worktree-actions.js";

/** The sole interactive terminal renderer. */
export async function runOpenTuiAgent(
  options: RunOptions,
  initialSession?: Session,
  setupRequired = false,
  setupOnly = false,
  extensions?: readonly ChiselExtension[],
  rendererFactory: typeof createCliRenderer = createCliRenderer,
): Promise<InteractiveExitReason> {
  return withOwnedExtensionHost(
    extensions ?? (await applicationExtensions(options)),
    (host) =>
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
): Promise<InteractiveExitReason> {
  let activeOptions = { ...options, resume: undefined };
  let config = await loadGlobalConfig(options.configPath);
  let bypassAvailable = config.permissions?.allowBypassPermissions === true;
  let webConfigLive = resolveWebConfig(config.web);
  const webSettingsStore = new WebSettingsStore(options.configPath);
  const uiRuntime = new UiExtensionRuntime(
    options.externalExtensions === false,
    (id) => !extensionHost.hasDefinition(id),
  );
  const extensionManagement = new ExtensionManagementService({
    applyUi: (id) => uiRuntime.changed(id),
    canApplyUi: (id) => uiRuntime.canApply(id),
    configPath: options.configPath,
    externalDisabled: options.externalExtensions === false,
    diagnostics: (root) => [
      ...uiRuntime.diagnostics(root),
      ...extensionHost
        .readyScopes()
        .filter((s) => !root || s.workspaceRoot === root)
        .flatMap((s) => s.externalDiagnostics()),
    ],
    scopeReady: (root) =>
      extensionHost.readyScopes().some((s) => s.workspaceRoot === root),
  });
  const initialRoot = await canonicalWorkspaceRoot(
    options.cwd ?? process.cwd(),
  );
  const projectConfig = await loadProjectConfig(initialRoot);
  const initialApprovalMode = resolveApprovalMode({
    ...options,
    saved: initialSession?.approvalMode,
    autoApprove: projectConfig.autoApprove,
    allowBypassPermissions: bypassAvailable,
  });
  const workspace = new TuiWorkspace(
    initialRoot,
    options.mode ?? DEFAULT_AGENT_MODE,
    initialApprovalMode,
  );
  if (initialSession) {
    if (
      initialSession.sideQueries?.some((record) =>
        isModelRequestActive(record.status),
      )
    ) {
      initialSession = await (
        await projectSessionStore(initialSession.projectPath)
      ).interruptSideQueries(initialSession.id);
    }
    workspace.openSession(initialSession);
  }
  const restoredDraft = await loadTerminalDraft(
    workspace.controller.snapshot.projectPath,
    workspace.controller.snapshot.sessionId,
  ).catch(() => undefined);
  if (restoredDraft !== undefined) {
    workspace.controller.setDraft(restoredDraft);
    workspace.controller.presentation.history.value = restoredDraft;
    workspace.controller.presentation.history.cursor = restoredDraft.length;
  }
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
  const uiRedactor = new SecretRedactor();
  for (const provider of catalog.registry.list())
    for (const name of provider.auth.envVars) {
      const value = process.env[name]?.trim();
      if (value) uiRedactor.add(value);
    }
  const credentials = new CredentialStore();
  for (const profile of Object.values(config.profiles)) {
    if (!profile.apiKeyRef) continue;
    try {
      const value = await credentials.get(profile.apiKeyRef);
      if (value) uiRedactor.add(value);
    } catch {
      /* Settings retains the existing credential error path. */
    }
  }
  const modelService = new ModelRequestService();
  let sideOperations = 0;
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
      request = getModelCapabilities(
        {
          provider: selection.provider,
          profileId: selection.profileId,
          model: selection.model,
          baseUrl: selection.baseUrl,
        },
        { configPath: options.configPath },
      );
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
  let currentTheme: ThemeName = config.ui?.theme ?? "obsidian";
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
  const openingRoots = new Set<string>();
  const closingScopes = new Set<Promise<void>>();
  const closingRoots = new Set<string>();
  const releaseUnusedScopes = () => {
    const rootKey = (value: string) =>
      process.platform === "win32" ? resolve(value).toLowerCase() : value;
    const roots = new Set(
      [
        workspace.home.snapshot.projectPath,
        ...workspace.tabs.map((tab) => tab.controller.snapshot.projectPath),
        ...openingRoots,
      ].map(rootKey),
    );
    for (const scope of extensionHost.readyScopes()) {
      if (
        roots.has(rootKey(scope.workspaceRoot)) ||
        closingRoots.has(scope.workspaceRoot)
      )
        continue;
      closingRoots.add(scope.workspaceRoot);
      const work = Promise.all([
        extensionHost.closeWorkspace(scope.workspaceRoot),
        uiRuntime.closeWorkspace(scope.workspaceRoot),
      ]).then(() => {});
      closingScopes.add(work);
      void work
        .catch((error) =>
          workspace.controller.append(safeDiagnostic(error), "error"),
        )
        .finally(() => {
          closingRoots.delete(scope.workspaceRoot);
          closingScopes.delete(work);
        });
    }
  };
  const syncScrollback = () => {
    if (!classic) return;
    for (const tab of workspace.tabs) {
      if (!scrollbackDetachments.has(tab.controller))
        scrollbackDetachments.set(
          tab.controller,
          attachTranscriptScrollback(tab.controller, renderer, () =>
            extensionHost.themes.palette(currentTheme, config.ui?.accent),
          ),
        );
    }
  };
  const detachWorkspace = workspace.subscribe(() => {
    syncScrollback();
    releaseUnusedScopes();
  });
  syncScrollback();
  const detachScrollback = classic
    ? attachTranscriptScrollback(workspace.home, renderer, () =>
        extensionHost.themes.palette(currentTheme, config.ui?.accent),
      )
    : undefined;
  const root = createRoot(renderer);
  const abort = new AbortController();
  const commandActions = new WorkspaceCommands(
    extensionHost,
    abort.signal,
    uiRuntime,
  );
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
    const session = await store.interruptSideQueries(
      (await store.resolve(ref)).id,
    );
    const project = await loadProjectConfig(session.projectPath);
    session.approvalMode = resolveApprovalMode({
      saved: session.approvalMode,
      autoApprove: project.autoApprove,
      allowBypassPermissions: bypassAvailable,
    });
    const scope = await extensionHost.open(session.projectPath);
    const controller = workspace.openSession(session, scope.chat);
    const draft = await loadTerminalDraft(
      session.projectPath,
      session.id,
    ).catch(() => undefined);
    if (draft !== undefined && !controller.snapshot.draft)
      controller.setDraft(draft);
    persistExecutionModes(controller);
    await restoreSubagentControls(controller, session);
    warmModelCapabilities(controller);
  };
  const restoreSubagentControls = async (
    controller: TuiController,
    session: Session,
  ) => {
    if (
      session.backgroundTasks &&
      Object.keys(session.backgroundTasks).length
    ) {
      const root = controller.snapshot.projectPath;
      const generation = controller.currentGeneration;
      const scope = await extensionHost.open(root);
      const service = scope.services.lookup(backgroundServiceToken);
      if (service) {
        await service.bind({
          session,
          store: await projectSessionStore(root),
          root: scope.workspaceRoot,
          conversationId: controller.conversationId,
          generation,
          signal: controller.ownerSignal,
          assertAvailable: () => {
            scope.assertUsable();
            if (!controller.isCurrent(generation))
              throw new Error("Разговор заменён.");
          },
          scope,
          config: await loadProjectConfig(root),
          global: await loadGlobalConfig(options.configPath),
          configPath: options.configPath,
          interactive: true,
          redactor: new SecretRedactor(),
          currentMode: () => controller.snapshot.agentMode,
          onEvent: (event) => {
            if (controller.isCurrent(generation))
              controller.acceptBackground(event);
          },
        });
        const controls = service.controls(session.id, generation);
        controller.setBackgroundControls(controls);
        workspace.execution(controller).backgroundControls = controls;
        for (const task of await controls.port.list())
          controller.acceptBackground({
            type: "changed",
            ownerId: session.id,
            task,
            presentation: task.presentation,
          });
      }
    }
    if (!session.children || !Object.keys(session.children).length) return;
    const generation = controller.currentGeneration;
    const root = controller.snapshot.projectPath;
    const scope = await extensionHost.open(root);
    const service = scope.services.lookup(subagentServiceToken);
    if (!service) return;
    const global = await loadGlobalConfig(options.configPath);
    const project = await loadProjectConfig(root);
    let capturedModel: import("../app/model-runtime.js").CapturedModelConfiguration;
    try {
      capturedModel = captureModelConfiguration(
        global,
        catalog.registry,
        modelOptions(controller),
        session,
      );
    } catch {
      capturedModel = captureUnavailableModel(catalog.registry, session);
    }
    const binding = {
      session,
      store: await projectSessionStore(root),
      root: scope.workspaceRoot,
      conversationId: controller.conversationId,
      generation,
      signal: controller.ownerSignal,
      assertAvailable: () => {
        if (!controller.isCurrent(generation))
          throw new Error("Разговор заменён.");
        scope.assertUsable();
      },
      scope,
      capturedModel,
      config: project,
      global,
      options: { ...options, interactive: true },
      approvalMode: controller.snapshot.approvalMode,
      resolver: workspace.execution(controller).approvalResolver,
      redactor: new SecretRedactor(),
      instructions: await loadProjectInstructions(root),
      onEvent: (event: import("../subagents/contracts.js").SubagentEvent) => {
        if (controller.isCurrent(generation)) controller.acceptSubagent(event);
      },
    };
    await service.bind(binding);
    const controls = subagentControls(service, binding);
    controller.setSubagentControls(controls);
    workspace.execution(controller).subagentControls = controls;
    for (const child of await controls.port.list())
      controller.acceptSubagent({
        type: "changed",
        ownerId: session.id,
        child,
        presentation: scope.chat.render(child.extensionId, "task", { child }),
      });
  };
  const sessionPicker: OpenTuiSessionsActions = {
    load: async () =>
      (await (await sessionStore()).list()).filter(
        (item) => !item.subagentOwnerId,
      ),
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
  const getSettingsActions = (): OpenTuiSettingsActions => {
    const owner = currentController();
    const generation = owner.currentGeneration;
    const root = owner.snapshot.projectPath;
    // A Settings dialog opened on home keeps the conversation allocated by its first operation.
    let operationOwner = owner;
    let operationGeneration = generation;
    const lsp = new LspSettingsStore(root, options.configPath, {
      status: async () => {
        try {
          const scope = extensionHost
            .readyScopes()
            .find((s) => s.workspaceRoot === root);
          const service = scope?.services.lookup(lspServiceToken);
          if (service) return service.status();
        } catch {
          /* Existing navigation stays available if an extension activation fails. */
        }
        return {
          workspaceRoot: root,
          backend: "typescript",
          state: "unavailable",
          generation: 0,
          trackedDocuments: 0,
          requiresRestart: false,
          reason: "LSP extension недоступен в этой composition.",
        };
      },
      apply: async () => {
        await Promise.all(
          extensionHost
            .readyScopes()
            .map((scope) =>
              scope.services.lookup(lspServiceToken)?.refreshConfiguration(),
            ),
        );
      },
      restart: (id) =>
        new Promise<ToolExecutionResult>((resolveResult) => {
          if (
            !owner.isCurrent(generation) ||
            owner.snapshot.projectPath !== root ||
            !operationOwner.isCurrent(operationGeneration) ||
            operationOwner.snapshot.projectPath !== root ||
            (operationOwner !== workspace.home &&
              !workspace.tabs.some((tab) => tab.controller === operationOwner))
          ) {
            resolveResult({
              output: "Settings workspace changed; reopen Settings.",
              isError: true,
              errorCode: "CANCELLED",
            });
            return;
          }
          void submit(
            `/lsp-restart${id ? ` ${id}` : ""}`,
            operationOwner,
            operationOwner.snapshot.agentMode,
            operationOwner.snapshot.approvalMode,
            { ...modelOptions(operationOwner) },
            (result) => {
              if (
                operationOwner === workspace.home &&
                homeOperationTarget?.generation === generation &&
                homeOperationTarget.root === root
              ) {
                operationOwner = homeOperationTarget.controller;
                operationGeneration = operationOwner.currentGeneration;
              }
              resolveResult(result);
            },
          ).catch(() =>
            resolveResult({
              output: "LSP restart could not be queued.",
              isError: true,
              errorCode: "TOOL_EXECUTION_FAILURE",
            }),
          );
        }),
    });
    return {
      extensions: extensionManagement,
      background: new BackgroundSettingsStore(root, options.configPath),
      subagents: new SubagentSettingsStore(
        root,
        options.configPath,
        async () => {
          const global = await loadGlobalConfig(options.configPath);
          for (const scope of extensionHost.readyScopes()) {
            const project = await loadProjectConfig(scope.workspaceRoot);
            await scope.services
              .lookup(subagentServiceToken)
              ?.applyConfiguration(
                scope.workspaceRoot,
                effectiveSubagentConfig(global.subagents, project.subagents),
              );
          }
        },
      ),
      lsp,
      workspaceRoot: root,
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
        profiles: (await loadGlobalConfig(options.configPath)).profiles,
      }),
      load: async (profileId) => {
        const current = await loadGlobalConfig(options.configPath);
        const selection = profileId
          ? { profile: profileId }
          : modelOptions(owner);
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
        const current = await loadGlobalConfig(options.configPath);
        return settingsKeyReady(
          catalog.registry,
          profileId
            ? (current.profiles[profileId] ?? { providerId: provider })
            : { providerId: provider },
        );
      },
      save: async (values) => {
        if (values.apiKey?.trim()) uiRedactor.add(values.apiKey.trim());
        const outcome = await saveProviderSettings(values, catalog.registry, {
          configPath: options.configPath,
        });
        config = await loadGlobalConfig(options.configPath);
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
        if (!owner.isCurrent(generation)) return outcome;
        owner.setActiveModel(
          values.provider,
          values.model,
          profile,
          values.baseUrl,
        );
        warmModelCapabilities(owner);
        return outcome;
      },
      check: async (values) => {
        const result = await checkProviderConnection(values, {
          configPath: options.configPath,
        });
        return `${result.ok ? OK_MARK : FAIL_MARK} ${result.message}`;
      },
      models: async (values) => {
        const result = await listProviderModels(values, {
          configPath: options.configPath,
        });
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
  };

  const getModelsActions = (): OpenTuiModelsActions => {
    const controller = currentController();
    const generation = controller.currentGeneration;
    return {
      load: async () => {
        const currentConfig = await loadGlobalConfig(options.configPath);
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
          : await listProviderModels(selection, {
              configPath: options.configPath,
            });
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
        const currentConfig = await loadGlobalConfig(options.configPath);
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
  const getSkillsActions = (
    controller = currentController(),
  ): OpenTuiSkillsActions => {
    const generation = controller.currentGeneration;
    const assertOwner = () => {
      if (!controller.isCurrent(generation))
        throw new Error(
          "Беседа навыков уже изменилась. Откройте библиотеку заново.",
        );
    };
    return {
      load: () => {
        assertOwner();
        return loadSkills(controller.snapshot.projectPath);
      },
      activeNames: () => {
        assertOwner();
        return [...activeSkills(controller)];
      },
      toggle: (name) => {
        assertOwner();
        const activeSkillNames = activeSkills(controller);
        if (activeSkillNames.has(name)) activeSkillNames.delete(name);
        else activeSkillNames.add(name);
        controller.append(
          `Скилл /${name} ${activeSkillNames.has(name) ? "закреплён для этой вкладки" : "откреплён"}`,
          "info",
        );
      },
      editSource: (name) => {
        assertOwner();
        const skill = loadSkills(controller.snapshot.projectPath).find(
          (item) => item.name === name && item.source === "user",
        );
        if (!skill)
          throw new Error("Пользовательский скилл больше не доступен.");
        const file = join(skill.dir, "SKILL.md");
        const info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("Не удалось безопасно открыть инструкции скилла.");
        return readFileSync(file, "utf8");
      },
    };
  };
  const skillsActions: OpenTuiSkillsActions = {
    load: () => getSkillsActions().load(),
    activeNames: () => getSkillsActions().activeNames(),
    toggle: (name) => getSkillsActions().toggle(name),
    editSource: (name) => getSkillsActions().editSource?.(name) ?? "",
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
        windowsUpdateArguments(resolve(projectPath), sessionId, {
          parentPid: process.pid,
          installDirectory: dirname(process.execPath),
        }),
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
    onCommandResult?: (result: ToolExecutionResult) => void,
  ): Promise<void> => {
    let resultAttached = false;
    try {
      let controller = target;
      const originGeneration = controller.currentGeneration;
      const originRoot = controller.snapshot.projectPath;
      const priorHomeOperationTarget = homeOperationTarget;
      const acceptedAt = Date.now();
      const conversationCapture = controller.conversation.capture();
      let capturedModel:
        | ReturnType<typeof captureModelConfiguration>
        | undefined;
      try {
        capturedModel = captureModelConfiguration(
          config,
          catalog.registry,
          { ...options, ...turnModelOptions },
          undefined,
          controller.snapshot.modelCapabilities,
        );
      } catch {
        /* Only a model consumer reports missing configuration. */
      }
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
        controller.setDraft("/cwd ");
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
        descriptor?.source.type === "skill"
          ? descriptor.source.name
          : undefined;
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
            `${extensionCommandLabel(command)}: неверные аргументы.${command.usage ? ` Использование: ${safeDiagnostic(command.usage)}` : ""}`,
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
          prepared?.command.executionPolicy === "side_query"
            ? "Побочный вопрос"
            : clipText(input.split("\n", 1)[0] ?? input, 120),
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
      if (parsed?.name === "/tasks" && !parsed.args.trim()) {
        controller.showBackground();
        return;
      }
      const controlAction =
        prepared?.input &&
        typeof prepared.input === "object" &&
        "action" in prepared.input
          ? String(prepared.input.action)
          : undefined;
      if (
        prepared?.command.controlActions?.includes(controlAction ?? "") &&
        prepared.command.executeControl &&
        snapshot?.scope &&
        controller.subagentControls
      ) {
        const origin = controller;
        const generation = origin.currentGeneration;
        const selected = prepared;
        try {
          snapshot.scope.assertUsable();
          if (
            snapshot.scope.commands.get(selected.command.name) !==
            selected.command
          )
            throw new Error("Команда изменилась.");
          const result = await selected.command.executeControl!(
            {
              workspaceRoot: origin.snapshot.projectPath,
              sessionId: origin.snapshot.sessionId!,
              signal: origin.ownerSignal,
              subagents: origin.subagentControls!.port,
              background: origin.backgroundControls?.port,
            },
            selected.input,
          );
          if (origin.isCurrent(generation)) {
            const presentation = resultChatPresentation(result);
            if (presentation && !result.isError && !result.requiresApproval)
              appendChatPresentation(origin, presentation);
            else
              origin.append(result.output, result.isError ? "error" : "info");
          }
        } catch (error) {
          if (origin.isCurrent(generation))
            origin.append(
              error instanceof Error ? error.message : String(error),
              "error",
            );
        }
        return;
      }
      if (
        prepared?.command.executionPolicy === "side_query" &&
        snapshot?.scope
      ) {
        if (!capturedModel) {
          controller.setSideNotice(
            "Настройте выбранный сервис и модель для побочного вопроса.",
          );
          controller.openSide();
          return;
        }
        const execution = workspace.execution(controller);
        if (execution.sideRuns.size || sideOperations >= 4) {
          controller.setSideNotice(
            execution.sideRuns.size
              ? "Побочный вопрос уже выполняется. Остановите ответ или дождитесь завершения."
              : "Достигнут лимит побочных запросов приложения.",
          );
          controller.setSideDraft(parsed?.args ?? input);
          return;
        }
        const selectedModel = capturedModel;
        const selectedCommand = prepared;
        const operationId = randomUUID();
        const generation = controller.currentGeneration;
        const sideAbort = new AbortController();
        const deadline = AbortSignal.timeout(
          Math.max(1, acceptedAt + 120_000 - Date.now()),
        );
        const signal = AbortSignal.any([
          abort.signal,
          controller.ownerSignal,
          sideAbort.signal,
          deadline,
        ]);
        controller.setSideNotice();
        controller.setSidePending(true);
        controller.openSide(operationId);
        sideOperations++;
        const scope = snapshot.scope;
        const assertAvailable = () => {
          if (!controller.isCurrent(generation) || signal.aborted)
            throw new Error("Side operation is closed.");
        };
        let latest: Readonly<SideQueryRecord> | undefined;
        let renderTimer: ReturnType<typeof setTimeout> | undefined;
        const flush = () => {
          if (renderTimer) clearTimeout(renderTimer);
          renderTimer = undefined;
          if (latest && controller.isCurrent(generation))
            controller.receiveSide(latest);
        };
        const captured: CapturedCommandModel = {
          model: capturedModel,
          capture: conversationCapture,
          acceptedAt,
          conversationId: controller.conversationId,
          generation,
          invocationId: operationId,
          assertAvailable,
          onRecord: (record) => {
            if (!controller.isCurrent(generation)) return;
            latest = record;
            if (
              !isModelRequestActive(record.status) ||
              !controller.snapshot.sideView?.visible
            )
              flush();
            else renderTimer ??= setTimeout(flush, 40);
          },
        };
        const allocatedSession = controller.conversation.allocate(async () => {
          assertAvailable();
          const store = await projectSessionStore(scope.workspaceRoot);
          assertAvailable();
          const session = createSession(
            scope.workspaceRoot,
            selectedModel.definition.id,
            selectedModel.model,
          );
          session.profileId = selectedModel.profileId;
          session.mode = turnMode;
          session.approvalMode = turnApprovalMode;
          await store.save(session);
          if (controller.isCurrent(generation))
            controller.setSessionId(session.id);
          return session;
        });
        const work = Promise.resolve().then(async () => {
          try {
            assertAvailable();
            const pendingSession = allocatedSession;
            const sessionId = pendingSession
              ? await abortable(() => pendingSession, signal)
              : controller.snapshot.sessionId;
            assertAvailable();
            const result = await runSideQueryCommand(
              selectedCommand,
              scope,
              {
                ...options,
                ...turnModelOptions,
                cwd: originRoot,
                resume: sessionId,
                mode: turnMode,
                approvalMode: turnApprovalMode,
              },
              captured,
              modelService,
              signal,
            );
            if (!controller.isCurrent(generation)) return;
            if (result.result.error && !latest)
              controller.setSideNotice(result.result.error.message);
            controller.setSessionId(result.sessionId);
            const store = await projectSessionStore(scope.workspaceRoot);
            const saved = await store.load(result.sessionId);
            if (controller.isCurrent(generation) && saved) {
              controller.setSessionUsage(saved);
              if (!execution.activeRun) controller.conversation.restore(saved);
            }
          } catch {
            if (controller.isCurrent(generation))
              controller.setSideNotice(
                signal.aborted
                  ? deadline.aborted
                    ? "Превышено время ожидания побочного ответа."
                    : "Побочный ответ остановлен."
                  : "Не удалось получить побочный ответ. Проверьте выбранный сервис и доступность модели.",
              );
          } finally {
            flush();
            execution.sideRuns.delete(operationId);
            sideOperations--;
            if (controller.isCurrent(generation))
              controller.setSidePending(false);
          }
        });
        execution.sideRuns.set(operationId, {
          abort: sideAbort,
          promise: work,
        });
        await work;
        return;
      }
      const item: QueuedTabOperation =
        prepared && snapshot?.scope
          ? {
              kind: "command",
              onResult: onCommandResult,
              input,
              prepared,
              capturedModel: capturedModel
                ? {
                    model: capturedModel,
                    capture: conversationCapture,
                    acceptedAt,
                    conversationId: controller.conversationId,
                    generation: controller.currentGeneration,
                    assertAvailable: () => {
                      if (!controller.isCurrent(item.generation))
                        throw new Error("Command owner is closed.");
                    },
                  }
                : undefined,
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
      resultAttached = item.kind === "command";
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
    } finally {
      if (onCommandResult && !resultAttached)
        onCommandResult({
          output: "LSP command unavailable or workspace changed.",
          isError: true,
          errorCode: "CANCELLED",
        });
    }
  };
  const executeOperation = async (
    controller: TuiController,
    item: QueuedTabOperation,
  ): Promise<void> => {
    if (
      abort.signal.aborted ||
      !controller.isCurrent(item.generation) ||
      controller.snapshot.projectPath !== item.root
    ) {
      if (item.kind !== "prompt")
        item.onResult?.({
          output: "Разговор изменён или закрыт.",
          isError: true,
          errorCode: "CANCELLED",
        });
      return;
    }
    const quiet = item.kind !== "prompt" && item.quiet === true;
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
    const signal = AbortSignal.any([
      abort.signal,
      turnAbort.signal,
      controller.ownerSignal,
    ]);
    controller.conversation.begin(item.kind === "prompt" ? input : undefined);
    controller.startRequest();
    controller.setRunningMode(turnMode);
    controller.setRunningApprovalMode(turnApprovalMode);
    if (!quiet) controller.append(`> ${input}`, "user");
    const tools = toolTranscriptHandlers(() => controller);
    const presentedToolResults = new Set<string>();
    // Install the owner before any provider callback can complete the request.
    const work = Promise.resolve().then(async () => {
      let status: "completed" | "failed" | "cancelled" | "approval_required" =
        "failed";
      let elapsedMs: number | undefined;
      try {
        const pendingSession = controller.conversation.pendingSession();
        // A first foreground prompt allocates its own session via onConversation;
        // only wait here when a side operation already owns the allocation.
        if (controller.snapshot.sidePending && pendingSession)
          controller.setSessionId(
            await abortable(() => pendingSession, signal),
          );
        if (item.kind !== "prompt") {
          const snapshot = await commandActions.load(item.root, signal);
          const descriptor =
            item.kind === "ui_tool"
              ? undefined
              : resolveSlashCommand(snapshot.projection, input);
          if (!controller.isCurrent(requestGeneration) || signal.aborted)
            return;
          if (
            snapshot.error ||
            snapshot.scope !== item.scope ||
            (item.kind === "ui_tool"
              ? !assertUiToolInvocation(item.prepared, item.scope)
              : descriptor?.source.type !== "extension" ||
                descriptor.source.extensionId !==
                  item.prepared.command.source.extensionId ||
                descriptor.source.name !== item.prepared.command.name)
          ) {
            controller.append(
              snapshot.error ??
                "Команда больше не принадлежит выбранному расширению.",
              "error",
            );
            return;
          }
          const heading =
            item.kind === "ui_tool"
              ? "Действие интерфейса"
              : extensionCommandLabel(item.prepared.command);
          if (!quiet) controller.append(heading, "tool");
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
              subagentOwner: {
                conversationId: controller.conversationId,
                modelOptions: () => modelOptions(controller),
                generation: requestGeneration,
                signal: controller.ownerSignal,
                assertAvailable: () => {
                  if (!controller.isCurrent(requestGeneration))
                    throw new Error("Разговор заменён.");
                },
              },
              isBypassAllowed: () => bypassAvailable,
              getWebConfig: () => webConfigLive,
              mcpManager: getMcpController(item.root).manager,
            },
            execution.approvalResolver,
            {
              onBackground: (event) => {
                if (controller.isCurrent(requestGeneration))
                  controller.acceptBackground(event);
              },
              onBackgroundControls: (controls) => {
                if (controller.isCurrent(requestGeneration)) {
                  execution.backgroundControls = controls;
                  controller.setBackgroundControls(controls);
                }
              },
              onSubagent: (event) => {
                if (controller.isCurrent(requestGeneration))
                  controller.acceptSubagent(event);
              },
              onSubagentControls: (controls) => {
                if (controller.isCurrent(requestGeneration)) {
                  execution.subagentControls = controls;
                  controller.setSubagentControls(controls);
                }
              },
              onOpenWorktree: async (descriptor) => {
                if (
                  (descriptor.kind !== "origin" &&
                    (!descriptor.id || descriptor.readOnly)) ||
                  !controller.isCurrent(requestGeneration) ||
                  signal.aborted
                )
                  throw new Error("Worktree opening is no longer current.");
                const existing = workspace.tabs.find((tab) =>
                  sameWorktreePath(
                    tab.controller.snapshot.projectPath,
                    descriptor.path,
                  ),
                );
                if (existing) {
                  workspace.select(existing.key);
                  return;
                }
                openingRoots.add(descriptor.path);
                try {
                  // Activation obtains the durable use lease before allocating
                  // a tab/session; it also gives this root independent LSP state.
                  const worktreeScope = await extensionHost.open(
                    descriptor.path,
                  );
                  if (
                    !controller.isCurrent(requestGeneration) ||
                    signal.aborted
                  )
                    throw new Error("Worktree opening cancelled.");
                  const selected = controller.snapshot.modelSelection;
                  const session = createSession(
                    worktreeScope.workspaceRoot,
                    selected?.provider ??
                      homeModel.provider ??
                      catalog.registry.list()[0]?.id ??
                      "openai",
                    selected?.model ?? homeModel.model ?? "",
                  );
                  session.title = descriptor.label;
                  session.titleSource = "user";
                  if (descriptor.id && descriptor.base && descriptor.origin)
                    session.worktree = {
                      id: descriptor.id,
                      label: descriptor.label,
                      base: descriptor.base,
                      origin: descriptor.origin,
                    };
                  session.mode = turnMode;
                  session.approvalMode = turnApprovalMode;
                  if (selected?.profileId)
                    session.profileId = selected.profileId;
                  await (
                    await projectSessionStore(worktreeScope.workspaceRoot)
                  ).save(session);
                  if (
                    !controller.isCurrent(requestGeneration) ||
                    signal.aborted
                  )
                    throw new Error("Worktree opening cancelled.");
                  const tab = workspace.openSession(session);
                  tab.append(
                    descriptor.kind === "origin"
                      ? `Основной проект: ${descriptor.label}\n${descriptor.path}`
                      : `Рабочая копия: ${descriptor.label}\nID: ${descriptor.id}\nBase: ${descriptor.base}\n${descriptor.path}\nDetached HEAD · файлы и Session изолированы`,
                    "info",
                  );
                } finally {
                  openingRoots.delete(descriptor.path);
                  releaseUnusedScopes();
                }
              },
              onConversation: (source) => {
                if (controller.isCurrent(requestGeneration)) {
                  controller.conversation.bind(source);
                  controller.setSessionId(source.sessionId);
                }
              },
              onEvent: (event) => {
                if (!controller.isCurrent(requestGeneration) || signal.aborted)
                  return;
                if (quiet) {
                  if (event.type === "checkpoint_saved")
                    controller.setSessionId(event.sessionId);
                  return;
                }
                controller.trackToolEvent(event);
                if (event.type === "checkpoint_saved")
                  controller.setSessionId(event.sessionId);
                if (event.type === "tool_progress" && !event.invocationId)
                  controller.setToolActivity(
                    `${event.name ?? "MCP"} · ${event.text ?? "Выполняется"}`,
                  );
              },
              onToolStart: (name, input, source, invocationId) => {
                if (
                  !quiet &&
                  controller.isCurrent(requestGeneration) &&
                  !signal.aborted
                )
                  tools.onToolStart?.(name, input, source, invocationId);
              },
              onToolResult: (name, result, invocationId) => {
                if (!controller.isCurrent(requestGeneration) || signal.aborted)
                  return;
                if (result.presentation)
                  presentedToolResults.add(JSON.stringify(result.presentation));
                if (!quiet) tools.onToolResult?.(name, result, invocationId);
                if (result.diffs?.length || result.fileDiff)
                  for (const tab of workspace.tabs)
                    tab.controller.refreshGitChanges();
              },
            },
            signal,
            {
              service: modelService,
              captured: item.capturedModel,
              recordPresentation: !quiet,
            },
          );
          item.onResult?.(outcome.result);
          item.onResult = undefined;
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
          if (quiet) return;
          const presentation = resultChatPresentation(outcome.result);
          if (
            presentation &&
            !outcome.result.isError &&
            !outcome.result.requiresApproval
          ) {
            if (!presentedToolResults.has(JSON.stringify(presentation)))
              appendChatPresentation(controller, presentation);
          } else if (
            !presentation ||
            outcome.result.isError ||
            outcome.result.requiresApproval
          )
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
        controller.conversation.begin(prompt);
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
            subagentOwner: {
              conversationId: controller.conversationId,
              modelOptions: () => modelOptions(controller),
              generation: requestGeneration,
              signal: controller.ownerSignal,
              assertAvailable: () => {
                if (!controller.isCurrent(requestGeneration))
                  throw new Error("Разговор заменён.");
              },
            },
            isBypassAllowed: () => bypassAvailable,
            getWebConfig: () => webConfigLive,
            mcpManager: getMcpController(controller.snapshot.projectPath)
              .manager,
          },
          execution.approvalResolver,
          {
            onBackground: (event) => {
              if (controller.isCurrent(requestGeneration))
                controller.acceptBackground(event);
            },
            onBackgroundControls: (controls) => {
              if (controller.isCurrent(requestGeneration)) {
                execution.backgroundControls = controls;
                controller.setBackgroundControls(controls);
              }
            },
            onSubagent: (event) => {
              if (controller.isCurrent(requestGeneration))
                controller.acceptSubagent(event);
            },
            onSubagentControls: (controls) => {
              if (controller.isCurrent(requestGeneration)) {
                execution.subagentControls = controls;
                controller.setSubagentControls(controls);
              }
            },
            onConversation: (source) => {
              if (controller.isCurrent(requestGeneration)) {
                controller.conversation.bind(source);
                controller.setSessionId(source.sessionId);
              }
            },
            onEvent: (event) => {
              if (!controller.isCurrent(requestGeneration) || signal.aborted)
                return;
              controller.trackToolEvent(event);
              if (event.type === "checkpoint_saved")
                controller.setSessionId(event.sessionId);
              if (event.type === "tool_progress" && !event.invocationId)
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
            onToolStart: (name, input, source, invocationId) => {
              if (!controller.isCurrent(requestGeneration) || signal.aborted)
                return;
              tools.onToolStart?.(name, input, source, invocationId);
            },
            onToolResult: (name, outcome, invocationId) => {
              if (!controller.isCurrent(requestGeneration) || signal.aborted)
                return;
              tools.onToolResult?.(name, outcome, invocationId);
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
              ? `${extensionCommandLabel(item.prepared.command)}: ${safeDiagnostic(error instanceof Error ? error.message : "Command failed.")}`
              : String(error),
            "error",
          );
      } finally {
        if (item.kind !== "prompt") {
          item.onResult?.({
            output: signal.aborted
              ? "Command cancelled."
              : "Command failed or changed ownership.",
            isError: true,
            errorCode: signal.aborted ? "CANCELLED" : "TOOL_EXECUTION_FAILURE",
          });
          item.onResult = undefined;
        }
        if (controller.isCurrent(requestGeneration))
          controller.conversation.complete();
        execution.activeRun = undefined;
        execution.abort = undefined;
        execution.approvalResolver.cancel("foreground");
        if (controller.isCurrent(requestGeneration)) {
          controller.finishRequest(status, elapsedMs);
          controller.setRunningMode();
          controller.setRunningApprovalMode();
          controller.setBusy(execution.pendingOperations.length > 0);
          persistExecutionModes(controller);
        }
        let next = execution.pendingOperations.shift();
        while (next && !controller.isCurrent(next.generation)) {
          if (next.kind !== "prompt")
            next.onResult?.({
              output: "Queued workspace generation changed.",
              isError: true,
              errorCode: "CANCELLED",
            });
          next = execution.pendingOperations.shift();
        }
        if (next && !abort.signal.aborted)
          void executeOperation(controller, next);
      }
    });
    execution.activeRun = work;
    await work;
  };
  process.on("SIGINT", cancel);
  if (initialSession)
    await restoreSubagentControls(workspace.controller, initialSession);
  process.once("SIGTERM", shutdown);
  let applicationFailure: unknown;
  let applicationFailed = false;
  const cleanupErrors: unknown[] = [];
  try {
    await extensionHost.open(currentController().snapshot.projectPath);
    if (!extensionHost.themes.get(currentTheme)) {
      currentTheme = "obsidian";
      currentController().appendNotice(
        "Выбранная тема расширения недоступна. Используется Obsidian; проверьте расширение и перезапустите ChiselCode после изменения его состояния.",
        "info",
      );
    }
    if (extensionHost.themes.diagnostics.length)
      currentController().appendNotice(
        "Некоторые темы расширений отклонены: палитра неполная или недостаточно читаемая. Остальные темы доступны.",
        "info",
      );
    root.render(
      React.createElement(OpenTuiSpike, {
        onExit: shutdown,
        onCancel: cancel,
        onSideCancel: () =>
          workspace.execution(currentController()).cancelSides(),
        workspace,
        classic,
        sessionPicker,
        getSettingsActions,
        updater,
        getModelsActions,
        getDefaultModel: () => defaultModel,
        onAgentModeChange: () => persistExecutionModes(currentController()),
        onApprovalModeChange: () => persistExecutionModes(currentController()),
        allowBypassPermissions: bypassAvailable,
        onBypassAvailabilityChange: (allowed) => {
          const saved = pendingSave.then(async () => {
            await updateGlobalConfig(options.configPath, (current) => ({
              ...current,
              permissions: {
                ...current.permissions,
                allowBypassPermissions: allowed,
              },
            }));
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
        getSkillsActions,
        commandActions,
        getWorktreeActions: () => {
          const target = currentController();
          const generation = target.currentGeneration;
          const root = target.snapshot.projectPath;
          const assertOwner = () => {
            if (
              abort.signal.aborted ||
              !target.isCurrent(generation) ||
              target.ownerSignal.aborted ||
              target.snapshot.projectPath !== root
            )
              throw new Error("Разговор изменён или закрыт.");
          };
          return {
            root,
            owner: `${target.conversationId}:${generation}`,
            mode: target.snapshot.agentMode,
            run: async (action, input = {}) => {
              assertOwner();
              const snapshot = await commandActions.load(
                root,
                target.ownerSignal,
              );
              assertOwner();
              const command = snapshot.scope?.commands.get("worktree");
              if (
                !snapshot.scope ||
                !command ||
                command.source.extensionId !== "builtin.worktrees"
              )
                throw new Error(
                  "Менеджер рабочих копий недоступен для этого проекта.",
                );
              const scope = snapshot.scope;
              return new Promise<ToolExecutionResult>((resolve) => {
                const operation: QueuedTabOperation = {
                  kind: "command",
                  quiet: true,
                  input: `/worktree ${action}`,
                  prepared: {
                    command,
                    input: { ...structuredClone(input), action },
                  },
                  scope,
                  root,
                  generation,
                  mode: target.snapshot.agentMode,
                  approvalMode: target.snapshot.approvalMode,
                  modelOptions: modelOptions(target),
                  onResult: resolve,
                };
                const execution = workspace.execution(target);
                if (execution.activeRun) {
                  execution.pendingOperations.push(operation);
                  target.setBusy(true);
                } else void executeOperation(target, operation);
              });
            },
            tabs: () =>
              workspace.tabs.map((tab) => ({
                key: tab.key,
                label:
                  tab.controller.snapshot.sessionTitle ??
                  tab.controller.snapshot.projectPath,
                path: tab.controller.snapshot.projectPath,
                busy: workspace.execution(tab.controller).closeBlocked,
                stopsProcesses:
                  workspace
                    .execution(tab.controller)
                    .backgroundControls?.busy() === true,
              })),
            closeTab: (key) => {
              assertOwner();
              return workspace.close(key);
            },
          };
        },
        getMcpActions: (root) =>
          getMcpController(root ?? currentController().snapshot.projectPath),
        initialSettingsOpen: setupRequired || setupOnly,
        onSetupComplete: setupOnly ? shutdown : undefined,
        onSubmit: submit,
        uiRedactor,
        onUiTool: async (
          controller,
          scope,
          extensionId,
          tool,
          args,
          toolScope,
        ) => {
          const generation = controller.currentGeneration;
          const originRoot = controller.snapshot.projectPath;
          const assertOwner = () => {
            if (
              controller.ownerSignal.aborted ||
              !controller.isCurrent(generation) ||
              controller.snapshot.projectPath !== originRoot
            )
              throw new Error("Разговор заменён.");
          };
          const prepared = await prepareUiToolInvocation(
            scope,
            extensionId,
            tool,
            args,
            assertOwner,
            toolScope,
          );
          assertOwner();
          return new Promise((resolve) => {
            const item: QueuedTabOperation = {
              kind: "ui_tool",
              input: `Действие: ${tool}`,
              prepared,
              scope,
              root: originRoot,
              generation,
              mode: controller.snapshot.agentMode,
              approvalMode: controller.snapshot.approvalMode,
              modelOptions: modelOptions(controller),
              onResult: resolve,
            };
            const execution = workspace.execution(controller);
            if (execution.activeRun) {
              execution.pendingOperations.push(item);
              controller.setBusy(true);
            } else void executeOperation(controller, item);
          });
        },
        initialTheme: currentTheme,
        motion: config.ui?.motion,
        onMotionChange: (motion) => {
          const saved = pendingSave.then(async () => {
            await updateGlobalConfig(options.configPath, (current) => ({
              ...current,
              ui: { ...current.ui, motion },
            }));
          });
          pendingSave = saved.catch(() => {});
          return saved;
        },
        themeCatalog: extensionHost.themes,
        accent: config.ui?.accent,
        onThemeChange: (theme) => {
          const saved = pendingSave.then(async () => {
            await updateGlobalConfig(options.configPath, (current) => ({
              ...current,
              ui: { ...current.ui, theme },
            }));
            currentTheme = theme;
          });
          pendingSave = saved.catch(() => {});
          return saved;
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
    await cleanup(() => modelService.dispose());
    await cleanup(() => extensionManagement.dispose());
    await cleanup(() => uiRuntime.dispose());
    await cleanup(() =>
      Promise.all(
        [workspace.home, ...workspace.tabs.map((tab) => tab.controller)].map(
          (controller) =>
            saveTerminalDraft(
              controller.snapshot.projectPath,
              controller.snapshot.sessionId,
              controller.snapshot.draft,
            ),
        ),
      ),
    );
    await cleanup(() => Promise.allSettled([...closingScopes]));
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
  return updater.restartHandedOff ? "update" : "exit";
}
