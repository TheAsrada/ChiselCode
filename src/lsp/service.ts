import { pathToFileURL } from "node:url";
import { abortable } from "../extensions/lifecycle.js";
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
  type LspMode,
  type LspSelection,
  resolveLspLaunch,
  selectLspServer,
} from "./config.js";
import {
  documentEnd,
  type LspFile,
  type LspReadPort,
  type Position,
  permittedLocation,
  type Range,
  readLspFile,
  resolveLspUri,
  safeRange,
  validatePosition,
} from "./documents.js";
import { LSP_LIMITS } from "./limits.js";
import { lspProjectRoot } from "./project-root.js";
import { type LspClock, LspTransport } from "./transport.js";

export type DiagnosticFreshness =
  | "pending"
  | "current"
  | "observed"
  | "stale"
  | "unavailable";
export type LspState =
  | "disabled"
  | "untrusted"
  | "unavailable"
  | "stopped"
  | "starting"
  | "ready"
  | "restarting"
  | "error"
  | "disposed";
export interface LspDiagnostic {
  path: string;
  range: Range;
  severity: number;
  message: string;
  code?: string | number;
  source?: string;
  relatedInformation?: { path: string; range: Range; message: string }[];
}
export interface LspStatus {
  workspaceRoot: string;
  serverId?: string;
  backend: string;
  state: LspState;
  generation: number;
  trackedDocuments: number;
  requiresRestart: boolean;
  mode?: LspMode;
  versions?: { server: string; typescript?: string; runtime: string };
  servers?: readonly {
    serverId: string;
    projectRoot: string;
    state: LspState;
    generation: number;
    trackedDocuments: number;
    reason?: string;
  }[];
  catalog?: readonly {
    id: string;
    title: string;
    languages: readonly string[];
    version: string;
    prerequisites?: string;
    platformAvailable?: boolean;
  }[];
  reason?: string;
  capabilities?: readonly string[];
}
interface Document extends LspFile {
  version: number;
  generation: number;
  freshness: DiagnosticFreshness;
  diagnostics: LspDiagnostic[];
  omitted: number;
  serial: number;
  notificationSerial?: number;
  accessed: number;
}
interface Server {
  id: string;
  projectRoot: string;
  state: LspState;
  generation: number;
  launch?: LspLaunch;
  transport?: LspTransport;
  pending?: Promise<void>;
  controller: AbortController;
  documents: Map<string, Document>;
  locks: Map<string, Promise<unknown>>;
  capabilities: Record<string, unknown>;
  publications: number;
  reason?: string;
  requiresRestart: boolean;
  stopping?: Promise<void>;
  restarting?: Promise<void>;
  revision: number;
}
export interface DiagnosticResult {
  path: string;
  revision: string;
  generation: number;
  freshness: DiagnosticFreshness;
  provenance: string;
  diagnostics: LspDiagnostic[];
  omitted: number;
}
const redactor = new SecretRedactor();
const safeText = (value: unknown, maximum = 2048) =>
  redactor.text(typeof value === "string" ? value : "").slice(0, maximum);
export const lspServiceToken = createServiceToken<LspService>(
  "builtin.lsp.service",
);

/** A trusted workspace analyser, not a filesystem/process/network sandbox. */
export class LspService {
  private readonly entries = new Map<string, Server>();
  private readonly lifetime = new AbortController();
  private closed = false;
  private cleanup?: Promise<void>;
  private configuration?: LspConfiguration;
  private configError?: string;
  private configurationReads = 0;
  private configurationApplied = 0;
  private preferred?: Server;
  private readonly onAbort = () => {
    void this.dispose().catch(() => {});
  };

  constructor(
    readonly workspaceRoot: string,
    private readonly loadConfiguration: () => Promise<LspConfiguration>,
    private readonly workspaceSignal: AbortSignal,
    private readonly timers?: LspClock,
  ) {
    workspaceSignal.addEventListener("abort", this.onAbort, { once: true });
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
    const previousView = JSON.stringify([
      this.configuration?.project,
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
        this.configuration?.project,
        this.configuration?.ignorePatterns,
      ]);
    for (const entry of this.entries.values()) {
      if (read !== this.configurationApplied) return;
      if (viewChanged) this.invalidate(entry);
      const selection = this.configuration
        ? await selectLspServer(
            this.workspaceRoot,
            this.configuration,
            entry.id,
          )
        : { state: "unavailable" as const };
      if (read !== this.configurationApplied) return;
      if (selection.state !== "stopped") {
        entry.state = selection.state;
        entry.reason = selection.reason ?? this.configError;
        this.invalidate(entry);
        await this.stopEntry(entry);
        await entry.pending?.catch(() => {});
        continue;
      }
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
          this.invalidate(entry);
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
    if (entry.requiresRestart)
      await abortable(
        () => this.restartEntry(entry, selected),
        this.signal(signal),
      );
    if (entry.state === "error")
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Language server stopped unexpectedly. Use /lsp-restart.",
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
    if (entry.stopping) await entry.stopping;
    entry.state = "starting";
    entry.controller = new AbortController();
    const preparationSignal = AbortSignal.any([
      this.signal(undefined, entry),
      AbortSignal.timeout(LSP_LIMITS.preparationMs),
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
      entry.state = "error";
      entry.reason =
        "Не удалось подготовить backend. Проверьте настройки/установку и перезапустите LSP.";
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
          entry.reason = "Language server завершился. Перезапустите его явно.";
          entry.controller.abort();
          this.invalidate(entry);
        },
        this.timers,
      );
    } catch (error) {
      entry.state = "error";
      entry.reason =
        "Не удалось запустить language server. Проверьте runtime и process-tree support; затем перезапустите.";
      entry.controller.abort();
      throw error;
    }
    entry.transport = transport;
    transport.onNotification("textDocument/publishDiagnostics", (payload) => {
      void this.publish(entry, generation, payload).catch(() => {});
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
      entry.revision = workspaceCoordinator.revision([this.workspaceRoot]);
    } catch (error) {
      entry.state = "error";
      entry.reason =
        launch.kind === "auto"
          ? "Не удалось запустить стандартный анализ кода. Перезапустите LSP; проверьте установку ChiselCode."
          : "Не удалось выполнить initialize. Проверьте совместимость и пути собственного stdio LSP; затем перезапустите.";
      await this.stopEntry(entry);
      if (
        error instanceof RuntimeError &&
        error.code === "CANCELLED" &&
        !this.signal().aborted
      ) {
        const closed = new RuntimeError(
          "LSP_UNAVAILABLE",
          "Language server exited or was revoked during initialization. Check status and restart explicitly.",
        );
        if (error.cause)
          Object.defineProperty(closed, "cause", { value: error.cause });
        throw closed;
      }
      throw error;
    }
  }
  private invalidate(entry: Server): void {
    const receipt = ++entry.publications;
    for (const doc of entry.documents.values()) {
      doc.freshness = "stale";
      doc.diagnostics = [];
      doc.omitted = 0;
      doc.notificationSerial = receipt;
      ++doc.serial;
    }
  }
  private async stopEntry(entry: Server): Promise<void> {
    entry.controller.abort();
    const transport = entry.transport;
    entry.transport = undefined;
    if (transport)
      entry.stopping ??= transport.dispose().finally(() => {
        entry.stopping = undefined;
      });
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
    this.invalidate(entry);
    await this.stopEntry(entry);
    entry.documents.clear();
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
        await this.syncDocument(
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
  private async serialize<T>(
    entry: Server,
    path: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = entry.locks.get(path) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() => {
        cancelled(signal);
        return work();
      });
    entry.locks.set(path, pending);
    void pending
      .finally(() => {
        if (entry.locks.get(path) === pending) entry.locks.delete(path);
      })
      .catch(() => {});
    return abortable(() => pending, signal);
  }
  private async syncDocument(entry: Server, file: LspFile): Promise<Document> {
    const transport = entry.transport;
    if (!transport || entry.state !== "ready")
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Language server is not ready.",
      );
    const previous = entry.documents.get(file.path);
    if (
      previous?.hash === file.hash &&
      previous.generation === entry.generation
    ) {
      previous.accessed = Date.now();
      return previous;
    }
    const doc: Document = {
      ...file,
      version: (previous?.version ?? 0) + 1,
      generation: entry.generation,
      freshness: "pending",
      diagnostics: [],
      omitted: 0,
      serial: (previous?.serial ?? 0) + 1,
      accessed: Date.now(),
    };
    entry.documents.set(file.path, doc);
    try {
      if (!previous || previous.generation !== entry.generation) {
        await transport.notification("textDocument/didOpen", {
          textDocument: {
            uri: file.uri,
            languageId: file.languageId,
            version: doc.version,
            text: file.text,
          },
        });
      } else {
        this.invalidate(entry);
        doc.freshness = "pending";
        const sync = entry.capabilities.textDocumentSync;
        const kind =
          typeof sync === "number"
            ? sync
            : (sync as { change?: number } | undefined)?.change;
        if (kind !== 1 && kind !== 2)
          throw new RuntimeError(
            "LSP_UNSUPPORTED",
            "Server does not support document changes.",
          );
        await transport.notification("textDocument/didChange", {
          textDocument: { uri: file.uri, version: doc.version },
          contentChanges:
            kind === 2
              ? [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: documentEnd(previous.text),
                    },
                    text: file.text,
                  },
                ]
              : [{ text: file.text }],
        });
        const save =
          typeof sync === "object" && sync
            ? (sync as { save?: boolean | { includeText?: boolean } }).save
            : false;
        if (save)
          await transport.notification("textDocument/didSave", {
            textDocument: { uri: file.uri },
            ...(typeof save === "object" && save.includeText
              ? { text: file.text }
              : {}),
          });
      }
      await this.evict(entry, file.path);
    } catch (error) {
      if (entry.documents.get(file.path) === doc)
        entry.documents.delete(file.path);
      await transport
        .notification("textDocument/didClose", {
          textDocument: { uri: file.uri },
        })
        .catch(() => {});
      this.invalidate(entry);
      throw error;
    }
    return doc;
  }
  private async evict(entry: Server, keep: string): Promise<void> {
    const all = () =>
      [...this.entries.values()].flatMap((server) =>
        [...server.documents.values()].map((doc) => ({ server, doc })),
      );
    const bytes = () =>
      all().reduce(
        (sum, { doc }) =>
          sum +
          doc.bytes.length +
          2 * doc.text.length +
          Buffer.byteLength(JSON.stringify(doc.diagnostics)),
        0,
      );
    while (
      all().length > LSP_LIMITS.documents ||
      bytes() > LSP_LIMITS.cacheBytes
    ) {
      const oldest = all()
        .filter(
          ({ server, doc }) =>
            !(server === entry && doc.path === keep) &&
            !server.locks.has(doc.path),
        )
        .sort((a, b) => a.doc.accessed - b.doc.accessed)[0];
      if (!oldest)
        throw new RuntimeError(
          "LSP_UNAVAILABLE",
          "LSP workspace document cache is full.",
        );
      oldest.server.documents.delete(oldest.doc.path);
      await oldest.server.transport?.notification("textDocument/didClose", {
        textDocument: { uri: oldest.doc.uri },
      });
    }
  }

  private async publish(
    entry: Server,
    generation: number,
    payload: unknown,
  ): Promise<void> {
    if (
      this.closed ||
      entry.generation !== generation ||
      entry.state !== "ready" ||
      entry.requiresRestart ||
      !payload ||
      typeof payload !== "object"
    )
      return;
    const notification = {
      ...(payload as {
        uri?: unknown;
        version?: unknown;
        diagnostics?: unknown;
      }),
    };
    if (
      notification.version === 0 &&
      entry.launch?.kind === "auto" &&
      catalogServer(entry.id)?.zeroVersionUnconfirmed
    )
      notification.version = undefined;
    const receipt = ++entry.publications;
    const policy = new WorkspacePolicy(
      this.workspaceRoot,
      this.configuration?.ignorePatterns ?? [],
    );
    const canonicalPath = await resolveLspUri(policy, notification.uri);
    const doc = canonicalPath ? entry.documents.get(canonicalPath) : undefined;
    if (
      this.closed ||
      entry.generation !== generation ||
      entry.state !== "ready" ||
      entry.controller.signal.aborted ||
      entry.requiresRestart ||
      !doc ||
      receipt <= (doc.notificationSerial ?? 0) ||
      doc.generation !== generation ||
      !Array.isArray(notification.diagnostics)
    )
      return;
    if (
      notification.version !== undefined &&
      notification.version !== doc.version
    )
      return;
    doc.notificationSerial = receipt;
    const version = doc.version;
    const serial = ++doc.serial;
    const diagnostics: LspDiagnostic[] = [];
    let omitted = Math.max(
      0,
      notification.diagnostics.length - LSP_LIMITS.diagnostics,
    );
    for (const raw of notification.diagnostics.slice(
      0,
      LSP_LIMITS.diagnostics,
    )) {
      if (!raw || typeof raw !== "object") {
        ++omitted;
        continue;
      }
      const item = raw as Record<string, unknown>;
      const range = safeRange(item.range);
      if (!range || typeof item.message !== "string") {
        ++omitted;
        continue;
      }
      try {
        validatePosition(doc.text, range.start);
        validatePosition(doc.text, range.end);
      } catch {
        ++omitted;
        continue;
      }
      const relatedInformation: NonNullable<
        LspDiagnostic["relatedInformation"]
      > = [];
      if (Array.isArray(item.relatedInformation))
        for (const related of item.relatedInformation.slice(0, 8)) {
          const location = await permittedLocation(policy, related?.location);
          if (location)
            relatedInformation.push({
              ...location,
              message: safeText(related.message, 512),
            });
          else ++omitted;
        }
      diagnostics.push({
        path: doc.relativePath,
        range,
        severity: [1, 2, 3, 4].includes(Number(item.severity))
          ? Number(item.severity)
          : 3,
        message: safeText(item.message),
        ...(typeof item.code === "string" || typeof item.code === "number"
          ? {
              code:
                typeof item.code === "string"
                  ? safeText(item.code, 128)
                  : item.code,
            }
          : {}),
        ...(typeof item.source === "string"
          ? { source: safeText(item.source, 128) }
          : {}),
        ...(relatedInformation.length ? { relatedInformation } : {}),
      });
    }
    if (
      entry.generation !== generation ||
      entry.state !== "ready" ||
      entry.controller.signal.aborted ||
      entry.documents.get(doc.path) !== doc ||
      doc.version !== version ||
      doc.serial !== serial ||
      entry.requiresRestart ||
      this.closed
    )
      return;
    doc.diagnostics = diagnostics;
    doc.omitted = omitted;
    doc.freshness = notification.version === undefined ? "observed" : "current";
    ++doc.serial;
    try {
      await this.evict(entry, doc.path);
    } catch {
      doc.diagnostics = [];
      doc.freshness = "unavailable";
      doc.omitted = notification.diagnostics.length;
    }
  }
  private async refreshDocuments(
    entry: Server,
    port: LspReadPort,
    synchronize = true,
  ): Promise<void> {
    const revision = workspaceCoordinator.revision([this.workspaceRoot]);
    if (revision !== entry.revision) {
      this.invalidate(entry);
      entry.revision = revision;
    }
    for (const doc of [...entry.documents.values()]) {
      cancelled(port.signal);
      try {
        const file = await readLspFile(
          { ...port, observe: undefined, languageId: doc.languageId },
          doc.relativePath,
        );
        if (file.hash !== doc.hash && !synchronize) {
          this.invalidate(entry);
          continue;
        }
        if (file.hash !== doc.hash)
          await this.serialize(
            entry,
            file.path,
            this.signal(port.signal, entry),
            () => this.syncDocument(entry, file),
          );
      } catch (error) {
        cancelled(port.signal);
        this.invalidate(entry);
        entry.documents.delete(doc.path);
        await entry.transport?.notification("textDocument/didClose", {
          textDocument: { uri: doc.uri },
        });
        void error;
      }
    }
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
    await this.refreshDocuments(entry, readPort);
    const file = await readLspFile(readPort, path);
    return this.serialize(entry, file.path, signal, async () => {
      const doc = await this.syncDocument(entry, file);
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
        this.invalidate(entry);
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
        this.invalidate(entry);
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
          this.invalidate(entry);
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
        this.invalidate(entry);
        throw new RuntimeError(
          "STALE_FILE_REVISION",
          "Document changed while the language server was analysing it. Retry with current bytes.",
        );
      }
      return result;
    }).catch((error) => {
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
    return this.query(path, port, async (entry, doc, signal) => {
      if (doc.freshness === "pending" || doc.freshness === "stale") {
        await this.waitForDiagnostics(doc, signal);
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
            ? "Server confirmed this document version."
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
  private waitForDiagnostics(
    doc: Document,
    signal: AbortSignal,
  ): Promise<void> {
    const timers = this.timers ?? { setTimeout, clearTimeout };
    return new Promise((resolve, reject) => {
      const done = (error?: unknown) => {
        timers.clearTimeout(timer);
        clearInterval(poll);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () =>
        done(new RuntimeError("CANCELLED", "LSP diagnostics wait cancelled."));
      const timer = timers.setTimeout(() => done(), LSP_LIMITS.diagnosticsMs);
      const poll = setInterval(() => {
        if (doc.freshness === "current" || doc.freshness === "observed") done();
      }, 20);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
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
              await this.refreshDocuments(
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
    this.lifetime.abort();
    this.workspaceSignal.removeEventListener("abort", this.onAbort);
    this.cleanup = (async () => {
      const errors: unknown[] = [];
      for (const entry of this.entries.values()) {
        entry.state = "disposed";
        this.invalidate(entry);
        try {
          await this.stopEntry(entry);
          await entry.pending?.catch(() => {});
        } catch (error) {
          errors.push(error);
        }
        entry.documents.clear();
        entry.locks.clear();
      }
      this.entries.clear();
      if (errors.length)
        throw new AggregateError(errors, "LSP cleanup failed.");
    })();
    return this.cleanup;
  }
}
