import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type GitIdentity,
  gitCommand,
  rejectExternalFilters,
} from "../git/driver.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { WorkspacePolicy } from "../security/workspace-policy.js";
import { WORKTREE_LIMITS } from "./contracts.js";

interface GitStatus {
  path: string;
  status: string;
}

export const hash = (value: string | Buffer | null): string | null =>
  value === null ? null : createHash("sha256").update(value).digest("hex");
export const samePath = (a: string, b: string) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : a === b;
export const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
export const fail = (
  code: ConstructorParameters<typeof RuntimeError>[0],
  message: string,
): never => {
  throw new RuntimeError(code, message);
};
export function safePath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("\0") ||
    path
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          part === "." ||
          part.toLowerCase() === ".git" ||
          part === "",
      )
  )
    fail("WORKTREE_UNSUPPORTED", "Unsafe or unsupported result pathname.");
  if (
    process.platform === "win32" &&
    path
      .split("/")
      .some(
        (part) =>
          /[<>"|?*]|[. ]$/.test(part) ||
          [...part].some((char) => char.charCodeAt(0) < 32) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    fail("WORKTREE_UNSUPPORTED", "This pathname is unsupported on Windows.");
}
export async function noFilters(
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  await rejectExternalFilters(root, signal);
}
export function nulPaths(text: string): string[] {
  const paths = text.split("\0").filter(Boolean);
  if (paths.length > WORKTREE_LIMITS.metadataPaths)
    fail("WORKTREE_UNSUPPORTED", "Too many paths to inspect safely.");
  return paths;
}
export function parseWorktreePorcelain(
  text: string,
): { path: string; head?: string; locked: boolean }[] {
  const result: { path: string; head?: string; locked: boolean }[] = [];
  let current: (typeof result)[number] | undefined;
  for (const field of text.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), locked: false };
      result.push(current);
    } else if (field.startsWith("HEAD ") && current)
      current.head = field.slice(5);
    else if (field.startsWith("locked") && current) current.locked = true;
  }
  return result;
}
export async function statuses(
  root: string,
  signal?: AbortSignal,
): Promise<GitStatus[]> {
  await noFilters(root, signal);
  const entries = nulPaths(
    await gitCommand(
      root,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ],
      signal,
    ),
  );
  const result: GitStatus[] = [];
  for (let index = 0; index < entries.length; ++index) {
    const entry = entries[index] as string;
    result.push({ status: entry.slice(0, 2), path: entry.slice(3) });
    if (/[RC]/.test(entry.slice(0, 2))) index++;
  }
  return result;
}
export function counts(items: GitStatus[]) {
  return {
    staged: items.filter(
      (item) => ![" ", "?", "!"].includes(item.status[0] ?? " "),
    ).length,
    unstaged: items.filter(
      (item) => ![" ", "?", "!"].includes(item.status[1] ?? " "),
    ).length,
    untracked: items.filter((item) => item.status === "??").length,
    ignored: items.filter((item) => item.status === "!!").length,
    conflicted: items.filter((item) => /U|AA|DD/.test(item.status)).length,
  };
}
export async function indexHash(identity: GitIdentity): Promise<string | null> {
  try {
    return hash(await readFile(join(identity.gitDir, "index")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export function textBytes(bytes: Buffer): string {
  if (bytes.includes(0))
    fail("WORKTREE_UNSUPPORTED", "Binary files cannot be transferred as text.");
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (!Buffer.from(text, "utf8").equals(bytes))
      fail("WORKTREE_UNSUPPORTED", "File encoding cannot round-trip as UTF-8.");
    return text;
  } catch {
    return fail(
      "WORKTREE_UNSUPPORTED",
      "File encoding cannot round-trip as UTF-8.",
    );
  }
}
export async function readText(
  policy: WorkspacePolicy,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  safePath(path);
  const requested = resolve(policy.root, path);
  for (
    let candidate = requested;
    !samePath(candidate, policy.root);
    candidate = dirname(candidate)
  ) {
    const info = await lstat(candidate).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (info?.isSymbolicLink())
      fail(
        "WORKTREE_UNSUPPORTED",
        "Symlinks and symlink parents cannot be transferred.",
      );
    if (dirname(candidate) === candidate)
      fail("WORKTREE_UNSUPPORTED", "Path escaped its workspace.");
  }
  const resolved = await policy.resolve(path);
  if (!samePath(requested, resolved))
    fail("WORKTREE_STALE", "Result path identity changed.");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(resolved, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > WORKTREE_LIMITS.fileBytes)
      fail(
        "WORKTREE_UNSUPPORTED",
        "Only bounded regular text files are supported (512000 bytes/file).",
      );
    if (process.platform !== "win32" && info.mode & 0o111)
      fail(
        "WORKTREE_UNSUPPORTED",
        "Executable or mode changes are unsupported.",
      );
    const bytes = Buffer.alloc(WORKTREE_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      cancelled(signal);
      const read = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > WORKTREE_LIMITS.fileBytes)
      fail("WORKTREE_UNSUPPORTED", "File exceeds the transfer limit.");
    if (!samePath(await policy.resolve(path), resolved))
      fail("WORKTREE_STALE", "File path changed during reading.");
    return textBytes(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
}
