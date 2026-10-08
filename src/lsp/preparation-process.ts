import { spawn } from "node:child_process";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { ownWindowsProcessTree } from "./windows-job.js";

/** Fixed installer argv only. Cancellation awaits process-tree termination, never a detached build. */
export async function runPreparation(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  cancelled(signal);
  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tree: { dispose(): void } | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (stopped) return;
    stopped = true;
    tree?.dispose();
    if (process.platform === "win32") child.kill();
    else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
    force = setTimeout(() => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    }, 2000);
  };
  let size = 0;
  const consume = (chunk: Buffer) => {
    size += chunk.length;
    if (size > 65536) terminate();
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", () =>
      reject(
        new RuntimeError(
          "LSP_UNAVAILABLE",
          "Unable to run the fixed language-server preparation.",
        ),
      ),
    );
    child.once("close", resolve);
  });
  try {
    if (process.platform === "win32" && child.pid)
      tree = ownWindowsProcessTree(child.pid);
    signal?.addEventListener("abort", terminate, { once: true });
    timer = setTimeout(terminate, 240000);
    if (signal?.aborted) terminate();
    const code = await done;
    cancelled(signal);
    if (stopped || code !== 0)
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Language-server preparation failed. Check SDK prerequisites and network availability; retry explicitly.",
      );
  } catch (error) {
    terminate();
    await done.catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", terminate);
    if (timer) clearTimeout(timer);
    if (force) clearTimeout(force);
    tree?.dispose();
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
}
