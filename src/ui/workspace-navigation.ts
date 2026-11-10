import { type RunOptions } from "../commands/run.js";
import { loadProjectConfig } from "../config/load.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import { abortable } from "../extensions/lifecycle.js";
import {
  admitWorkspace,
  WorkspaceAdmissionError,
} from "../projects/admission.js";
import { DirectoryBrowser } from "../projects/navigation.js";
import { ProjectOpenService } from "../projects/opening.js";
import type { ApplicationPaths } from "../projects/paths.js";
import {
  isPrivatePath,
  managedWorkspaceCandidate,
  pathIdentity,
} from "../projects/paths.js";
import { resolveApprovalMode } from "../security/approval-mode.js";
import {
  type HistoryEntry,
  SessionHistoryCatalog,
} from "../sessions/history.js";
import { projectSessionStore } from "../sessions/project-store.js";
import type { Session } from "../types/domain.js";
import type { OpenTuiProjectsActions } from "./opentui-projects.js";
import type { OpenTuiSessionsActions } from "./opentui-sessions.js";
import { loadTerminalDraft, saveTerminalDraft } from "./terminal-drafts.js";
import type { TuiPresentationController as TuiController } from "./tui-controller.js";
import { TuiWorkspace } from "./tui-workspace.js";

export function createWorkspaceNavigation({
  currentController,
  navigationBase,
  abort,
  projectOpener,
  activeSkills,
  workspace,
  skillNames,
  appPaths,
  isBypassAvailable,
  persistExecutionModes,
  restoreSubagentControls,
  warmModelCapabilities,
  options,
}: {
  currentController: () => TuiController;
  navigationBase: string;
  abort: AbortController;
  projectOpener: ProjectOpenService<WorkspaceExtensionScope>;
  activeSkills: (controller?: TuiController) => Set<string>;
  workspace: TuiWorkspace;
  skillNames: WeakMap<
    TuiController,
    { generation: number; names: Set<string> }
  >;
  appPaths: ApplicationPaths;
  isBypassAvailable: () => boolean;
  persistExecutionModes: (controller: TuiController) => void;
  restoreSubagentControls: (
    controller: TuiController,
    session: Session,
  ) => Promise<void>;
  warmModelCapabilities: (controller: TuiController) => void;
  options: RunOptions;
}) {
  const getProjectActions = (): OpenTuiProjectsActions => {
    const owner = currentController(),
      generation = owner.currentGeneration;
    const base = owner.snapshot.projectPath ?? navigationBase;
    const browser = new DirectoryBrowser(base);
    return {
      base,
      cached: (path) => browser.cached(path),
      browse: (path, signal, offset) => {
        const bounded = AbortSignal.any([
          signal,
          abort.signal,
          AbortSignal.timeout(10_000),
        ]);
        return abortable(() => browser.browse(path, bounded, offset), bounded);
      },
      cancel: () => {
        browser.dispose();
        projectOpener.cancel();
      },
      open: async (path) => {
        const ref = await projectOpener.open(
          path,
          {
            base: owner.snapshot.projectPath ?? navigationBase,
            signal: AbortSignal.any([owner.ownerSignal, abort.signal]),
            isCurrent: () =>
              !abort.signal.aborted &&
              owner.isCurrent(generation) &&
              currentController() === owner,
          },
          (ref) => {
            const pinned = new Set(activeSkills(workspace.home));
            workspace.home.selectProject(ref);
            skillNames.set(workspace.home, {
              generation: workspace.home.currentGeneration,
              names: pinned,
            });
            workspace.select();
          },
          owner === workspace.home
            ? () =>
                saveTerminalDraft(
                  { applicationId: workspace.home.draftId },
                  undefined,
                  owner.snapshot.draft,
                )
            : undefined,
        );
        await projectSessionStore(ref.root).catch((cause) => {
          if (workspace.home.snapshot.projectPath === ref.root)
            workspace.home.append(
              `Не удалось сохранить недавний проект: ${String(cause)}`,
              "error",
            );
        });
        const draftOwner = workspace.home,
          draftGeneration = draftOwner.currentGeneration;
        const draftRevision = draftOwner.currentDraftRevision;
        if (!draftOwner.snapshot.draft) {
          const draft = await loadTerminalDraft(ref.root).catch((cause) => {
            if (draftOwner.isCurrent(draftGeneration))
              draftOwner.append(
                `Не удалось восстановить черновик: ${String(cause)}`,
                "error",
              );
            return undefined;
          });
          if (
            draft !== undefined &&
            draftOwner.isCurrent(draftGeneration) &&
            draftOwner.currentDraftRevision === draftRevision &&
            !draftOwner.snapshot.draft
          )
            draftOwner.setDraft(draft);
        }
      },
    };
  };

  const history = new SessionHistoryCatalog();

  const isArchive = ({ store }: HistoryEntry) =>
    isPrivatePath(appPaths, store.project.canonicalPath) &&
    !managedWorkspaceCandidate(appPaths.home, store.project.canonicalPath);

  const admitHistory = async (entry: HistoryEntry, signal?: AbortSignal) => {
    if (isArchive(entry))
      throw new Error("Служебный архив доступен только для просмотра.");
    const admitted = await admitWorkspace(entry.store.project.path, {
      source: "resume",
      configPath: options.configPath,
      signal,
    });
    if (admitted.root !== pathIdentity(entry.store.project.canonicalPath))
      throw new WorkspaceAdmissionError(
        "WORKSPACE_CHANGED",
        "Исходная папка истории изменилась.",
      );
  };

  const resume = async (ref: string): Promise<void> => {
    const owner = currentController(),
      generation = owner.currentGeneration;
    const signal = AbortSignal.any([
      owner.ownerSignal,
      abort.signal,
      AbortSignal.timeout(15_000),
    ]);
    const isCurrent = () =>
      !signal.aborted &&
      owner.isCurrent(generation) &&
      currentController() === owner;
    const assertOwner = () => {
      if (!isCurrent()) throw new Error("Открытие истории отменено.");
    };
    const selected = await history.resolve(ref);
    const store = selected.store;
    const candidate = await store.load(selected.summary.sessionId);
    assertOwner();
    await abortable(() => admitHistory(selected, signal), signal);
    assertOwner();
    const existing = workspace.tabs.find(
      ({ controller }) =>
        controller.snapshot.sessionId === candidate.id &&
        pathIdentity(controller.snapshot.projectPath) ===
          pathIdentity(candidate.projectPath),
    );
    if (existing) {
      workspace.select(existing.key);
      return;
    }
    const session = await store.interruptSideQueries(candidate.id);
    assertOwner();
    const project = await abortable(
      () => loadProjectConfig(session.projectPath),
      signal,
    );
    assertOwner();
    session.approvalMode = resolveApprovalMode({
      saved: session.approvalMode,
      autoApprove: project.autoApprove,
      allowBypassPermissions: isBypassAvailable(),
    });
    let controller: TuiController | undefined;
    await projectOpener.open(
      session.projectPath,
      {
        base: navigationBase,
        signal,
        isCurrent,
      },
      (_ref, scope) => {
        controller = workspace.openSession(session, scope.chat);
      },
    );
    if (!controller) return;
    const restoredController = controller;
    const restoredGeneration = controller.currentGeneration;
    const restoredRevision = controller.currentDraftRevision;
    const draft = await loadTerminalDraft(
      session.projectPath,
      session.id,
    ).catch((cause) => {
      restoredController.append(
        `Не удалось восстановить черновик: ${String(cause)}`,
        "error",
      );
      return undefined;
    });
    if (
      draft !== undefined &&
      controller.isCurrent(restoredGeneration) &&
      controller.currentDraftRevision === restoredRevision &&
      !controller.snapshot.draft
    )
      controller.setDraft(draft);
    persistExecutionModes(controller);
    await restoreSubagentControls(controller, session);
    warmModelCapabilities(controller);
  };

  const sessionPicker: OpenTuiSessionsActions = {
    load: async () => {
      return (await history.list()).map((entry) => ({
        ...entry.summary,
        archive: isArchive(entry),
      }));
    },
    preview: async (id) => {
      const entry = await history.resolve(id);
      return entry.store.load(entry.summary.sessionId);
    },
    resume,
    rename: async (id, title) => {
      const entry = await history.resolve(id);
      await admitHistory(entry);
      const store = entry.store;
      await store.rename(entry.summary.sessionId, title);
      const session = await store.load(entry.summary.sessionId);
      for (const tab of workspace.tabs) {
        if (
          tab.controller.snapshot.sessionId === session.id &&
          pathIdentity(tab.controller.snapshot.projectPath) ===
            pathIdentity(session.projectPath)
        )
          tab.controller.setSessionUsage(session);
      }
    },
    delete: async (id) => {
      const entry = await history.resolve(id);
      await admitHistory(entry);
      const projectPath = pathIdentity(entry.store.project.path);
      const tabs = workspace.tabs.filter(
        ({ controller }) =>
          controller.snapshot.sessionId === entry.summary.sessionId &&
          pathIdentity(controller.snapshot.projectPath) === projectPath,
      );
      if (
        tabs.some(
          ({ controller }) =>
            controller.snapshot.busy ||
            workspace.execution(controller).closeBlocked,
        )
      )
        throw new Error("Сначала остановите активные задачи разговора.");
      await entry.store.delete(entry.summary.sessionId);
      for (const tab of tabs) workspace.close(tab.key);
    },
    activeId: () => currentController().snapshot.sessionId,
  };
  return { getProjectActions, resume, sessionPicker };
}
