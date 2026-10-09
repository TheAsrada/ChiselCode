import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { cancelled, RuntimeError } from "../runtime/errors.js";

export const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;
/** Direct argv only. Routing variables, hooks, filters' global attributes and
 * optional background Git processes cannot change the captured repository. */
export async function gitCommand(
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
  allowFailure = false,
): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await gitBytes(root, args, signal, allowFailure),
    );
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(
      "WORKTREE_UNSUPPORTED",
      "Git metadata contains a non-UTF-8 path.",
    );
  }
}
export async function gitBytes(
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
  allowFailure = false,
  input?: Buffer,
): Promise<Buffer> {
  cancelled(signal);
  if (["status", "diff", "commit"].some((command) => args.includes(command)))
    await rejectExternalFilters(root, signal);
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
  ])
    if (process.env[key]) env[key] = process.env[key] as string;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  let result: { exitCode?: number; stdout: Uint8Array };
  const cwd = await realpath(root);
  const child = execa(
    "git",
    [
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "submodule.recurse=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd,
      env,
      extendEnv: false,
      reject: false,
      detached: process.platform !== "win32",
      maxBuffer: GIT_OUTPUT_LIMIT,
      encoding: "buffer",
      input,
      stripFinalNewline: false,
    },
  );
  let timedOut = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  let killing: Promise<unknown> | undefined;
  const killTree = (hard: boolean) => {
    if (!child.pid) return;
    if (process.platform === "win32")
      killing = execa(
        join(
          process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/pid", String(child.pid), "/T", "/F"],
        { reject: false, timeout: 2000, maxBuffer: 65536 },
      ).catch(() => child.kill());
    else {
      try {
        process.kill(-child.pid, hard ? "SIGKILL" : "SIGTERM");
      } catch {
        /* Process group already exited. */
      }
    }
  };
  const terminate = () => {
    killTree(false);
    force ??= setTimeout(() => killTree(true), 1000);
  };
  signal?.addEventListener("abort", terminate, { once: true });
  if (signal?.aborted) terminate();
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, 30000);
  try {
    result = await child;
  } catch (error) {
    killTree(true);
    cancelled(signal);
    throw new RuntimeError(
      "WORKTREE_UNAVAILABLE",
      "Git could not complete the operation. Check the installed Git executable and repository.",
      { cause: error instanceof Error ? error.name : "Git error" },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", terminate);
    if (force) {
      killTree(true);
      clearTimeout(force);
    }
    await killing;
  }
  cancelled(signal);
  if (timedOut)
    throw new RuntimeError(
      "TOOL_TIMEOUT",
      "Git operation timed out; its process tree was stopped.",
    );
  if (result.exitCode !== 0 && !allowFailure)
    throw new RuntimeError(
      "WORKTREE_GIT_ERROR",
      "Git rejected the operation. Inspect repository state before retrying.",
      { exitCode: result.exitCode },
    );
  return result.exitCode === 0 ? Buffer.from(result.stdout) : Buffer.alloc(0);
}
/** Attribute probing never runs filter programs. Installed but unused drivers
 * (for example Git LFS from a system install) do not disable ordinary repos. */
export async function rejectExternalFilters(
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  const paths = await gitBytes(root, ["ls-files", "-z"], signal);
  if (!paths.length) return;
  const attributes = (
    await gitBytes(
      root,
      ["check-attr", "-z", "filter", "--stdin"],
      signal,
      false,
      paths,
    )
  )
    .toString("utf8")
    .split("\0");
  for (let i = 2; i < attributes.length; i += 3)
    if (
      attributes[i] &&
      !["unspecified", "unset"].includes(attributes[i] as string)
    )
      throw new RuntimeError(
        "WORKTREE_UNSUPPORTED",
        "External Git filter attributes are unsupported; no filter command was run.",
      );
}

export function gitLine(text: string): string {
  return text.replace(/\r?\n$/, "");
}
export interface GitIdentity {
  root: string;
  gitDir: string;
  commonDir: string;
}
export async function gitIdentity(
  root: string,
  signal?: AbortSignal,
): Promise<GitIdentity> {
  const field = async (flag: string) =>
    realpath(
      gitLine(
        await gitCommand(
          root,
          ["rev-parse", "--path-format=absolute", flag],
          signal,
        ),
      ),
    );
  // A failed probe must still await its siblings: their cwd handles otherwise
  // outlive the caller and block workspace cleanup on Windows.
  const fields = await Promise.allSettled([
    field("--show-toplevel"),
    field("--git-dir"),
    field("--git-common-dir"),
  ]);
  const [workingRoot, gitDir, commonDir] = fields.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  }) as [string, string, string];
  return Object.freeze({ root: workingRoot, gitDir, commonDir });
}
export const commonGitResource = (identity: GitIdentity): string =>
  `git:common:${identity.commonDir}`;
export const localGitResource = (identity: GitIdentity): string =>
  `git:local:${identity.gitDir}`;
export async function commitOid(
  root: string,
  ref = "HEAD",
  signal?: AbortSignal,
): Promise<string> {
  if (!ref || ref.length > 256 || ref.startsWith("-") || /[\0\r\n\s]/.test(ref))
    throw new RuntimeError(
      "INVALID_TOOL_INPUT",
      "Use one local commit or ref, without options or whitespace.",
    );
  const oid = gitLine(
    await gitCommand(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      signal,
      true,
    ),
  );
  if (!/^[a-f0-9]{40,64}$/.test(oid))
    throw new RuntimeError(
      "WORKTREE_UNSUPPORTED",
      "A committed HEAD is required.",
    );
  return oid;
}
