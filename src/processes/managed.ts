import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { execa } from "execa";
import { RuntimeError } from "../runtime/errors.js";
import { waitForOwnedGroupExit } from "./group-cleanup.js";
import { hostShell } from "./shell.js";
import { processSupervisor } from "./supervisor.js";
import { WINDOWS_SHELL_TRANSPORT } from "./windows-shell.js";

export type ProcessStream = "stdout" | "stderr";
export interface ManagedOutcome {
  exitCode: number | null;
  signal: string | null;
  cleanup: boolean;
  escaped: boolean;
  reason?: "cancelled" | "timed_out" | "output_limit" | "capture_failed";
}
export interface ProcessCapture {
  write(stream: ProcessStream, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** A live private instance, never reconstructed from a DTO/PID or exported to extensions. */
export class ManagedProcess {
  readonly shell = hostShell();
  readonly instance = randomUUID();
  readonly acceptedAt = Date.now();
  readonly deadline: number;
  readonly done: Promise<ManagedOutcome>;
  readonly ready: Promise<void>;
  pid?: number;
  cleanupPhase = "process";
  cleanupDetail = "";
  private readonly child;
  private outcome?: ManagedOutcome;
  private reason?: ManagedOutcome["reason"];
  private closed = false;
  private escaped = false;
  private leaderExited = false;
  private leaderCode: number | null = null;
  private leaderSignal: string | null = null;
  private windowsTreeStopped = false;
  private groupKilled = false;
  private cleanupDeadline?: number;
  private stopPromise?: Promise<ManagedOutcome>;
  private foregroundSignal?: AbortSignal;
  private readonly aborted = () => {
    void this.stop("cancelled");
  };
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  constructor(input: {
    command: string;
    cwd: string;
    deadline: number;
    signal?: AbortSignal;
    capture: ProcessCapture;
  }) {
    this.deadline = input.deadline;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // The same embedded Bun runtime is already used by bundled LSP. The helper
    // executes no CLI/application/model entrypoint, including in compiled builds.
    const child = execa(
      process.execPath,
      [
        "-e",
        `(${processSupervisor.toString()})(${JSON.stringify(this.shell)},${JSON.stringify(process.platform === "win32" ? WINDOWS_SHELL_TRANSPORT : "")})`,
      ],
      {
        cwd: input.cwd,
        env: { BUN_BE_BUN: "1" },
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        buffer: false,
        reject: false,
        // Windows must not destroy the supervisor with the application's
        // process job before it can stop the .NET-spawned command tree.
        // The live native owner handle still bounds its lifetime after crash.
        detached: true,
        windowsHide: true,
      },
    );
    this.child = child;
    this.foregroundSignal = input.signal;
    input.signal?.addEventListener("abort", this.aborted, { once: true });
    const deadlineTimer = setTimeout(
      () => {
        void this.stop("timed_out");
      },
      Math.max(1, input.deadline - Date.now()),
    );
    this.child.stdin!.write(
      `${JSON.stringify({ type: "start", command: input.command, cwd: input.cwd, ownerPid: process.pid })}\n`,
    );
    const capture = async (stream: ProcessStream, readable: Readable) => {
      try {
        for await (const bytes of readable)
          await input.capture.write(stream, bytes);
      } catch {
        void this.stop("capture_failed");
      }
    };
    const control = async () => {
      let pending = "";
      const readable = this.child.stdio[3] as Readable;
      for await (const bytes of readable) {
        pending += Buffer.from(bytes).toString("utf8");
        if (pending.length > 16384)
          throw new Error("Внутренний канал процесса переполнен.");
        let end = pending.indexOf("\n");
        while (end !== -1) {
          const message = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          end = pending.indexOf("\n");
          if (message.type === "ready") {
            this.pid = message.pid;
            this.readyResolve();
          } else if (message.type === "exit") {
            this.leaderExited = true;
            this.leaderCode = message.exitCode ?? null;
            this.leaderSignal = message.signal ?? null;
          } else if (message.type === "cleanup_phase") {
            this.cleanupPhase = String(message.phase);
            if (message.detail)
              this.cleanupDetail = String(message.detail).slice(0, 1000);
          } else if (message.type === "ownership_unknown") this.escaped = true;
          else if (message.type === "done")
            this.outcome = {
              exitCode: message.exitCode ?? null,
              signal: message.signal ?? null,
              cleanup: message.cleanup === true,
              escaped: message.escaped === true,
            };
          else if (message.type === "error")
            this.readyReject(new Error(message.message));
        }
      }
    };
    const output = Promise.allSettled([
      capture("stdout", this.child.stdout!),
      capture("stderr", this.child.stderr!),
      control(),
    ]);
    this.done = (async () => {
      try {
        await child;
      } catch {
        /* Cleanup remains unconfirmed. */
      }
      await output;
      this.closed = true;
      clearTimeout(deadlineTimer);
      this.foregroundSignal?.removeEventListener("abort", this.aborted);
      this.readyReject(
        new Error("Процесс завершился до подтверждения запуска."),
      );
      try {
        await input.capture.close();
      } catch {
        this.reason ??= "capture_failed";
      }
      let cleanup = this.outcome?.cleanup ?? false;
      if (!cleanup && this.reason && !this.escaped && !this.outcome?.escaped) {
        if (process.platform === "win32") cleanup = this.windowsTreeStopped;
        else if (this.groupKilled)
          try {
            this.cleanupPhase = "tree";
            cleanup = await waitForOwnedGroupExit(
              child.pid!,
              this.cleanupDeadline ?? Date.now() + 2000,
            );
          } catch {
            /* Missing proof retains the lifetime fence. */
          }
      }
      return {
        ...(this.outcome ?? {
          exitCode: this.leaderCode,
          signal: this.leaderSignal,
          cleanup,
          escaped: this.escaped,
        }),
        cleanup,
        ...(this.reason ? { reason: this.reason } : {}),
      };
    })();
    // Callers always await ready; keep a rejection during stop/start races observed.
    void this.ready.catch(() => {});
    if (input.signal?.aborted) this.aborted();
  }
  /** Atomic signal ownership transfer; absolute deadline and capture stay intact. */
  detachForeground(): void {
    if (this.closed || this.reason)
      throw new RuntimeError(
        "CANCELLED",
        "Процесс уже завершается; перевод в фон недоступен.",
      );
    this.foregroundSignal?.removeEventListener("abort", this.aborted);
    this.foregroundSignal = undefined;
  }
  stop(
    reason: NonNullable<ManagedOutcome["reason"]> = "cancelled",
  ): Promise<ManagedOutcome> {
    this.reason ??= reason;
    this.stopPromise ??= this.terminate();
    return this.stopPromise;
  }
  private async terminate(): Promise<ManagedOutcome> {
    if (this.closed) return this.done;
    this.cleanupDeadline = Date.now() + 10000;
    this.child.stdin?.write(`${JSON.stringify({ type: "stop" })}\n`);
    let graceful: ReturnType<typeof setTimeout>;
    let deadline: ReturnType<typeof setTimeout>;
    const kill = async () => {
      if (
        !this.child.pid ||
        this.closed ||
        this.child.nodeChildProcess.exitCode != null ||
        this.child.nodeChildProcess.signalCode != null
      )
        return;
      if (process.platform === "win32") {
        const leaderAlive = !this.leaderExited;
        const result = await execa(
          "taskkill",
          ["/pid", String(this.child.pid), "/T", "/F"],
          { reject: false, timeout: 2000, windowsHide: true },
        ).catch(() => undefined);
        this.windowsTreeStopped = leaderAlive && result?.exitCode === 0;
      } else
        try {
          process.kill(-this.child.pid, "SIGKILL");
          this.groupKilled = true;
        } catch {
          /* Already gone. */
        }
    };
    const fallback = new Promise<ManagedOutcome>((resolve) => {
      // Windows helper starts awaited /T /F cleanup immediately. Preserve it
      // while CIM confirms orphan descendants; force the helper only at its bound.
      graceful = setTimeout(
        () => {
          void kill();
        },
        process.platform === "win32" ? 9000 : 2000,
      );
      deadline = setTimeout(() => {
        void kill();
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
        (this.child.stdio[3] as Readable)?.destroy();
        resolve({
          exitCode: this.outcome?.exitCode ?? null,
          signal: this.outcome?.signal ?? null,
          cleanup: false,
          escaped: this.outcome?.escaped ?? false,
          reason: this.reason,
        });
      }, 10000);
    });
    try {
      return await Promise.race([this.done, fallback]);
    } finally {
      clearTimeout(graceful!);
      clearTimeout(deadline!);
    }
  }
}
