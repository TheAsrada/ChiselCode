import { abortable } from "../extensions/lifecycle.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { WorkspacePolicy } from "../security/workspace-policy.js";
import { workspaceCoordinator } from "../tools/workspace-coordinator.js";
import { catalogServer } from "./catalog.js";
import { type LspConfiguration } from "./config.js";
import type { LspDiagnostic } from "./contracts.js";
import {
  documentEnd,
  type LspFile,
  type LspReadPort,
  permittedLocation,
  readLspFile,
  resolveLspUri,
  safeRange,
  validatePosition,
} from "./documents.js";
import { LSP_LIMITS } from "./limits.js";
import { safeText } from "./safe-text.js";
import type { Document, Server } from "./server-state.js";
import { type LspClock } from "./transport.js";

interface CacheHost {
  closed(): boolean;
  signal(caller: AbortSignal | undefined, server: Server): AbortSignal;
  configuration(): LspConfiguration | undefined;
  changed(): void;
}
/** Documents and their locks live with server generations; the service owns transports. */
export class LspDocumentCache {
  constructor(
    private readonly workspaceRoot: string,
    private readonly entries: ReadonlyMap<string, Server>,
    private readonly host: CacheHost,
    private readonly timers?: LspClock,
  ) {}
  async serialize<T>(
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
  async syncDocument(entry: Server, file: LspFile): Promise<Document> {
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
    this.host.changed();
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
      this.host.changed();
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
  async evict(entry: Server, keep: string): Promise<void> {
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
      this.host.changed();
      await oldest.server.transport?.notification("textDocument/didClose", {
        textDocument: { uri: oldest.doc.uri },
      });
    }
  }

  async publish(
    entry: Server,
    generation: number,
    payload: unknown,
  ): Promise<void> {
    if (
      this.host.closed() ||
      entry.generation !== generation ||
      entry.state !== "ready" ||
      entry.requiresRestart ||
      // A pull-capable server may push syntax-only/provisional subsets too.
      // Keep request-bound full reports as the sole cache source for it.
      entry.capabilities.diagnosticProvider ||
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
      this.host.configuration()?.ignorePatterns ?? [],
    );
    const canonicalPath = await resolveLspUri(policy, notification.uri);
    const doc = canonicalPath ? entry.documents.get(canonicalPath) : undefined;
    if (
      this.host.closed() ||
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
    await this.recordDiagnostics(
      entry,
      generation,
      doc,
      notification.diagnostics,
      policy,
      notification.version === undefined
        ? "unversioned_push"
        : "versioned_push",
    );
  }
  async recordDiagnostics(
    entry: Server,
    generation: number,
    doc: Document,
    items: unknown[],
    policy: WorkspacePolicy,
    evidence: NonNullable<Document["diagnosticEvidence"]>,
  ): Promise<void> {
    const version = doc.version;
    const serial = ++doc.serial;
    const diagnostics: LspDiagnostic[] = [];
    let omitted = Math.max(0, items.length - LSP_LIMITS.diagnostics);
    for (const raw of items.slice(0, LSP_LIMITS.diagnostics)) {
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
      this.host.closed()
    )
      return;
    doc.diagnostics = diagnostics;
    doc.omitted = omitted;
    doc.freshness = evidence === "unversioned_push" ? "observed" : "current";
    doc.diagnosticEvidence = evidence;
    this.host.changed();
    ++doc.serial;
    try {
      await this.evict(entry, doc.path);
    } catch {
      doc.diagnostics = [];
      doc.freshness = "unavailable";
      doc.omitted = items.length;
    }
  }
  async refreshDocuments(
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
            this.host.signal(port.signal, entry),
            () => this.syncDocument(entry, file),
          );
      } catch (error) {
        cancelled(port.signal);
        this.invalidate(entry);
        entry.documents.delete(doc.path);
        this.host.changed();
        await entry.transport?.notification("textDocument/didClose", {
          textDocument: { uri: doc.uri },
        });
        void error;
      }
    }
  }
  waitForDiagnostics(doc: Document, signal: AbortSignal): Promise<void> {
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
  invalidate(entry: Server): void {
    const receipt = ++entry.publications;
    for (const doc of entry.documents.values()) {
      doc.freshness = "stale";
      doc.diagnostics = [];
      doc.omitted = 0;
      doc.notificationSerial = receipt;
      ++doc.serial;
    }
    this.host.changed();
  }
}
