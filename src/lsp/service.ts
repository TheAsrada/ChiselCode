import { pathToFileURL } from "node:url";
import { abortable, frozenClone } from "../extensions/lifecycle.js";
import { createServiceToken } from "../extensions/services.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { SecretRedactor } from "../security/redaction.js";
import { WorkspacePolicy } from "../security/workspace-policy.js";
import { workspaceCoordinator } from "../tools/workspace-coordinator.js";
import { VERSION } from "../version.js";
import {
  catalogPlatformAvailable,
  catalogServer,
  LSP_SERVER_CATALOG,
} from "./catalog.js";
import {
  configuredLanguage,
  effectiveLspMode,
  type LspConfiguration,
  type LspLaunch,
  type LspSelection,
  lspServerEnabled,
  resolveLspLaunch,
  selectLspServer,
} from "./config.js";
import type {
  DiagnosticResult,
  LspDiagnostic,
  LspManagedInstance,
  LspState,
  LspStatus,
  LspUiStatus,
} from "./contracts.js";
import { LspDocumentCache } from "./document-cache.js";
import {
  type LspReadPort,
  type Position,
  permittedLocation,
  type Range,
  readLspFile,
  safeRange,
  validatePosition,
} from "./documents.js";
import { LSP_LIMITS } from "./limits.js";
import { lspProjectRoot } from "./project-root.js";
import { safeText } from "./safe-text.js";
import type { Document, Server } from "./server-state.js";
import { type LspClock, LspTransport } from "./transport.js";

export type {
  DiagnosticFreshness,
  DiagnosticResult,
  LspDiagnostic,
  LspManagedInstance,
  LspState,
  LspStatus,
  LspUiStatus,
} from "./contracts.js";

const redactor = new SecretRedactor();

export const lspServiceToken = createServiceToken<LspService>(
  "builtin.lsp.service",
);

/** A trusted workspace analyser, not a filesystem/process/network sandbox. */
export class LspService {
  private readonly entries = new Map<string, Server>();
  private readonly documents: LspDocumentCache;
  private readonly lifetime = new AbortController();
  private closed = false;
  private cleanup?: Promise<void>;
  private configuration?: LspConfiguration;
  private configError?: string;
  private configurationReads = 0;
  private configurationApplied = 0;
  private preferred?: Server;
  private uiRevision = 0;
  private uiPending = false;
  private uiListeners = new Set<() => void>();
  private uiCache: Readonly<LspUiStatus>;
  private detachUiRevision: () => void;
  private readonly onAbort = () => {
    void this.dispose().catch(() => {});
  };

  constructor(
    readonly workspaceRoot: string,
    private readonly loadConfiguration: () => Promise<LspConfiguration>,
    private readonly workspaceSignal: AbortSignal,
    private readonly timers?: LspClock,
  ) {
    this.documents = new LspDocumentCache(
      workspaceRoot,
      this.entries,
      {
        closed: () => this.closed,
        signal: (caller, server) => this.signal(caller, server),
        configuration: () => this.configuration,
        changed: () => this.emitUi(),
      },
      timers,
    );
    workspaceSignal.addEventListener("abort", this.onAbort, { once: true });
    this.uiCache = this.projectUi();
    this.detachUiRevision = workspaceCoordinator.onChanged(() => {
      if (
        [...this.entries.values()].some(
          (entry) =>
            entry.revision !==
            workspaceCoordinator.revision([this.workspaceRoot]),
        )
      )
        this.emitUi();
    });
  }

  /** Cached data only: never configure, prepare, start, scan or acquire access. */
  uiStatus(): Readonly<LspUiStatus> {
    return this.uiCache;
  }
  /** Internal readonly management port. No preparation, process or filesystem reads. */
  managementEntries(): readonly LspManagedInstance[] {
    return frozenClone(
      [...this.entries.values()].map((entry) => ({
        serverId: entry.id,
        projectRoot: entry.projectRoot,
        state: entry.state,
        generation: entry.generation,
        requiresRestart: entry.requiresRestart,
        reason: entry.reason,
        version: entry.launch?.serverVersion,
        capabilities: this.features(entry),
        documents: [...entry.documents.values()].map((doc) => {
          const freshness =
            entry.requiresRestart ||
            entry.revision !==
              workspaceCoordinator.revision([this.workspaceRoot])
              ? ("stale" as const)
              : doc.freshness;
          return {
            path: doc.relativePath,
            freshness,
            diagnostics: ["current", "observed"].includes(freshness)
              ? doc.diagnostics.map((item) => ({
                  ...item,
                  message: safeText(item.message, 300),
                }))
              : [],
          };
        }),
      })),
    );
  }
  subscribeUi(changed: () => void): { dispose(): void } {
    this.uiListeners.add(changed);
    return {
      dispose: () => {
        this.uiListeners.delete(changed);
      },
    };
  }
  private projectUi(): Readonly<LspUiStatus> {
    const mode = this.configuration
      ? effectiveLspMode(this.configuration)
      : "unknown";
    const entries = [...this.entries.values()].filter(
      (entry) =>
        !this.configuration ||
        (mode !== "off" &&
          lspServerEnabled(this.configuration, entry.id).enabled &&
          (mode === "auto"
            ? !!catalogServer(entry.id)
            : !!this.configuration.global.servers[entry.id])),
    );
    const documents = entries.flatMap((entry) =>
      [...entry.documents.values()].map((doc) => ({
        doc,
        stale:
          entry.requiresRestart ||
          entry.revision !==
            workspaceCoordinator.revision([this.workspaceRoot]) ||
          doc.freshness === "stale",
      })),
    );
    const checked = documents.filter(
      ({ doc, stale }) =>
        !stale &&
        doc.diagnosticEvidence &&
        ["current", "observed"].includes(doc.freshness),
    );
    const diagnostics = checked.flatMap(({ doc }) => doc.diagnostics);
    const state = this.closed
      ? "disposed"
      : this.configError
        ? "unavailable"
        : mode === "off"
          ? "disabled"
          : (entries.find((entry) => entry.state === "error")?.state ??
            entries.find((entry) =>
              ["starting", "restarting"].includes(entry.state),
            )?.state ??
            entries.find((entry) => entry.state === "ready")?.state ??
            entries[0]?.state ??
            (mode === "unknown" ? "unknown" : "stopped"));
    return frozenClone({
      revision: this.uiRevision,
      workspaceRoot: this.workspaceRoot,
      mode,
      state,
      trackedDocuments: documents.length,
      checkedDocuments: checked.length,
      observedDocuments: checked.filter(
        ({ doc }) => doc.freshness === "observed",
      ).length,
      staleDocuments: documents.filter(({ stale }) => stale).length,
      diagnosticCount: diagnostics.length,
      requiresRestart: entries.some((entry) => entry.requiresRestart),
      generation: Math.max(0, ...entries.map((entry) => entry.generation)),
      diagnostics: diagnostics
        .slice(0, 256)
        .map((item) => ({ ...item, message: safeText(item.message, 300) })),
    });
  }
  private emitUi(): void {
    if (this.uiPending) return;
    this.uiPending = true;
    queueMicrotask(() => {
      this.uiPending = false;
      ++this.uiRevision;
      this.uiCache = this.projectUi();
      for (const listener of this.uiListeners) {
        try {
          listener();
        } catch {
          /* UI is passive. */
        }
      }
    });
  }

  private available(): void {
    if (this.closed || this.workspaceSignal.aborted)
      throw new RuntimeError("LSP_UNAVAILABLE", "LSP workspace is closed.");
  }
  private signal(caller?: AbortSignal, server?: Server): AbortSignal {
    return AbortSignal.any([
      this.lifetime.signal,
      this.workspaceSignal,
      ...(caller ? [caller] : []),
      ...(server ? [server.controller.signal] : []),
    ]);
  }
  private entry(id: string, projectRoot = this.workspaceRoot): Server {
    const key = `${id}\0${projectRoot}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= LSP_LIMITS.servers)
        throw new RuntimeError(
          "LSP_UNAVAILABLE",
          "Too many active language server project roots; restart/close the workspace to free resources.",
        );
      entry = {
        id,
        projectRoot,
        state: "stopped",
        generation: 0,
        controller: new AbortController(),
        documents: new Map(),
        locks: new Map(),
        capabilities: {},
        publications: 0,
        requiresRestart: false,
        revision: workspaceCoordinator.revision([this.workspaceRoot]),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }
  /** Reload without spawning; revocation fences data before awaited cleanup. */
  async refreshConfiguration(): Promise<void> {
    this.available();
    const read = ++this.configurationReads;
    const previousConfiguration = JSON.stringify(this.configuration);
    const previousView = JSON.stringify([
      this.configuration?.project?.serverId,
      this.configuration?.ignorePatterns,
    ]);
    try {
      const configuration = await this.loadConfiguration();
      if (read < this.configurationApplied) return;
      this.configurationApplied = read;
      this.configuration = configuration;
      this.configError = undefined;
    } catch {
      if (read < this.configurationApplied) return;
      this.configurationApplied = read;
      this.configuration = undefined;
      this.configError =
        "Не удалось прочитать LSP configuration. Проверьте Settings и .chiselrc.";
    }
    const viewChanged =
      previousView !==
      JSON.stringify([
        this.configuration?.project?.serverId,
        this.configuration?.ignorePatterns,
      ]);
    if (previousConfiguration !== JSON.stringify(this.configuration))
      this.emitUi();
    const configuration = this.configuration;
    const selections = await Promise.all(
      [...this.entries.values()].map(async (entry) => ({
        entry,
        selection: configuration
          ? await selectLspServer(this.workspaceRoot, configuration, entry.id)
          : { state: "unavailable" as const, reason: this.configError },
      })),
    );
    if (read !== this.configurationApplied) return;
    const stops: Server[] = [];
    // Fence every revoked root before awaiting any process cleanup.
    for (const { entry, selection } of selections) {
      if (viewChanged) this.documents.invalidate(entry);
      if (selection.state !== "stopped") {
        const changed =
          entry.state !== selection.state ||
          entry.reason !== selection.reason ||
          !entry.controller.signal.aborted;
        entry.state = selection.state;
        entry.reason = selection.reason ?? this.configError;
        entry.controller.abort();
        if (changed) this.documents.invalidate(entry);
        stops.push(entry);
        continue;
      }
      if (
        ["disabled", "untrusted", "unavailable"].includes(entry.state) &&
        !entry.transport &&
        !entry.pending
      ) {
        entry.state = "stopped";
        entry.reason = undefined;
        entry.requiresRestart = false;
        this.emitUi();
      }
    }
    const cleanup = await Promise.allSettled(
      stops.map(async (entry) => {
        await this.stopEntry(entry);
        await entry.pending?.catch(() => {});
      }),
    );
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    for (const { entry, selection } of selections) {
      if (read !== this.configurationApplied) return;
      if (selection.state !== "stopped") continue;
      if (entry.launch) {
        let launch: LspLaunch | undefined;
        try {
          launch = await resolveLspLaunch(this.workspaceRoot, selection);
        } catch {
          /* Changed or removed installations cannot keep serving. */
        }
        if (read !== this.configurationApplied) return;
        if (!launch || launch.fingerprint !== entry.launch.fingerprint) {
          entry.requiresRestart = true;
          entry.controller.abort();
          this.documents.invalidate(entry);
          entry.reason = "Конфигурация изменилась; нужен перезапуск.";
        }
      }
    }
  }
  private async selection(id?: string, path?: string): Promise<LspSelection> {
    await this.refreshConfiguration();
    if (!this.configuration)
      return { state: "unavailable", reason: this.configError };
    const preferredId = this.preferred?.id;
    const preferredApplicable =
      preferredId &&
      (effectiveLspMode(this.configuration) === "auto"
        ? !!catalogServer(preferredId)
        : !!this.configuration.global.servers[preferredId]);
    return selectLspServer(
      this.workspaceRoot,
      this.configuration,
      id ?? (!path && preferredApplicable ? preferredId : undefined),
      path,
    );
  }
  async status(serverId?: string): Promise<LspStatus> {
    if (this.closed)
      return {
        workspaceRoot: this.workspaceRoot,
        backend: "typescript",
        state: "disposed",
        generation: 0,
        trackedDocuments: 0,
        requiresRestart: false,
      };
    const selected = await this.selection(serverId);
    const entry = selected.id
      ? this.preferred?.id === selected.id
        ? this.preferred
        : [...this.entries.values()].find((item) => item.id === selected.id)
      : undefined;
    let state: LspState =
      selected.state === "stopped"
        ? (entry?.state ?? "stopped")
        : selected.state;
    let reason = selected.reason ?? entry?.reason;
    let launch: LspLaunch | undefined;
    if (selected.state === "stopped" && selected.id) {
      try {
        launch = await resolveLspLaunch(this.workspaceRoot, selected);
      } catch (error) {
        state = "unavailable";
        reason =
          error instanceof RuntimeError
            ? error.message
            : selected.kind === "auto"
              ? "Стандартный backend недоступен. Проверьте каталог данных ChiselCode."
              : "Сервер или TypeScript не найден/несовместим. Проверьте пути в Settings.";
      }
    }
    return {
      workspaceRoot: this.workspaceRoot,
      serverId: selected.id,
      backend:
        launch?.backend ??
        selected.descriptor?.id ??
        selected.config?.backend ??
        "typescript",
      state,
      generation: entry?.generation ?? 0,
      trackedDocuments: entry?.documents.size ?? 0,
      requiresRestart: entry?.requiresRestart ?? false,
      ...(this.configuration
        ? { mode: effectiveLspMode(this.configuration) }
        : {}),
      ...(launch
        ? {
            versions: {
              server: launch.serverVersion,
              typescript: launch.typescriptVersion,
              runtime:
                launch.command === process.execPath
                  ? `Bun ${Bun.version}`
                  : launch.backend === "typescript"
                    ? "Node (custom)"
                    : "native / SDK",
            },
          }
        : {}),
      ...(reason ? { reason } : {}),
      ...(entry?.transport ? { capabilities: this.features(entry) } : {}),
      servers: [...this.entries.values()].map((item) => ({
        serverId: item.id,
        projectRoot: item.projectRoot,
        state: item.state,
        generation: item.generation,
        trackedDocuments: item.documents.size,
        ...(item.reason ? { reason: item.reason } : {}),
      })),
      catalog: LSP_SERVER_CATALOG.map((item) => ({
        id: item.id,
        title: item.title,
        languages: item.languages.map((language) => language.id),
        version: item.version,
        platformAvailable: catalogPlatformAvailable(item),
        ...(item.prerequisites ? { prerequisites: item.prerequisites } : {}),
      })),
    };
  }
  private features(entry: Server): string[] {
    return [
      ["definition", "definitionProvider"],
      ["references", "referencesProvider"],
      ["symbols", "documentSymbolProvider"],
    ]
      .filter(([, field]) => Boolean(entry.capabilities[field ?? ""]))
      .map(([name]) => name ?? "");
  }
  private denied(selection: LspSelection): never {
    throw new RuntimeError(
      selection.state === "untrusted" ? "PERMISSION_DENIED" : "LSP_UNAVAILABLE",
      selection.reason ?? "Language server is unavailable.",
    );
  }
  async launchPreview(serverId?: string): Promise<LspLaunch> {
    const selected = await this.selection(serverId);
    if (selected.state !== "stopped" || !selected.id) this.denied(selected);
    return resolveLspLaunch(this.workspaceRoot, selected);
  }
  private async ensureEntry(
    signal?: AbortSignal,
    serverId?: string,
    path?: string,
    projectRoot?: string,
  ): Promise<Server> {
    cancelled(signal);
    this.available();
    const selected = await this.selection(serverId, path);
    if (selected.state !== "stopped" || !selected.id) this.denied(selected);
    const entry = this.entry(selected.id, projectRoot);
    this.preferred = entry;
    if (entry.cleanupTransport) await this.stopEntry(entry);
    if (entry.requiresRestart)
      await abortable(
        () => this.restartEntry(entry, selected),
        this.signal(signal),
      );
    if (entry.state === "error")
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        entry.reason ??
          "Сервер анализа недоступен. Перезапустите его в меню LSP.",
      );
    if (!entry.transport || entry.state !== "ready") {
      entry.pending ??= this.start(entry, selected).finally(() => {
        entry.pending = undefined;
      });
      await abortable(() => entry.pending, this.signal(signal));
    }
    cancelled(signal);
    return entry;
  }
  async ensureStarted(signal?: AbortSignal, serverId?: string): Promise<void> {
    await this.ensureEntry(signal, serverId);
  }
  async synchronizeDocument(
    path: string,
    port: LspReadPort,
  ): Promise<{ path: string; revision: string; version: number }> {
    return this.query(path, port, async (_entry, doc) => ({
      path: doc.relativePath,
      revision: doc.hash,
      version: doc.version,
    }));
  }
  private async start(entry: Server, selected: LspSelection): Promise<void> {
    this.available();
    entry.controller = new AbortController();
    const controller = entry.controller;
    if (entry.stopping) await entry.stopping;
    cancelled(controller.signal);
    entry.state = "starting";
    entry.reason = undefined;
    this.emitUi();
    const deadline = AbortSignal.timeout(LSP_LIMITS.preparationMs);
    const preparationSignal = AbortSignal.any([
      this.signal(undefined, entry),
      deadline,
    ]);
    let launch: LspLaunch;
    try {
      launch = await resolveLspLaunch(
        this.workspaceRoot,
        selected,
        true,
        preparationSignal,
      );
      cancelled(preparationSignal);
    } catch (error) {
      if (!controller.signal.aborted && entry.controller === controller) {
        if (
          deadline.aborted ||
          (error instanceof RuntimeError && error.code === "WEB_TIMEOUT")
        ) {
          // No server was spawned. Allow the next explicit analysis request
          // to reuse the verified cache and attempt preparation again.
          entry.state = "stopped";
          entry.reason =
            "Истекло время подготовки LSP. Проверьте сеть и повторите анализ.";
          this.emitUi();
          throw new RuntimeError("TOOL_TIMEOUT", entry.reason);
        }
        entry.state = "error";
        entry.reason =
          "Не удалось подготовить LSP. Проверьте настройки или установку и перезапустите LSP.";
        this.emitUi();
      }
      throw error;
    }
    this.available();
    const latest = await this.loadConfiguration();
    cancelled(preparationSignal);
    const permission = await selectLspServer(
      this.workspaceRoot,
      latest,
      entry.id,
    );
    if (permission.state !== "stopped") this.denied(permission);
    if (
      (await resolveLspLaunch(this.workspaceRoot, permission)).fingerprint !==
      launch.fingerprint
    )
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "LSP configuration changed before spawn; retry.",
      );
    cancelled(preparationSignal);
    this.available();
    entry.state = "starting";
    this.emitUi();
    entry.reason = undefined;
    entry.requiresRestart = false;
    const generation = ++entry.generation;
    entry.launch = launch;
    let transport: LspTransport;
    try {
      transport = new LspTransport(
        entry.projectRoot,
        launch,
        () => {
          if (entry.generation !== generation || entry.transport !== transport)
            return;
          entry.state = "error";
          entry.reason = "Сервер анализа завершился. Перезапустите его явно.";
          entry.controller.abort();
          this.documents.invalidate(entry);
        },
        this.timers,
      );
    } catch (error) {
      entry.state = "error";
      entry.reason =
        "Не удалось запустить language server. Проверьте runtime и process-tree support; затем перезапустите.";
      this.emitUi();
      entry.controller.abort();
      throw error;
    }
    entry.transport = transport;
    transport.onNotification("textDocument/publishDiagnostics", (payload) => {
      void this.documents.publish(entry, generation, payload).catch(() => {});
    });
    try {
      const initialized = await transport.request<{
        capabilities?: Record<string, unknown>;
      }>(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "ChiselCode", version: VERSION },
          rootUri: selected.descriptor?.singleFileOnly
            ? null
            : pathToFileURL(entry.projectRoot).href,
          workspaceFolders: selected.descriptor?.singleFileOnly
            ? []
            : [
                {
                  uri: pathToFileURL(entry.projectRoot).href,
                  name: "workspace",
                },
              ],
          capabilities: {
            general: { positionEncodings: ["utf-16"] },
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: true },
              definition: { linkSupport: true },
              references: { dynamicRegistration: false },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              publishDiagnostics: {
                versionSupport: true,
                relatedInformation: true,
              },
              diagnostic: {
                dynamicRegistration: false,
                relatedDocumentSupport: false,
              },
            },
            workspace: {
              configuration:
                !selected.descriptor?.configurationViaNotificationOnly,
              applyEdit: false,
              workspaceFolders: true,
            },
          },
          initializationOptions:
            launch.backend === "typescript" || !launch.backend
              ? {
                  disableAutomaticTypingAcquisition: true,
                  plugins: [],
                  tsserver: {
                    path: launch.typescriptPath,
                    fallbackPath: launch.typescriptPath,
                    logVerbosity: "off",
                    trace: "off",
                    useSyntaxServer: "never",
                    useClientFileWatcher: false,
                  },
                }
              : (launch.initializationOptions ?? {}),
          trace: "off",
        },
        this.signal(undefined, entry),
        LSP_LIMITS.initializeMs,
      );
      entry.capabilities = initialized.capabilities ?? {};
      if (
        entry.capabilities.positionEncoding &&
        entry.capabilities.positionEncoding !== "utf-16"
      )
        throw new RuntimeError(
          "LSP_UNSUPPORTED",
          "Server requires an unsupported position encoding.",
        );
      await transport.notification("initialized", {});
      if (launch.settings && Object.keys(launch.settings).length)
        await transport.notification("workspace/didChangeConfiguration", {
          settings: launch.settings,
        });
      this.available();
      if (entry.generation !== generation || entry.controller.signal.aborted)
        throw new RuntimeError(
          "LSP_UNAVAILABLE",
          "Language server generation changed during initialization.",
        );
      entry.state = "ready";
      this.emitUi();
      entry.revision = workspaceCoordinator.revision([this.workspaceRoot]);
    } catch (error) {
      if (!controller.signal.aborted && entry.controller === controller) {
        entry.state = "error";
        entry.reason =
          launch.kind === "auto"
            ? "Не удалось запустить стандартный анализ кода. Перезапустите LSP; проверьте установку ChiselCode."
            : "Не удалось выполнить initialize. Проверьте совместимость и пути собственного stdio LSP; затем перезапустите.";
        this.emitUi();
      }
      await this.stopEntry(entry);
      if (
        error instanceof RuntimeError &&
        error.code === "CANCELLED" &&
        !this.signal().aborted
      ) {
        const closed = new RuntimeError(
          "LSP_UNAVAILABLE",
          "Сервер завершился или был выключен во время initialize. Проверьте состояние и перезапустите его явно.",
        );
        if (error.cause)
          Object.defineProperty(closed, "cause", { value: error.cause });
        throw closed;
      }
      throw error;
    }
  }
  private async stopEntry(entry: Server): Promise<void> {
    entry.controller.abort();
    const transport = entry.transport ?? entry.cleanupTransport;
    entry.transport = undefined;
    if (transport) {
      entry.cleanupTransport = transport;
      entry.stopping ??= transport
        .dispose()
        .then(() => {
          if (entry.cleanupTransport === transport)
            entry.cleanupTransport = undefined;
        })
        .finally(() => {
          entry.stopping = undefined;
        });
    }
    await entry.stopping;
  }
  async restart(serverId?: string, signal?: AbortSignal): Promise<LspStatus> {
    cancelled(signal);
    const selected = await this.selection(serverId);
    if (selected.state !== "stopped" || !selected.id) this.denied(selected);
    const entries = [...this.entries.values()].filter(
      (item) => item.id === selected.id,
    );
    if (!entries.length) entries.push(this.entry(selected.id));
    // Restart itself is cooperative: once stop starts its cleanup finishes before cancellation returns.
    for (const entry of entries) {
      this.preferred = entry;
      await this.restartEntry(entry, selected, signal);
    }
    return this.status(selected.id);
  }
  private restartEntry(
    entry: Server,
    selected: LspSelection,
    signal?: AbortSignal,
  ): Promise<void> {
    entry.restarting ??= this.restartNow(entry, selected, signal).finally(
      () => {
        entry.restarting = undefined;
      },
    );
    return entry.restarting;
  }
  private async restartNow(
    entry: Server,
    selected: LspSelection,
    signal?: AbortSignal,
  ): Promise<void> {
    if (entry.pending) {
      entry.controller.abort();
      await entry.pending.catch(() => {});
    }
    const reopen = [...entry.documents.values()].map((doc) => doc.relativePath);
    entry.state = "restarting";
    this.emitUi();
    this.documents.invalidate(entry);
    await this.stopEntry(entry);
    entry.documents.clear();
    this.emitUi();
    cancelled(signal);
    const fresh = await this.selection(entry.id);
    if (fresh.state !== "stopped") this.denied(fresh);
    entry.pending = this.start(entry, fresh).finally(() => {
      entry.pending = undefined;
    });
    await entry.pending;
    cancelled(signal);
    const port = {
      policy: new WorkspacePolicy(
        this.workspaceRoot,
        this.configuration?.ignorePatterns ?? [],
      ),
      signal: this.signal(signal, entry),
    };
    for (const path of reopen) {
      try {
        await this.documents.syncDocument(
          entry,
          await readLspFile(
            {
              ...port,
              languageId: this.configuration
                ? configuredLanguage(this.configuration, path)
                : undefined,
            },
            path,
          ),
        );
      } catch {
        cancelled(signal); /* Removed/ignored files are not reopened. */
      }
    }
    void selected;
  }
  private async query<T>(
    path: string,
    port: LspReadPort,
    operation: (
      entry: Server,
      doc: Document,
      signal: AbortSignal,
      policy: WorkspacePolicy,
    ) => Promise<T>,
  ): Promise<T> {
    this.available();
    cancelled(port.signal);
    // Do not start Auto for an unsupported, ignored, missing or invalid document.
    // Re-read after initialize/refresh below so bytes changed during startup are
    // never sent from this preflight and only the final read grants observation.
    await this.refreshConfiguration();
    const languageId = this.configuration
      ? configuredLanguage(this.configuration, path)
      : undefined;
    if (!languageId)
      throw new RuntimeError(
        "LSP_UNSUPPORTED",
        "Язык не поддержан текущим Auto/custom набором. Подключите совместимый stdio сервер в Settings.",
      );
    const preflight = await readLspFile(
      { ...port, observe: undefined, languageId },
      path,
    );
    const selected = await this.selection(undefined, path);
    if (selected.state !== "stopped") this.denied(selected);
    const projectRoot = await lspProjectRoot(
      port.policy,
      preflight.path,
      selected.descriptor,
      port.signal,
    );
    const entry = await this.ensureEntry(
      port.signal,
      selected.id,
      path,
      projectRoot,
    );
    const signal = this.signal(port.signal, entry);
    const policy = new WorkspacePolicy(this.workspaceRoot, [
      ...new Set([
        ...(this.configuration?.ignorePatterns ?? []),
        ...port.policy.ignorePatterns,
      ]),
    ]);
    const readPort = { ...port, policy, signal, languageId };
    const policyFingerprint = JSON.stringify(
      this.configuration?.ignorePatterns ?? [],
    );
    await this.documents.refreshDocuments(entry, readPort);
    const file = await readLspFile(readPort, path);
    return this.documents
      .serialize(entry, file.path, signal, async () => {
        const doc = await this.documents.syncDocument(entry, file);
        const generation = entry.generation;
        const revision = workspaceCoordinator.revision([this.workspaceRoot]);
        const result = await operation(entry, doc, signal, policy);
        cancelled(port.signal);
        await this.refreshConfiguration();
        if (
          entry.generation !== generation ||
          entry.state !== "ready" ||
          entry.requiresRestart ||
          signal.aborted
        )
          throw new RuntimeError(
            "LSP_UNAVAILABLE",
            "Language server configuration or generation changed.",
          );
        if (
          JSON.stringify(this.configuration?.ignorePatterns ?? []) !==
          policyFingerprint
        ) {
          this.documents.invalidate(entry);
          throw new RuntimeError(
            "PERMISSION_DENIED",
            "Workspace ignore policy changed during LSP request. Retry with the current policy.",
          );
        }
        const selectedNow = this.configuration
          ? await selectLspServer(
              this.workspaceRoot,
              this.configuration,
              entry.id,
              path,
            )
          : undefined;
        if (selectedNow?.state !== "stopped" || selectedNow.id !== entry.id) {
          this.documents.invalidate(entry);
          throw new RuntimeError(
            "LSP_UNAVAILABLE",
            "Effective project server changed during LSP request.",
          );
        }
        for (const tracked of entry.documents.values()) {
          const checked = await readLspFile(
            { ...readPort, observe: undefined, languageId: tracked.languageId },
            tracked.relativePath,
          );
          if (checked.hash !== tracked.hash) {
            this.documents.invalidate(entry);
            throw new RuntimeError(
              "STALE_FILE_REVISION",
              "A tracked dependency changed during LSP request.",
            );
          }
        }
        const current = await readLspFile(
          { ...readPort, observe: undefined },
          path,
        );
        if (
          current.hash !== doc.hash ||
          revision !== workspaceCoordinator.revision([this.workspaceRoot])
        ) {
          this.documents.invalidate(entry);
          throw new RuntimeError(
            "STALE_FILE_REVISION",
            "Document changed while the language server was analysing it. Retry with current bytes.",
          );
        }
        return result;
      })
      .catch((error) => {
        cancelled(port.signal);
        if (signal.aborted)
          throw new RuntimeError(
            "LSP_UNAVAILABLE",
            "LSP generation closed during request.",
          );
        throw error;
      });
  }
  async diagnostics(
    path: string,
    port: LspReadPort,
  ): Promise<DiagnosticResult> {
    return this.query(path, port, async (entry, doc, signal, policy) => {
      if (entry.capabilities.diagnosticProvider) {
        const provider = entry.capabilities.diagnosticProvider as {
          identifier?: unknown;
        };
        const report = await entry.transport?.request<{
          kind?: unknown;
          items?: unknown;
        }>(
          "textDocument/diagnostic",
          {
            textDocument: { uri: doc.uri },
            ...(typeof provider.identifier === "string"
              ? { identifier: provider.identifier }
              : {}),
          },
          signal,
        );
        if (report?.kind !== "full" || !Array.isArray(report.items))
          throw new RuntimeError(
            "LSP_PROTOCOL_ERROR",
            "Language server returned an invalid document diagnostic report.",
          );
        await this.documents.recordDiagnostics(
          entry,
          entry.generation,
          doc,
          report.items,
          policy,
          "pull_request",
        );
      } else if (doc.freshness === "pending" || doc.freshness === "stale") {
        await this.documents.waitForDiagnostics(doc, signal);
      }
      const freshness =
        doc.freshness === "pending" || doc.freshness === "stale"
          ? "unavailable"
          : doc.freshness;
      return {
        path: doc.relativePath,
        revision: doc.hash,
        generation: entry.generation,
        freshness,
        provenance:
          freshness === "current"
            ? doc.diagnosticEvidence === "pull_request"
              ? "Server answered the diagnostic request after this document was synchronized; revision/generation revalidated."
              : "Server confirmed this document version."
            : freshness === "observed"
              ? "Получено от сервера; версия анализа не подтверждена. Пустой набор не подтверждает отсутствие ошибок."
              : "Подтверждённого результата проверки пока нет.",
        diagnostics:
          freshness === "current" || freshness === "observed"
            ? structuredClone(doc.diagnostics)
            : [],
        omitted: doc.omitted,
      };
    });
  }
  async definition(
    path: string,
    position: Position,
    port: LspReadPort,
  ): Promise<unknown> {
    return this.locations("definition", path, position, port);
  }
  async references(
    path: string,
    position: Position,
    includeDeclaration: boolean,
    port: LspReadPort,
  ): Promise<unknown> {
    return this.locations("references", path, position, port, {
      includeDeclaration,
    });
  }
  private async locations(
    feature: "definition" | "references",
    path: string,
    position: Position,
    port: LspReadPort,
    context?: unknown,
  ): Promise<unknown> {
    return this.query(path, port, async (entry, doc, signal, policy) => {
      validatePosition(doc.text, position);
      if (!entry.capabilities[`${feature}Provider`])
        throw new RuntimeError(
          "LSP_UNSUPPORTED",
          `Server does not support ${feature}.`,
        );
      const response = await entry.transport?.request<unknown>(
        `textDocument/${feature}`,
        {
          textDocument: { uri: doc.uri },
          position,
          ...(context ? { context } : {}),
        },
        signal,
      );
      const items =
        response === null
          ? []
          : Array.isArray(response)
            ? response
            : [response];
      const locations = [];
      let omitted = Math.max(0, items.length - LSP_LIMITS.locations);
      for (const item of items.slice(0, LSP_LIMITS.locations)) {
        const location = await permittedLocation(policy, item);
        if (location) locations.push(location);
        else ++omitted;
      }
      return {
        path: doc.relativePath,
        revision: doc.hash,
        generation: entry.generation,
        locations,
        omitted,
        ...(omitted
          ? {
              omissionReason:
                "External, ignored, unsafe or over-limit locations were omitted.",
            }
          : {}),
      };
    });
  }
  async documentSymbols(path: string, port: LspReadPort): Promise<unknown> {
    return this.query(path, port, async (entry, doc, signal, policy) => {
      if (!entry.capabilities.documentSymbolProvider)
        throw new RuntimeError(
          "LSP_UNSUPPORTED",
          "Server does not support document symbols.",
        );
      const response = await entry.transport?.request<unknown>(
        "textDocument/documentSymbol",
        { textDocument: { uri: doc.uri } },
        signal,
      );
      if (response === null)
        return {
          path: doc.relativePath,
          revision: doc.hash,
          generation: entry.generation,
          symbols: [],
          omitted: 0,
        };
      if (!Array.isArray(response))
        throw new RuntimeError(
          "LSP_PROTOCOL_ERROR",
          "Invalid document symbols response.",
        );
      const symbols: {
        path: string;
        name: string;
        kind: number;
        range: Range;
        parents: string[];
      }[] = [];
      const queue = response.slice(0, LSP_LIMITS.symbols).map((value) => ({
        value,
        parents: [] as string[],
      }));
      let omitted = Math.max(0, response.length - queue.length);
      while (queue.length && symbols.length < LSP_LIMITS.symbols) {
        const { value, parents } = queue.shift() as {
          value: Record<string, unknown>;
          parents: string[];
        };
        if (!value || typeof value !== "object") {
          ++omitted;
          continue;
        }
        const location = value.location
          ? await permittedLocation(policy, value.location)
          : {
              path: doc.relativePath,
              range: safeRange(value.selectionRange ?? value.range),
            };
        if (
          !location?.range ||
          typeof value.name !== "string" ||
          !Number.isInteger(value.kind)
        ) {
          ++omitted;
          continue;
        }
        const name = safeText(value.name, 512);
        symbols.push({
          path: location.path,
          name,
          kind: Number(value.kind),
          range: location.range,
          parents,
        });
        if (Array.isArray(value.children)) {
          const children = value.children.slice(0, LSP_LIMITS.symbols);
          omitted += value.children.length - children.length;
          queue.unshift(
            ...children.map((child) => ({
              value: child,
              parents: [...parents, name],
            })),
          );
          const remaining = LSP_LIMITS.symbols - symbols.length;
          if (queue.length > remaining) {
            omitted += queue.length - remaining;
            queue.length = remaining;
          }
        }
      }
      omitted += queue.length;
      return {
        path: doc.relativePath,
        revision: doc.hash,
        generation: entry.generation,
        symbols,
        omitted,
      };
    });
  }
  async collectContext(signal?: AbortSignal): Promise<string | undefined> {
    this.available();
    cancelled(signal);
    const deadline = AbortSignal.timeout(LSP_LIMITS.contextMs);
    const bounded = this.signal(
      AbortSignal.any([deadline, ...(signal ? [signal] : [])]),
    );
    try {
      return await abortable(async () => {
        await this.refreshConfiguration();
        const entries = [...this.entries.values()].filter(
          (entry) =>
            entry.transport &&
            entry.state === "ready" &&
            !entry.requiresRestart &&
            entry.documents.size,
        );
        if (!entries.length || !this.configuration) return undefined;
        return workspaceCoordinator.withAccess(
          [this.workspaceRoot],
          "read",
          bounded,
          async () => {
            const policyFingerprint = JSON.stringify(
              this.configuration?.ignorePatterns ?? [],
            );
            const policy = new WorkspacePolicy(
              this.workspaceRoot,
              this.configuration?.ignorePatterns ?? [],
            );
            const diagnostics: LspDiagnostic[] = [];
            const lines: string[] = [];
            const generations: [Server, number][] = [];
            for (const entry of entries) {
              cancelled(bounded);
              const selection = this.configuration
                ? await selectLspServer(
                    this.workspaceRoot,
                    this.configuration,
                    entry.id,
                  )
                : undefined;
              if (selection?.state !== "stopped") continue;
              await this.documents.refreshDocuments(
                entry,
                { policy, signal: bounded },
                false,
              );
              if (entry.state !== "ready" || entry.requiresRestart) continue;
              generations.push([entry, entry.generation]);
              let observed = 0;
              for (const doc of entry.documents.values()) {
                if (doc.generation !== entry.generation) continue;
                if (doc.freshness === "current")
                  diagnostics.push(...doc.diagnostics);
                else ++observed;
              }
              lines.push(`LSP ${entry.id}: ready; tracked documents only.`);
              if (observed)
                lines.push(
                  `${entry.id}: some diagnostics are pending/observed; their analysis version is not confirmed. They are not included as current errors.`,
                );
            }
            if (!lines.length) return undefined;
            diagnostics.sort(
              (a, b) =>
                a.severity - b.severity ||
                a.path.localeCompare(b.path) ||
                a.range.start.line - b.range.start.line ||
                a.range.start.character - b.range.start.character,
            );
            let included = 0;
            for (const item of diagnostics.slice(
              0,
              LSP_LIMITS.contextDiagnostics,
            )) {
              const line = `${item.path}:${item.range.start.line}:${item.range.start.character} severity ${item.severity}: ${item.message}`;
              if (
                Buffer.byteLength([...lines, line].join("\n")) >
                LSP_LIMITS.contextBytes - 160
              )
                break;
              lines.push(line);
              ++included;
            }
            if (diagnostics.length > included)
              lines.push(
                `${diagnostics.length - included} diagnostics omitted by context budget.`,
              );
            await this.refreshConfiguration();
            cancelled(bounded);
            if (
              JSON.stringify(this.configuration?.ignorePatterns ?? []) !==
                policyFingerprint ||
              generations.some(
                ([entry, generation]) =>
                  entry.state !== "ready" ||
                  entry.generation !== generation ||
                  entry.requiresRestart,
              )
            )
              return undefined;
            return redactor.text(lines.join("\n"));
          },
        );
      }, bounded);
    } catch {
      cancelled(signal);
      return undefined;
    }
  }
  dispose(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.detachUiRevision();
    this.emitUi();
    this.lifetime.abort();
    this.workspaceSignal.removeEventListener("abort", this.onAbort);
    this.cleanup = (async () => {
      const errors: unknown[] = [];
      for (const entry of this.entries.values()) {
        entry.state = "disposed";
        this.emitUi();
        this.documents.invalidate(entry);
        try {
          await this.stopEntry(entry);
          await entry.pending?.catch(() => {});
        } catch (error) {
          errors.push(error);
        }
        entry.documents.clear();
        this.emitUi();
        entry.locks.clear();
      }
      this.entries.clear();
      if (errors.length)
        throw new AggregateError(errors, "LSP cleanup failed.");
    })();
    return this.cleanup;
  }
}
