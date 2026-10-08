import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import {
  AbstractMessageReader,
  CancellationReceiverStrategy,
  CancellationTokenSource,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  ErrorCodes,
  type Message,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { SecretRedactor } from "../security/redaction.js";
import type { LspLaunch } from "./config.js";
import { LSP_LIMITS } from "./limits.js";
import { ownWindowsProcessTree } from "./windows-job.js";

export interface LspClock {
  setTimeout(
    callback: () => void,
    milliseconds: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
const clock: LspClock = { setTimeout, clearTimeout };

/** Limits framing before the official byte-framing/JSON decoder allocates a body. */
export class LspFrameGuard extends Transform {
  private header = Buffer.alloc(0);
  private remaining = 0;
  constructor(private readonly maximum: number = LSP_LIMITS.frameBytes) {
    super();
  }
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining) {
          const length = Math.min(this.remaining, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + length));
          this.remaining -= length;
          offset += length;
          continue;
        }
        // Only headers are buffered here; fragmented bodies stay in the official reader.
        this.header = Buffer.concat([
          this.header,
          chunk.subarray(offset, ++offset),
        ]);
        if (this.header.length > 8192) throw new Error("Oversized LSP header.");
        if (
          this.header.length < 4 ||
          !this.header.subarray(-4).equals(Buffer.from("\r\n\r\n"))
        )
          continue;
        const lengths = this.header
          .toString("ascii")
          .split("\r\n")
          .filter((line) => /^content-length:/i.test(line));
        if (
          lengths.length !== 1 ||
          !/^content-length:\s*[1-9][0-9]*\s*$/i.test(lengths[0] ?? "")
        )
          throw new Error("Invalid LSP Content-Length.");
        const length = Number(lengths[0]?.split(":")[1]);
        if (!Number.isSafeInteger(length) || length > this.maximum)
          throw new Error("Oversized LSP frame.");
        this.remaining = length;
        this.push(this.header);
        this.header = Buffer.alloc(0);
      }
      callback();
    } catch {
      callback(
        new RuntimeError(
          "LSP_PROTOCOL_ERROR",
          "Invalid or oversized language server frame.",
        ),
      );
    }
  }
  _flush(callback: TransformCallback): void {
    callback(
      this.header.length || this.remaining
        ? new RuntimeError(
            "LSP_PROTOCOL_ERROR",
            "Incomplete language server frame.",
          )
        : undefined,
    );
  }
}

class BoundedReader extends AbstractMessageReader {
  private callback?: DataCallback;
  private burst = 0;
  private reset?: ReturnType<typeof setImmediate>;
  private subscriptions: Disposable[] = [];
  constructor(private readonly reader: StreamMessageReader) {
    super();
    this.subscriptions.push(
      reader.onError((error) => this.fireError(error)),
      reader.onClose(() => this.fireClose()),
    );
  }
  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    return this.reader.listen((message) => {
      if (++this.burst > 256) {
        this.fireError(new Error("Language server message queue limit."));
        return;
      }
      if (!this.reset)
        this.reset = setImmediate(() => {
          this.burst = 0;
          this.reset = undefined;
        });
      callback(message);
    });
  }
  settleCancelled(id: number | string): void {
    // Settle the library's pending response too, so a non-cooperating server cannot
    // retain unbounded cancelled promises. A late real response has no waiter.
    this.callback?.({
      jsonrpc: "2.0",
      id,
      error: { code: -32800, message: "Request cancelled." },
    } as Message);
  }
  dispose(): void {
    if (this.reset) clearImmediate(this.reset);
    this.callback = undefined;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    this.reader.dispose();
    super.dispose();
  }
}

export class LspTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly frames = new LspFrameGuard();
  private readonly reader: BoundedReader;
  private readonly writer: StreamMessageWriter;
  private readonly connection: MessageConnection;
  private readonly lifetime = new AbortController();
  private readonly redactor = new SecretRedactor();
  private stderr = "";
  private failureCause?: Error;
  private pending = 0;
  private closed = false;
  private stopping = false;
  private cleanup?: Promise<void>;
  private readonly exit: Promise<void>;
  private readonly processTree?: { dispose(): void };

  constructor(
    root: string,
    launch: LspLaunch,
    private readonly onFailure: () => void,
    private readonly timers: LspClock = clock,
  ) {
    const env: NodeJS.ProcessEnv = {
      PATH: dirname(launch.command),
      NODE_ENV: "production",
    };
    // The compiled CLI doubles as its bundled Bun runtime for the vetted backend
    // and tsserver's child_process.fork. Custom Node launches never inherit this.
    if (launch.kind === "auto" && launch.command === process.execPath)
      env.BUN_BE_BUN = "1";
    if (launch.environment) Object.assign(env, launch.environment);
    for (const key of [
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "TMP",
      "TEMP",
      "TMPDIR",
      "LANG",
      "LC_ALL",
    ])
      if (process.env[key]) env[key] = process.env[key];
    this.process = spawn(launch.command, launch.args, {
      cwd: root,
      env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: "pipe",
    });
    if (process.platform === "win32" && this.process.pid) {
      try {
        this.processTree = ownWindowsProcessTree(this.process.pid);
      } catch (error) {
        this.process.on("error", () => {});
        this.process.kill();
        this.process.stdin.destroy();
        this.process.stdout.destroy();
        this.process.stderr.destroy();
        throw error;
      }
    }
    this.reader = new BoundedReader(new StreamMessageReader(this.frames));
    this.writer = new StreamMessageWriter(this.process.stdin);
    this.connection = createMessageConnection(
      this.reader,
      this.writer,
      {
        error: () => {},
        warn: () => {},
        info: () => {},
        log: () => {},
      },
      {
        maxParallelism: LSP_LIMITS.pendingRequests,
        cancellationStrategy: {
          receiver: CancellationReceiverStrategy.Message,
          sender: {
            sendCancellation: async (connection, id) => {
              this.reader.settleCancelled(id);
              await connection.sendNotification("$/cancelRequest", { id });
            },
            cleanup: () => {},
          },
        },
      },
    );
    this.process.stdout.pipe(this.frames);
    this.process.stdout.once("end", () => this.fail());
    this.frames.on("error", () => this.fail());
    this.process.on("error", () => this.fail());
    this.process.stderr.on("data", (bytes: Buffer) => {
      this.stderr = this.redactor.text(
        this.stderr + bytes.subarray(-LSP_LIMITS.stderrBytes).toString("utf8"),
      );
      while (Buffer.byteLength(this.stderr) > LSP_LIMITS.stderrBytes)
        this.stderr = this.stderr.slice(Math.floor(this.stderr.length / 4));
    });
    this.exit = new Promise((resolve) => {
      this.process.once("close", () => {
        this.fail();
        resolve();
      });
      this.process.once("error", () => resolve());
    });
    this.connection.onClose(() => this.fail());
    this.connection.onError(() => this.fail());
    this.connection.onRequest((method, params: unknown) => {
      if (method === "workspace/applyEdit")
        return {
          applied: false,
          failureReason: "ChiselCode LSP is read-only.",
        };
      if (method === "workspace/configuration") {
        const items = (params as { items?: unknown[] } | undefined)?.items;
        return Array.isArray(items)
          ? items.slice(0, 32).map((item) => {
              const section =
                item && typeof item === "object"
                  ? (item as { section?: unknown }).section
                  : undefined;
              if (section === undefined || section === "")
                return launch.settings ?? {};
              if (typeof section !== "string" || section.length > 128)
                return {};
              let value: unknown = launch.settings ?? {};
              for (const key of section.split(".")) {
                if (
                  !value ||
                  typeof value !== "object" ||
                  !Object.hasOwn(value, key)
                )
                  return {};
                value = (value as Record<string, unknown>)[key];
              }
              return value ?? {};
            })
          : [];
      }
      return new ResponseError(
        ErrorCodes.MethodNotFound,
        "Unsupported language server request.",
      );
    });
    this.connection.listen();
  }
  private fail(): void {
    if (this.closed) return;
    // Internal, redacted diagnostics survive cleanup. Causes are non-enumerable
    // and never included in tool results, status, checkpoints or model context.
    if (this.stderr) this.failureCause = new Error(this.stderr);
    this.closed = true;
    this.lifetime.abort();
    this.processTree?.dispose();
    this.connection.dispose();
    if (!this.stopping) this.onFailure();
    // A crashed/protocol-invalid server must not leave its tsserver descendants.
    if (!this.stopping) void this.dispose().catch(() => {});
  }
  notification(method: string, params: unknown): Promise<void> {
    if (this.closed)
      return Promise.reject(
        new RuntimeError(
          "LSP_UNAVAILABLE",
          "Language server is not connected.",
        ),
      );
    return this.connection.sendNotification(method, params);
  }
  onNotification(
    method: string,
    callback: (params: unknown) => void,
  ): Disposable {
    return this.connection.onNotification(method, callback);
  }
  async request<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeout: number = LSP_LIMITS.requestMs,
  ): Promise<T> {
    cancelled(signal);
    if (this.closed)
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Language server is not connected.",
      );
    if (this.pending >= LSP_LIMITS.pendingRequests)
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Language server request limit reached.",
      );
    ++this.pending;
    const source = new CancellationTokenSource();
    let timedOut = false;
    const timeoutController = new AbortController();
    const timer = this.timers.setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeout);
    const combined = AbortSignal.any([
      this.lifetime.signal,
      timeoutController.signal,
      ...(signal ? [signal] : []),
    ]);
    const abort = () => source.cancel();
    combined.addEventListener("abort", abort, { once: true });
    try {
      const pending = this.connection.sendRequest<T>(
        method,
        params,
        source.token,
      );
      if (combined.aborted) source.cancel();
      return await pending;
    } catch {
      const error = signal?.aborted
        ? new RuntimeError("CANCELLED", "Operation cancelled.")
        : timedOut
          ? new RuntimeError(
              "TOOL_TIMEOUT",
              "Language server request timed out.",
            )
          : this.lifetime.signal.aborted
            ? new RuntimeError(
                "LSP_UNAVAILABLE",
                "Language server generation closed.",
              )
            : new RuntimeError(
                "LSP_PROTOCOL_ERROR",
                "Language server request failed.",
              );
      if (this.failureCause)
        Object.defineProperty(error, "cause", { value: this.failureCause });
      throw error;
    } finally {
      this.timers.clearTimeout(timer);
      combined.removeEventListener("abort", abort);
      source.dispose();
      --this.pending;
    }
  }
  dispose(): Promise<void> {
    this.cleanup ??= this.stop();
    return this.cleanup;
  }
  private async stop(): Promise<void> {
    this.stopping = true;
    if (!this.closed) {
      try {
        await this.request("shutdown", null, undefined, LSP_LIMITS.shutdownMs);
        await this.notification("exit", undefined);
      } catch {
        /* Force cleanup still runs on EOF or timeout. */
      }
    }
    this.closed = true;
    this.lifetime.abort();
    this.connection.dispose();
    const pid = this.process.pid;
    this.processTree?.dispose();
    if (pid) {
      if (process.platform === "win32") {
        const systemRoot =
          process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
        await new Promise<void>((resolve) => {
          const killer = spawn(
            `${systemRoot}\\System32\\taskkill.exe`,
            ["/PID", String(pid), "/T", "/F"],
            { windowsHide: true, shell: false, stdio: "ignore" },
          );
          killer.once("error", () => resolve());
          killer.once("close", () => resolve());
        });
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          /* Already exited. */
        }
        // Keep the group ID until escalation, even if its parent exits first.
        await new Promise<void>((resolve) => {
          const timer = this.timers.setTimeout(resolve, LSP_LIMITS.shutdownMs);
          this.exit.then(() => {
            this.timers.clearTimeout(timer);
            resolve();
          });
        });
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Group already gone. */
        }
      }
    }
    this.process.stdin.destroy();
    this.process.stdout.unpipe(this.frames);
    this.process.stdout.destroy();
    this.process.stderr.destroy();
    this.frames.destroy();
    this.reader.dispose();
    this.writer.dispose();
    this.stderr = "";
    await this.exit;
  }
}
