import { automationDispatcher } from "../app/run-automation.js";
import { type ImageAttachment, readImage } from "../media/image-attachment.js";
import { parseMcpSkillCommand } from "../skills/mcp.js";
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
  withModelCapabilities,
} from "../app/model-runtime.js";
import { runExtensionCommand } from "../app/run-command.js";
import { subagentControls } from "../app/subagent-inspection.js";
import {
  assertUiToolInvocation,
  prepareUiToolInvocation,
} from "../app/ui-tool.js";
import { runWorktreeInspection } from "../app/worktree-inspection.js";
import { browserPaneId } from "../browser/ui.js";
import { type RunOptions, runPrompt } from "../commands/run.js";
import { resolveSlashCommand, splitSlashCommand } from "../commands/slash.js";
import {
  launchWindowsInstaller,
  windowsUpdateArguments,
} from "../commands/update.js";
import {
  DEFAULT_PROJECT_CONFIG,
  loadGlobalConfig,
  loadProjectConfig,
  loadProjectInstructions,
  updateGlobalConfig,
} from "../config/load.js";
import { backgroundServiceToken } from "../extensions/builtins/background.js";
import {
  browserId,
  browserServiceToken,
} from "../extensions/builtins/browser.js";
import { subagentServiceToken } from "../extensions/builtins/subagents.js";
import {
  applicationExtensions,
  withOwnedExtensionHost,
} from "../extensions/composition.js";
import type { ChiselExtension } from "../extensions/contracts.js";
import type { ExtensionHost } from "../extensions/host.js";
import { abortable, safeDiagnostic } from "../extensions/lifecycle.js";
import { ExtensionManagementService } from "../extensions/management.js";
import {
  builtinAvailability,
  externalAllowed,
} from "../extensions/settings-contributions.js";
import { UiExtensionRuntime } from "../extensions/ui-runtime.js";
import { McpController } from "../mcp/controller.js";
import { McpConnectionManager } from "../mcp/manager.js";
import { McpConfigStore } from "../mcp/storage.js";
import type { MigrationActions } from "../migration/contracts.js";
import { createMigrationActions } from "../migration/service.js";
import {
  isModelRequestActive,
  type SideQueryRecord,
} from "../models/contracts.js";
import { ModelRequestService } from "../models/service.js";
import { WorkspaceAdmissionError } from "../projects/admission.js";
import { resolveLaunchWorkspace } from "../projects/launch.js";
import { navigationDirectory } from "../projects/navigation.js";
import {
  ProjectOpeningCancelledError,
  ProjectOpenService,
} from "../projects/opening.js";
import { applicationPaths } from "../projects/paths.js";
import {
  reasoningEffortKey,
  resolveReasoningEffort,
  unknownReasoningEffort,
} from "../providers/capabilities.js";
import { getProviderCatalog } from "../providers/catalog.js";
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
import type { Session, ToolExecutionResult } from "../types/domain.js";
import { clipText } from "../utils/text.js";
import { VERSION } from "../version.js";
import { resolveWebConfig } from "../web/schema.js";
import { WebSettingsStore } from "../web/settings.js";
import { DEFAULT_THEME, THEMES, type ThemeName } from "./appearance.js";
import { createApplicationSettingsActions } from "./application-settings-actions.js";
import {
  extensionCommandLabel,
  extensionResultActions,
  extensionResultFeedback,
} from "./chat-presentation.js";
import { suggestSimilarCommand } from "./commands.js";
import type { InteractiveExitReason } from "./interactive-exit.js";
import { ModelCatalogController } from "./model-catalog-controller.js";
import { rememberedModelOptions } from "./model-preference.js";
import { createModelSelectionActions } from "./model-selection-actions.js";
import type { OpenTuiEffortActions } from "./opentui-effort.js";
import { attachTranscriptScrollback } from "./opentui-scrollback.js";
import type { OpenTuiSkillsActions } from "./opentui-skills.js";
import { OpenTuiSpike } from "./opentui-spike.js";
import { settingsDraft } from "./provider-settings.js";
import {
  loadApplicationComposerDraft,
  loadTerminalComposerDraft,
  saveTerminalDraft,
} from "./terminal-drafts.js";
import { toolTranscriptHandlers } from "./tool-transcript.js";
import type { TuiPresentationController as TuiController } from "./tui-controller.js";
import type { QueuedTabOperation } from "./tui-tab-execution.js";
import { TuiWorkspace } from "./tui-workspace.js";
import { UpdateController } from "./update-controller.js";
import { WorkspaceCommands } from "./workspace-commands.js";
import { createWorkspaceNavigation } from "./workspace-navigation.js";
import { sameWorktreePath } from "./worktree-actions.js";

/** The sole interactive terminal renderer. */
export async function runOpenTuiAgent(
  options: RunOptions,
  initialSession?: Session,
  setupRequired = false,
  setupOnly = false,
  extensions?: readonly ChiselExtension[],
  rendererFactory: typeof createCliRenderer = createCliRenderer,
  clipboard?: import("@opentui/core").ClipboardService,
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
        clipboard,
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
  clipboard?: import("@opentui/core").ClipboardService,
): Promise<InteractiveExitReason> {
  const preferences = {
    activeOptions: { ...options, resume: undefined } as RunOptions,
    config: await loadGlobalConfig(options.configPath),
    defaultModel: "",
    webConfigLive: resolveWebConfig(),
  };
  let bypassAvailable =
    preferences.config.permissions?.allowBypassPermissions === true;
  preferences.webConfigLive = resolveWebConfig(preferences.config.web);
  const webSettingsStore = new WebSettingsStore(options.configPath);
  const uiRuntime = new UiExtensionRuntime(
    options.externalExtensions === false,
    (id) => !extensionHost.hasDefinition(id),
  );
  extensionHost.configureOwnerAvailability(async (id, root) => {
    if (
      ![
        "builtin.lsp",
        "builtin.subagents",
        "builtin.background",
        "builtin.browser",
      ].includes(id)
    )
      return (
        id.startsWith("builtin.") ||
        externalAllowed(id, await loadProjectConfig(root))
      );
    const [global, project] = await Promise.all([
      loadGlobalConfig(options.configPath),
      loadProjectConfig(root),
    ]);
    return builtinAvailability(id, global, project).effective;
  });
  const extensionManagement = new ExtensionManagementService({
    applyUi: (id) => uiRuntime.changed(id),
    hasBuiltin: (id) => extensionHost.hasDefinition(id),
    builtinRecovery: (id, root) =>
      extensionHost
        .readyScopes()
        .some(
          (scope) =>
            (!root || scope.workspaceRoot === root) &&
            scope.ownerCleanupFailed(id),
        ),
    applyBuiltin: async (id) => {
      try {
        await extensionHost.refreshOwner(id);
      } finally {
        uiRuntime.publish();
      }
    },
    disableExternal: (id) => {
      uiRuntime.suspend(id);
      return extensionHost.suspendOwner(id).finally(() => uiRuntime.publish());
    },
    enableExternal: (id) => extensionHost.resumeOwner(id),
    automations: (root) =>
      extensionHost.readyScopes().find((scope) => scope.workspaceRoot === root)
        ?.automations,
    externalNeedsRestart: (id) =>
      extensionHost.needsRestart(id) || uiRuntime.needsRestart(id),
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
  const initialWorkspace = await resolveLaunchWorkspace({
    invocationCwd: process.cwd(),
    explicitCwd: options.cwd,
    launcher: options.launcher,
    resume: options.resume,
    configPath: options.configPath,
  });
  const initialRoot = initialWorkspace?.root;
  const projectConfig = initialRoot
    ? await loadProjectConfig(initialRoot)
    : DEFAULT_PROJECT_CONFIG;
  const initialApprovalMode = resolveApprovalMode({
    ...options,
    saved: initialSession?.approvalMode,
    autoApprove: projectConfig.autoApprove,
    allowBypassPermissions: bypassAvailable,
  });
  const closingDrafts = new Set<Promise<void>>();
  const workspace = new TuiWorkspace(
    initialRoot,
    options.mode ?? DEFAULT_AGENT_MODE,
    initialApprovalMode,
    (controller) => {
      const { projectPath, sessionId, draft, draftImages } =
        controller.snapshot;
      if (!sessionId || draftImages === undefined) return;
      const save = saveTerminalDraft(projectPath, sessionId, draft, {
        images: draftImages,
      });
      closingDrafts.add(save);
      void save
        .catch((error) =>
          workspace.controller.appendNotice(safeDiagnostic(error), "error"),
        )
        .finally(() => {
          closingDrafts.delete(save);
        });
    },
  );
  extensionHost.configureAutomations(
    (scope) =>
      automationDispatcher(scope, options, () => {
        const controller = workspace.controller;
        const selected =
          controller.snapshot.projectPath === scope.workspaceRoot;
        return {
          mode: selected ? controller.snapshot.agentMode : "plan",
          resolver: {
            requestApproval: (request, signal) =>
              selected
                ? workspace
                    .execution(controller)
                    .approvalResolver.requestApproval(request, signal)
                : Promise.resolve("unavailable"),
          },
        };
      }),
    () => extensionManagement.automationsChanged(),
  );
  if (initialWorkspace) workspace.home.selection = initialWorkspace;
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
  const restoredDraft = workspace.controller.snapshot.projectPath
    ? await loadTerminalComposerDraft(
        workspace.controller.snapshot.projectPath,
        workspace.controller.snapshot.sessionId,
      ).catch((cause) => {
        workspace.controller.append(
          `Не удалось восстановить черновик: ${String(cause)}`,
          "error",
        );
        return undefined;
      })
    : await loadApplicationComposerDraft().catch((cause) => {
        workspace.home.append(
          `Не удалось восстановить черновик: ${String(cause)}`,
          "error",
        );
        return undefined;
      });
  if (restoredDraft !== undefined) {
    workspace.controller.setDraft(restoredDraft.text);
    if (restoredDraft.images.length)
      workspace.controller.setDraftImages(restoredDraft.images);
    workspace.controller.presentation.history.value = restoredDraft.text;
    workspace.controller.presentation.history.cursor =
      restoredDraft.text.length;
  }
  workspace.controller.setApprovalMode(initialApprovalMode);
  if (options.mode) workspace.controller.setAgentMode(options.mode);
  const currentController = () => workspace.controller;
  const mcpProjects = new Map<string, McpController>();
  const getMcpController = (projectRoot: string | undefined) => {
    const key = projectRoot ?? "application";
    let controller = mcpProjects.get(key);
    if (!controller) {
      controller = new McpController(
        new McpConnectionManager(
          new McpConfigStore(projectRoot, { globalPath: options.configPath }),
        ),
      );
      mcpProjects.set(key, controller);
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
  for (const profile of Object.values(preferences.config.profiles)) {
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
  const startupSelection = rememberedModelOptions(
    preferences.config,
    preferences.activeOptions,
  );
  const homeModel = settingsDraft(
    preferences.config,
    catalog.registry,
    startupSelection,
  );
  workspace.home.setActiveModel(
    homeModel.provider,
    homeModel.model,
    homeModel.profileId,
    homeModel.baseUrl,
  );
  const initialModel = settingsDraft(
    preferences.config,
    catalog.registry,
    initialSession
      ? {
          ...preferences.activeOptions,
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
                ? preferences.config.profiles[options.profile]?.providerId
                : initialSession.providerId)) === initialSession.providerId
              ? initialSession.model
              : undefined),
        }
      : startupSelection,
  );
  workspace.controller.setActiveModel(
    initialModel.provider,
    initialModel.model,
    initialModel.profileId,
    initialModel.baseUrl,
  );
  preferences.defaultModel = homeModel.model;
  const modelOptions = (controller: TuiController): RunOptions => {
    const selected = controller.snapshot.modelSelection;
    return selected
      ? {
          provider: selected.provider,
          profile: selected.profileId,
          model: selected.model,
          baseUrl: selected.baseUrl,
          reasoningEffort:
            controller.snapshot.reasoningEfforts?.[
              reasoningEffortKey(selected.profileId, selected.model)
            ] ?? "auto",
        }
      : preferences.activeOptions;
  };
  const modelCatalog = new ModelCatalogController(options.configPath);
  const migration = createMigrationActions(options.configPath);
  let migrating: ReturnType<MigrationActions["run"]> | undefined;
  let scanning: ReturnType<MigrationActions["inspect"]> | undefined;
  const migrationActions: MigrationActions = {
    inspect: () =>
      (scanning ??= migration.inspect().finally(() => {
        scanning = undefined;
      })),
    run: (selection) => {
      if (migrating) return migrating;
      migrating = migration
        .run(selection)
        .then(async (result) => {
          preferences.config = await loadGlobalConfig(options.configPath);
          modelCatalog.invalidate();
          return result;
        })
        .finally(() => {
          migrating = undefined;
        });
      return migrating;
    },
  };
  const warmModelCapabilities = (controller: TuiController) =>
    modelCatalog.warm(controller);
  warmModelCapabilities(workspace.home);
  warmModelCapabilities(workspace.controller);
  let currentTheme: ThemeName = preferences.config.ui?.theme ?? DEFAULT_THEME;
  const classic =
    process.env.CHISEL_ALT_SCREEN === "0" ||
    process.env.CHISEL_NO_ALT_SCREEN === "1";
  const renderer = await rendererFactory({
    screenMode: classic ? "split-footer" : "alternate-screen",
    footerHeight: 12,
    exitOnCtrlC: false,
    exitSignals: [],
  });
  let scrollback: { controller: TuiController; detach(): void } | undefined;
  let hasScrollback = false;
  const openingRoots = new Set<string>();
  const closingScopes = new Set<Promise<void>>();
  const closingRoots = new Set<string>();
  const releaseUnusedScopes = () => {
    const rootKey = (value: string) =>
      process.platform === "win32" ? resolve(value).toLowerCase() : value;
    const roots = new Set(
      [
        workspace.home.snapshot.projectPath,
        ...workspace.operationRoots,
        ...workspace.tabs.map((tab) => tab.controller.snapshot.projectPath),
        ...openingRoots,
        ...projectOpener.roots,
      ]
        .filter((root): root is string => !!root)
        .map(rootKey),
    );
    for (const scope of extensionHost.readyScopes()) {
      if (
        roots.has(rootKey(scope.workspaceRoot)) ||
        closingRoots.has(scope.workspaceRoot)
      )
        continue;
      closingRoots.add(scope.workspaceRoot);
      const mcp = mcpProjects.get(scope.workspaceRoot);
      if (mcp) mcpProjects.delete(scope.workspaceRoot);
      const work = Promise.all([
        extensionHost.closeWorkspace(scope.workspaceRoot),
        uiRuntime.closeWorkspace(scope.workspaceRoot),
        mcp?.discard().then(() => mcp.manager.dispose()),
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
    if (!classic || renderer.isDestroyed) return;
    const selected = workspace.tabs.find(
      (tab) => tab.key === workspace.activeKey,
    )?.controller;
    if (scrollback?.controller === selected) return;
    scrollback?.detach();
    scrollback = undefined;
    if (hasScrollback) renderer.resetSplitFooterForReplay();
    if (!selected) return;
    hasScrollback = true;
    scrollback = {
      controller: selected,
      detach: attachTranscriptScrollback(selected, renderer, () =>
        extensionHost.themes.palette(
          currentTheme,
          preferences.config.ui?.accent,
        ),
      ),
    };
  };
  const projectOpener = new ProjectOpenService(
    async (ref) => {
      await loadProjectConfig(ref.root);
      return extensionHost.open(ref.root);
    },
    releaseUnusedScopes,
    options.configPath,
  );
  const detachWorkspace = workspace.subscribe(() => {
    syncScrollback();
    releaseUnusedScopes();
  });
  syncScrollback();
  const root = createRoot(renderer);
  const abort = new AbortController();
  const commandActions = new WorkspaceCommands(
    extensionHost,
    abort.signal,
    uiRuntime,
    (root) => getMcpController(root).manager,
  );
  if (initialRoot) void commandActions.load(initialRoot);
  const navigationBase = await navigationDirectory();
  const appPaths = await applicationPaths(options.configPath);

  const requireProject = (controller = currentController()): string => {
    const root = controller.snapshot.projectPath;
    if (!root)
      throw new WorkspaceAdmissionError(
        "WORKSPACE_REQUIRED",
        "Проект не выбран.",
      );
    return root;
  };
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
  const saves = { pending: Promise.resolve() };
  const persistExecutionModes = (controller: TuiController) => {
    if (!controller.snapshot.sessionId || controller.snapshot.busy) return;
    const generation = controller.currentGeneration;
    saves.pending = saves.pending
      .then(async () => {
        const {
          sessionId,
          projectPath,
          agentMode,
          approvalMode,
          busy,
          modelSelection,
          reasoningEfforts,
        } = controller.snapshot;
        if (
          !sessionId ||
          busy ||
          !projectPath ||
          !controller.isCurrent(generation)
        )
          return;
        const store = await projectSessionStore(projectPath);
        await store.setPreferences(sessionId, {
          mode: agentMode,
          approvalMode,
          ...(reasoningEfforts ? { reasoningEfforts } : {}),
          ...(modelSelection
            ? {
                providerId: modelSelection.provider,
                ...(modelSelection.profileId
                  ? { profileId: modelSelection.profileId }
                  : {}),
                model: modelSelection.model,
              }
            : {}),
        });
      })
      .catch((error) => {
        if (controller.isCurrent(generation))
          controller.showCommandFeedback(
            `Не удалось сохранить выбор сессии.\n\n${safeDiagnostic(error instanceof Error ? error.message : String(error))}`,
            "error",
          );
      });
  };
  const getEffortActions = (): OpenTuiEffortActions => {
    const controller = currentController();
    const generation = controller.currentGeneration;
    const selection = controller.snapshot.modelSelection;
    const assertOwner = () => {
      if (
        !controller.isCurrent(generation) ||
        currentController() !== controller ||
        controller.snapshot.modelSelection !== selection ||
        abort.signal.aborted
      )
        throw new Error("Активная модель изменилась. Откройте /effort снова.");
    };
    const key =
      selection && reasoningEffortKey(selection.profileId, selection.model);
    const load = async () => {
      const capabilities =
        selection && (await modelCatalog.capabilities(selection));
      assertOwner();
      if (selection && capabilities)
        controller.setModelCapabilities(selection, capabilities);
      return {
        model:
          (capabilities && capabilities.displayName) ||
          selection?.model ||
          "Модель не выбрана",
        capability:
          (capabilities && capabilities.reasoningEffort) ??
          unknownReasoningEffort,
        current: key ? controller.snapshot.reasoningEfforts?.[key] : undefined,
      };
    };
    return {
      model: selection?.model ?? "Модель не выбрана",
      load,
      select: async (selection) => {
        const level = selection.toLowerCase();
        if (!key) throw new Error("Сначала выберите модель в /model.");
        if (level !== "auto") {
          const { capability } = await load();
          if (!resolveReasoningEffort(capability, level))
            throw new Error(
              capability.reason ??
                `Доступные уровни: ${capability.levels.join(", ")}. Сброс: /effort auto.`,
            );
        }
        assertOwner();
        const preferences = { ...controller.snapshot.reasoningEfforts };
        if (level === "auto") delete preferences[key];
        else preferences[key] = level;
        controller.setReasoningEfforts(preferences);
        persistExecutionModes(controller);
        return level === "auto" ? "Auto" : level;
      },
    };
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
    projectOpener.cancel();
    workspace.cancelAll();
    for (const { controller } of workspace.tabs) {
      if (!controller.snapshot.runningMode) {
        controller.setBusy(false);
        persistExecutionModes(controller);
      }
    }
    finish?.();
  };
  const cancel = () => {
    if (workspace.activeKey) workspace.execution().cancel();
  };
  const restoreSubagentControls = async (
    controller: TuiController,
    session: Session,
  ) => {
    if (
      session.backgroundTasks &&
      Object.keys(session.backgroundTasks).length
    ) {
      const root = requireProject(controller);
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
    const root = requireProject(controller);
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

  const { getProjectActions, resume, sessionPicker } =
    createWorkspaceNavigation({
      currentController,
      navigationBase,
      abort,
      projectOpener,
      activeSkills,
      workspace,
      skillNames,
      appPaths,
      isBypassAvailable: () => bypassAvailable,
      persistExecutionModes,
      restoreSubagentControls,
      warmModelCapabilities,
      options,
    });
  const submitUiTool: import("./extension-ui.js").UiToolSubmit = async (
    controller,
    scope,
    extensionId,
    tool,
    args,
    toolScope,
  ) => {
    const generation = controller.currentGeneration;
    const originRoot = requireProject(controller);
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
    const projectOperation =
      controller === workspace.home
        ? workspace.projectOperation(controller)
        : undefined;
    const operationController = projectOperation?.controller ?? controller;
    try {
      return await new Promise((resolve) => {
        const item: QueuedTabOperation = {
          kind: "ui_tool",
          input: `Действие: ${tool}`,
          prepared,
          scope,
          root: originRoot,
          generation: operationController.currentGeneration,
          mode: controller.snapshot.agentMode,
          approvalMode: controller.snapshot.approvalMode,
          modelOptions: modelOptions(controller),
          onResult: resolve,
        };
        const execution = workspace.execution(operationController);
        if (execution.activeRun) {
          execution.pendingOperations.push(item);
          operationController.setBusy(true);
        } else void executeOperation(operationController, item);
      });
    } finally {
      projectOperation?.release();
    }
  };
  const { getSettingsActions } = createApplicationSettingsActions({
    currentController,
    requireProject,
    submitUiTool,
    extensionManagement,
    webSettingsStore,
    saves,
    preferences,
    catalog,
    modelOptions,
    uiRedactor,
    modelCatalog,
    warmModelCapabilities,
    options,
    extensionHost,
  });

  const modelSelected = (model: string) => {
    preferences.defaultModel = model;
  };
  const { getModelsActions } = createModelSelectionActions({
    currentController,
    catalog,
    modelOptions,
    modelCatalog,
    abort,
    saves,
    modelSelected,
    warmModelCapabilities,
    options,
  });

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
        return [
          ...loadSkills(controller.snapshot.projectPath),
          ...getMcpController(controller.snapshot.projectPath).manager.skills(),
        ];
      },
      subscribe: (changed) => {
        assertOwner();
        return commandActions.watchSkills(
          controller.snapshot.projectPath,
          changed,
        );
      },
      refresh: (signal, force) => {
        assertOwner();
        return getMcpController(
          controller.snapshot.projectPath,
        ).manager.startSkills(signal, force);
      },
      inspect: async (name, signal) => {
        assertOwner();
        const loaded = await getMcpController(
          controller.snapshot.projectPath,
        ).manager.loadSkill(name, signal, true);
        assertOwner();
        return loaded.instructions;
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
    subscribe: (changed) =>
      getSkillsActions().subscribe?.(changed) ?? (() => {}),
    refresh: (signal, force) =>
      getSkillsActions().refresh?.(signal, force) ?? Promise.resolve(),
    inspect: (name, signal) =>
      getSkillsActions().inspect?.(name, signal) ?? Promise.resolve(""),
    load: () => getSkillsActions().load(),
    activeNames: () => getSkillsActions().activeNames(),
    toggle: (name) => getSkillsActions().toggle(name),
    editSource: (name) => getSkillsActions().editSource?.(name) ?? "",
  };
  const updater = new UpdateController(VERSION, {
    canRestart: () => !workspace.busy,
    launch: async (downloaded) => {
      await saves.pending;
      if (abort.signal.aborted)
        throw new DOMException("Обновление отменено.", "AbortError");
      if (workspace.busy)
        throw new Error("Дождитесь завершения запроса перед перезапуском.");
      const { projectPath, sessionId } = currentController().snapshot;
      await launchWindowsInstaller(
        downloaded.path,
        windowsUpdateArguments(
          projectPath ? resolve(projectPath) : undefined,
          sessionId,
          {
            parentPid: process.pid,
            installDirectory: dirname(process.execPath),
          },
        ),
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
    photoSubmission?: {
      images: readonly ImageAttachment[];
      accepted(): boolean;
    },
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
          preferences.config,
          catalog.registry,
          { ...options, ...turnModelOptions },
          undefined,
          controller.snapshot.modelCapabilities,
        );
      } catch {
        /* Only a model consumer reports missing configuration. */
      }
      const submittedSelection = target.snapshot.modelSelection;
      const submittedModel = capturedModel;
      let promptModel =
        submittedModel &&
        submittedSelection &&
        turnModelOptions.reasoningEffort &&
        turnModelOptions.reasoningEffort !== "auto"
          ? modelCatalog
              .capabilities(submittedSelection)
              .then((capabilities) =>
                withModelCapabilities(
                  submittedModel,
                  capabilities,
                  turnModelOptions.reasoningEffort,
                ),
              )
          : Promise.resolve(submittedModel);
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
      if (input === "/clear") {
        workspace.newDraft(controller.snapshot.projectPath);
        return;
      }
      if (input === "/update") return updater.check();
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
          await getProjectActions().open(parsed.args);
        } catch (error) {
          if (!(error instanceof ProjectOpeningCancelledError))
            controller.append(String(error), "error");
        }
        return;
      }
      if (input === "/cwd") {
        controller.requestProjectPicker();
        return;
      }
      if (!originRoot) {
        controller.requestProjectPicker("Выберите папку для этой задачи");
        return;
      }
      if (parsed?.name === "/compact") {
        if (parsed.args) {
          controller.append("Использование: /compact без аргументов.", "warn");
          return;
        }
        const execution = workspace.execution(controller);
        if (!controller.snapshot.sessionId && !execution.activeRun) {
          controller.append(
            "Сначала отправьте сообщение в разговор, затем используйте /compact.",
            "info",
          );
          return;
        }
        const item: QueuedTabOperation = {
          kind: "compact",
          input,
          root: originRoot,
          mode: turnMode,
          approvalMode: turnApprovalMode,
          modelOptions: turnModelOptions,
          generation: originGeneration,
        };
        if (execution.activeRun) {
          execution.pendingOperations.push(item);
          controller.setBusy(true);
          controller.append(
            `В очереди: ${execution.pendingOperations.length} | /compact`,
            "info",
          );
        } else await executeOperation(controller, item);
        return;
      }
      if (photoSubmission) {
        const capabilities = submittedSelection
          ? await modelCatalog.capabilities(submittedSelection)
          : submittedModel?.capabilities;
        if (!submittedModel || capabilities?.imageInput !== true)
          throw new Error(
            "Модель не подтвердила поддержку фото. Выберите модель с поддержкой изображений.",
          );
        for (const image of photoSubmission.images) {
          try {
            await readImage(image);
          } catch {
            throw new Error(
              "Одно из фото недоступно. Уберите его и прикрепите снова.",
            );
          }
        }
        if (
          abort.signal.aborted ||
          !controller.isCurrent(originGeneration) ||
          !photoSubmission.accepted()
        )
          return;
        promptModel = Promise.resolve(
          withModelCapabilities(
            submittedModel,
            capabilities,
            turnModelOptions.reasoningEffort,
          ),
        );
      }
      let snapshot:
        | import("./workspace-commands.js").WorkspaceCommandSnapshot
        | undefined;
      const submission = new AbortController();
      if (parsed) {
        const execution = workspace.activeKey
          ? workspace.execution(controller)
          : undefined;
        execution?.pendingSubmissions.add(submission);
        try {
          snapshot = await commandActions.load(
            originRoot,
            AbortSignal.any([abort.signal, submission.signal]),
          );
        } finally {
          execution?.pendingSubmissions.delete(submission);
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
      const browser =
        descriptor?.source.type === "extension" &&
        descriptor.source.extensionId === browserId &&
        descriptor.source.name === "browser"
          ? snapshot?.scope?.services.lookup(browserServiceToken)
          : undefined;
      const browserPane = `${browserId}/${browserPaneId}`;
      let invalidArguments: string | undefined;
      if (descriptor?.source.type === "extension" && snapshot?.scope) {
        const command = snapshot.scope.commands.get(descriptor.source.name);
        try {
          prepared = { command, input: command.parse(parsed?.args ?? "") };
        } catch {
          invalidArguments = `Неверные аргументы.${command.usage ? ` Использование: ${safeDiagnostic(command.usage)}` : ""}`;
          if (!browser) {
            controller.showCommandFeedback(
              `${extensionCommandLabel(command)}\n\n${invalidArguments}`,
              "error",
            );
            return;
          }
        }
      }
      if (
        parsed &&
        !skill &&
        !prepared &&
        !browser &&
        !parseMcpSkillCommand(input)
      ) {
        if (snapshot?.error) {
          controller.showCommandFeedback(snapshot.error, "error");
          return;
        }
        const hint = suggestSimilarCommand(
          input,
          snapshot?.projection ?? invocableSkills([...availableSkills]),
        );
        controller.showCommandFeedback(
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
          browser
            ? "Браузер"
            : prepared?.command.executionPolicy === "side_query"
              ? "Побочный вопрос"
              : prepared
                ? extensionCommandLabel(prepared.command)
                : clipText(input.split("\n", 1)[0] || "Фото", 120),
        );
        homeOperationTarget = {
          generation: originGeneration,
          root: originRoot,
          controller,
        };
        controller.setReasoningEfforts(target.snapshot.reasoningEfforts);
        if (!prepared) warmModelCapabilities(controller);
        controller.presentation.history = inputHistory;
        skillNames.set(controller, {
          generation: controller.currentGeneration,
          names: new Set(selectedSkills),
        });
      }
      let reportBrowser: ((result: ToolExecutionResult) => void) | undefined;
      if (browser) {
        const args = parsed?.args.trim();
        try {
          const visible = browser.setPanel(
            { id: controller.conversationId, signal: controller.ownerSignal },
            args ? true : undefined,
          );
          if (visible) controller.uiCollapsedPanes.delete(browserPane);
        } catch (error) {
          controller.showCommandFeedback(
            `Браузер\n\n${safeDiagnostic(error instanceof Error ? error.message : String(error))}`,
            "error",
          );
          return;
        }
        if (!args) return;
        if (invalidArguments) {
          controller.setExtensionFeedback(browserPane, {
            title: "Команда браузера",
            message: invalidArguments,
            tone: "error",
          });
          return;
        }
        const title =
          args === "install" ? "Установка Chromium" : "Открытие страницы";
        const pending = { title: `${title}…`, tone: "pending" } as const;
        const generation = controller.currentGeneration;
        controller.setExtensionFeedback(browserPane, pending);
        reportBrowser = (result) => {
          if (
            controller.isCurrent(generation) &&
            controller.snapshot.extensionFeedback?.[browserPane] === pending
          )
            controller.setExtensionFeedback(
              browserPane,
              extensionResultFeedback(title, result),
            );
        };
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
              workspaceRoot: requireProject(origin),
              sessionId: origin.snapshot.sessionId!,
              signal: origin.ownerSignal,
              subagents: origin.subagentControls!.port,
              background: origin.backgroundControls?.port,
            },
            selected.input,
          );
          if (origin.isCurrent(generation))
            showExtensionResult(
              origin,
              extensionCommandLabel(selected.command),
              result,
            );
        } catch (error) {
          if (origin.isCurrent(generation))
            origin.showCommandFeedback(
              `${extensionCommandLabel(selected.command)}\n\n${safeDiagnostic(error instanceof Error ? error.message : String(error))}`,
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
              onResult: reportBrowser ?? onCommandResult,
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
              capturedModel: promptModel,
              input,
              ...(photoSubmission && { images: photoSubmission.images }),
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
        if (item.kind === "prompt")
          controller.append(
            `В очереди: ${execution.pendingOperations.length} | ${AGENT_MODE_LABELS[turnMode]} | ${APPROVAL_MODE_LABELS[turnApprovalMode]} | ${input || "Фото"}`,
            "info",
          );
        else if (!item.onResult)
          controller.setExtensionActivity(
            `В очереди · ${extensionCommandLabel(item.prepared.command)}`,
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
  function showExtensionResult(
    controller: TuiController,
    title: string,
    result: ToolExecutionResult,
  ): void {
    if (result.errorCode === "CANCELLED") return;
    const feedback = extensionResultFeedback(title, result);
    controller.showCommandFeedback(
      [feedback.title, feedback.message].filter(Boolean).join("\n\n"),
      feedback.tone === "error" ? "error" : "info",
      undefined,
      extensionResultActions(result),
    );
  }
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
    const local = item.kind === "command" || item.kind === "ui_tool";
    const execution = workspace.execution(controller);
    const {
      input,
      mode: turnMode,
      approvalMode: turnApprovalMode,
      modelOptions: turnModelOptions,
    } = item;
    const requestGeneration = controller.currentGeneration;
    const onSessionUsage = (session: Session) => {
      if (controller.isCurrent(requestGeneration))
        controller.setSessionUsage(session, {
          provider: session.providerId,
          profileId: session.profileId,
          model: session.model,
          baseUrl: turnModelOptions.baseUrl,
        });
    };
    const turnAbort = new AbortController();
    execution.abort = turnAbort;
    const signal = AbortSignal.any([
      abort.signal,
      turnAbort.signal,
      controller.ownerSignal,
    ]);
    controller.conversation.begin(item.kind === "prompt" ? input : undefined);
    if (local) {
      controller.setBusy(true);
      if (!item.onResult)
        controller.setExtensionActivity(
          `Выполняется · ${extensionCommandLabel(item.prepared.command)}`,
        );
    } else {
      controller.startRequest(item.kind === "prompt" ? "waiting" : "tool");
      controller.setRunningMode(turnMode);
      controller.setRunningApprovalMode(turnApprovalMode);
      controller.append(
        input ? `> ${input}` : "",
        "user",
        undefined,
        item.kind === "prompt" ? item.images : undefined,
      );
    }
    if (
      item.kind === "prompt" &&
      controller.snapshot.modelCapabilities?.imageInput !== true &&
      !item.images?.length
    ) {
      if (controller.snapshot.transcript.some((entry) => entry.images?.length))
        controller.append(
          "Выбранная модель получает подписи к прежним фото.",
          "info",
        );
    }
    const tools = toolTranscriptHandlers(() => controller);
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
        if (item.kind === "compact") {
          if (!controller.snapshot.sessionId) {
            controller.append(
              "В этом разговоре пока нет сохранённой истории.",
              "info",
            );
            status = "completed";
            return;
          }
          let compressed = false;
          const { result } = await runPrompt(
            "",
            {
              ...options,
              ...turnModelOptions,
              cwd: item.root,
              resume: controller.snapshot.sessionId,
              mode: turnMode,
              approvalMode: turnApprovalMode,
              interactive: true,
              compactOnly: true,
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
              getWebConfig: () => preferences.webConfigLive,
              mcpManager: getMcpController(item.root).manager,
            },
            execution.approvalResolver,
            {
              onText: () => {},
              onSessionUsage,
              onConversation: (source) => {
                if (controller.isCurrent(requestGeneration))
                  controller.conversation.bind(source);
              },
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
              onEvent: (event) => {
                if (!controller.isCurrent(requestGeneration) || signal.aborted)
                  return;
                if (
                  event.type === "context_compaction_started" &&
                  event.compactionId
                )
                  controller.beginCompaction(event.compactionId);
                if (
                  event.type === "context_compaction_completed" &&
                  event.compaction
                ) {
                  compressed = true;
                  controller.finishCompaction(event.compaction);
                }
                if (
                  event.type === "context_compaction_failed" &&
                  event.compactionId
                )
                  controller.abortCompaction(event.compactionId);
                if (event.type === "context_updated" && event.contextSnapshot) {
                  const selection = controller.snapshot.modelSelection;
                  if (selection)
                    controller.setContextSnapshot(
                      {
                        provider:
                          turnModelOptions.provider ?? selection.provider,
                        profileId: turnModelOptions.profile,
                        model:
                          turnModelOptions.model ?? event.contextSnapshot.model,
                        baseUrl: turnModelOptions.baseUrl,
                      },
                      event.contextSnapshot,
                    );
                }
              },
            },
            signal,
            { host: extensionHost },
          );
          status = result.status;
          if (controller.isCurrent(requestGeneration) && !signal.aborted) {
            onSessionUsage(result.session);
            if (!compressed) controller.append(result.text, "info");
          }
          return;
        }
        if (item.kind !== "prompt") {
          let worktreeOpened = false;
          const heading =
            item.kind === "ui_tool"
              ? "Действие расширения"
              : extensionCommandLabel(item.prepared.command);
          const report = (result: ToolExecutionResult) => {
            if (item.onResult) {
              item.onResult(result);
              item.onResult = undefined;
            } else if (
              result.isError ||
              !worktreeOpened ||
              item.prepared.command.source.extensionId !== "builtin.worktrees"
            )
              showExtensionResult(controller, heading, result);
          };
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
            report({
              output:
                snapshot.error ??
                "Команда больше не принадлежит выбранному расширению.",
              isError: true,
            });
            return;
          }
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
              getWebConfig: () => preferences.webConfigLive,
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
                  worktreeOpened = true;
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
                  workspace.openSession(session);
                  worktreeOpened = true;
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
                if (event.type === "checkpoint_saved")
                  controller.setSessionId(event.sessionId);
              },
              onToolResult: (_name, result) => {
                if (!controller.isCurrent(requestGeneration) || signal.aborted)
                  return;
                if (result.diffs?.length || result.fileDiff)
                  for (const tab of workspace.tabs)
                    tab.controller.refreshGitChanges();
              },
            },
            signal,
            {
              service: modelService,
              captured: item.capturedModel,
              recordPresentation: false,
              onToolInvocation: (id) => {
                if (controller.isCurrent(requestGeneration))
                  controller.trackExtensionTool(id);
              },
            },
          );
          if (
            item.onResult ||
            (!signal.aborted && controller.isCurrent(requestGeneration))
          )
            report(outcome.result);
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
          return;
        }
        const availableSkills = loadSkills(item.root);
        const parsed = splitSlashCommand(input);
        const remoteCommand = parseMcpSkillCommand(input);
        const skill = parsed
          ? invocableSkills(availableSkills).find(
              (skill) => `/${skill.name}` === parsed.name,
            )
          : undefined;
        if (parsed && !skill && !remoteCommand) {
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
            ...(controller.snapshot.sessionId
              ? options
              : preferences.activeOptions),
            ...turnModelOptions,
            capturedModel: await item.capturedModel,
            images: item.images,
            cwd: controller.snapshot.projectPath,
            resume: controller.snapshot.sessionId,
            mode: turnMode,
            approvalMode: turnApprovalMode,
            interactive: true,
            mcpSkillCommand: remoteCommand,
            invokedSkill: skill,
            uiSnapshot: {
              observe: () => {
                if (
                  currentController() !== controller ||
                  !controller.isCurrent(requestGeneration)
                )
                  return { ownerVisible: false };
                const view = controller.snapshot,
                  next = view.modelSelection;
                return {
                  ownerVisible: true,
                  route: "conversation",
                  focus: view.focus,
                  ...(next
                    ? {
                        nextModel: {
                          provider: next.provider,
                          model: next.model,
                          profile: next.profileId,
                        },
                      }
                    : {}),
                };
              },
            },
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
            getWebConfig: () => preferences.webConfigLive,
            mcpManager: getMcpController(requireProject(controller)).manager,
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
            onSessionUsage,
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
        onSessionUsage(result.session);
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
        if (!signal.aborted && controller.isCurrent(requestGeneration)) {
          if (!local) controller.append(String(error), "error");
          else {
            const result = {
              output: safeDiagnostic(
                error instanceof Error ? error.message : String(error),
              ),
              isError: true,
              errorCode: "TOOL_EXECUTION_FAILURE",
            } satisfies ToolExecutionResult;
            if (item.onResult) {
              item.onResult(result);
              item.onResult = undefined;
            } else
              showExtensionResult(
                controller,
                extensionCommandLabel(item.prepared.command),
                result,
              );
          }
        }
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
          if (!local) {
            controller.finishRequest(status, elapsedMs);
            controller.setRunningMode();
            controller.setRunningApprovalMode();
          }
          controller.setExtensionActivity();
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
  let reconcile: Promise<void> | undefined;
  const packageWatch = setInterval(() => {
    if (!reconcile)
      reconcile = extensionManagement
        .reconcileExternalDisables()
        .catch(() => {})
        .finally(() => {
          reconcile = undefined;
        });
  }, 1000);
  packageWatch.unref();
  let applicationFailure: unknown;
  let applicationFailed = false;
  const cleanupErrors: unknown[] = [];
  try {
    if (initialRoot) await extensionHost.open(initialRoot);
    if (!extensionHost.themes.get(currentTheme)) {
      currentTheme = DEFAULT_THEME;
      currentController().appendNotice(
        `Выбранная тема расширения недоступна. Используется ${THEMES[DEFAULT_THEME].label}. Проверьте расширение и перезапустите ChiselCode после изменения его состояния.`,
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
        onSideCancel: () => {
          if (workspace.activeKey)
            workspace.execution(currentController()).cancelSides();
        },
        workspace,
        getProjectActions,
        classic,
        sessionPicker,
        getSettingsActions,
        updater,
        getModelsActions,
        getEffortActions,
        getDefaultModel: () => preferences.defaultModel,
        onAgentModeChange: () => persistExecutionModes(currentController()),
        onApprovalModeChange: () => persistExecutionModes(currentController()),
        allowBypassPermissions: bypassAvailable,
        onBypassAvailabilityChange: (allowed) => {
          const saved = saves.pending.then(async () => {
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
                for (const queued of controller === workspace.home
                  ? []
                  : workspace.execution(controller).pendingOperations)
                  if (queued.approvalMode === "bypassPermissions")
                    queued.approvalMode = "default";
                if (controller.snapshot.approvalMode === "bypassPermissions") {
                  controller.setApprovalMode("default");
                  persistExecutionModes(controller);
                }
              }
            }
          });
          saves.pending = saved.catch(() => {});
          return saved;
        },
        skillsActions,
        getSkillsActions,
        commandActions,
        getWorktreeActions: () => {
          const target = currentController();
          const root = requireProject(target);
          const projectOperation =
            target === workspace.home
              ? workspace.projectOperation(target)
              : undefined;
          const operationController = projectOperation?.controller ?? target;
          const generation = target.currentGeneration;
          const manager = new AbortController();
          const signal = AbortSignal.any([
            abort.signal,
            target.ownerSignal,
            manager.signal,
          ]);
          const assertOwner = () => {
            if (
              signal.aborted ||
              !target.isCurrent(generation) ||
              target.snapshot.projectPath !== root
            )
              throw new Error("Разговор изменён или закрыт.");
          };
          return {
            dispose: () => {
              manager.abort();
              projectOperation?.release();
            },
            root,
            owner: `${target.conversationId}:${generation}`,
            mode: target.snapshot.agentMode,
            run: async (action, input = {}) => {
              assertOwner();
              const snapshot = await commandActions.load(root, signal);
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
              if (action === "list" || action === "status" || action === "diff")
                return runWorktreeInspection(scope, action, input, signal);
              const execution = workspace.execution(operationController);
              if (execution.foregroundBusy)
                throw new Error(
                  "Дождитесь завершения запроса в этой вкладке и повторите действие.",
                );
              return new Promise<ToolExecutionResult>((resolve) => {
                const operation: QueuedTabOperation = {
                  kind: "command",
                  input: `/worktree ${action}`,
                  prepared: {
                    command,
                    input: { ...structuredClone(input), action },
                  },
                  scope,
                  root,
                  generation: operationController.currentGeneration,
                  mode: target.snapshot.agentMode,
                  approvalMode: target.snapshot.approvalMode,
                  modelOptions: modelOptions(target),
                  onResult: resolve,
                };
                void executeOperation(operationController, operation);
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
        migrationActions,
        initialSettingsOpen: setupRequired || setupOnly,
        onboarding: setupRequired && !setupOnly,
        onStartupIntroAccepted:
          setupRequired &&
          !setupOnly &&
          !preferences.config.ui?.startupIntroSeen &&
          !Object.keys(preferences.config.profiles).length
            ? () => {
                const saved = saves.pending.then(async () => {
                  await updateGlobalConfig(options.configPath, (current) => ({
                    ...current,
                    ui: { ...current.ui, startupIntroSeen: true },
                  }));
                });
                saves.pending = saved.catch(() => {});
                return saved;
              }
            : undefined,
        onSetupComplete: setupOnly ? shutdown : undefined,
        clipboard,
        onSubmit: submit,
        onSubmitPhotos: (input, origin, images, accepted) =>
          submit(input, origin, undefined, undefined, undefined, undefined, {
            images,
            accepted,
          }),
        uiRedactor,
        onUiTool: submitUiTool,
        initialTheme: currentTheme,
        motion: preferences.config.ui?.motion,
        onMotionChange: (motion) => {
          const saved = saves.pending.then(async () => {
            await updateGlobalConfig(options.configPath, (current) => ({
              ...current,
              ui: { ...current.ui, motion },
            }));
          });
          saves.pending = saved.catch(() => {});
          return saved;
        },
        themeCatalog: extensionHost.themes,
        accent: preferences.config.ui?.accent,
        onThemeChange: (theme) => {
          const saved = saves.pending.then(async () => {
            await updateGlobalConfig(options.configPath, (current) => ({
              ...current,
              ui: { ...current.ui, theme },
            }));
            currentTheme = theme;
          });
          saves.pending = saved.catch(() => {});
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
    clearInterval(packageWatch);
    await reconcile;
    process.off("SIGINT", cancel);
    process.off("SIGTERM", shutdown);
    abort.abort();
    workspace.cancelAll();
    await workspace.waitForRuns();
    await migrating?.catch(() => {});
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
      saveTerminalDraft(
        { applicationId: workspace.home.draftId },
        undefined,
        workspace.home.snapshot.draft,
        { closed: true, images: workspace.home.snapshot.draftImages },
      ),
    );
    await cleanup(() =>
      Promise.all(
        [workspace.home, ...workspace.tabs.map((tab) => tab.controller)]
          .filter((controller) => !!controller.snapshot.projectPath)
          .map((controller) =>
            saveTerminalDraft(
              controller.snapshot.projectPath ?? {
                applicationId: workspace.home.draftId,
              },
              controller.snapshot.sessionId,
              controller.snapshot.draft,
              { images: controller.snapshot.draftImages },
            ),
          ),
      ),
    );
    await cleanup(() =>
      Promise.allSettled([...closingScopes, ...closingDrafts]),
    );
    await cleanup(() => root.unmount());
    await cleanup(() => updater.dispose());
    for (const controller of mcpProjects.values()) {
      await cleanup(() => controller.discard());
      await cleanup(() => controller.manager.dispose());
    }
    await cleanup(detachWorkspace);
    if (scrollback) await cleanup(scrollback.detach);
    await cleanup(() => workspace.dispose());
    await cleanup(() => renderer.destroy());
    await cleanup(() => saves.pending);
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
