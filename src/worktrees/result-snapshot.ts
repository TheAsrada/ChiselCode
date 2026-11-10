import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadProjectConfig } from "../config/load.js";
import {
  commitOid,
  type GitIdentity,
  gitBytes,
  gitCommand,
} from "../git/driver.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import {
  IgnoredPathError,
  WorkspacePolicy,
} from "../security/workspace-policy.js";
import { buildFileDiff } from "../tools/file-diff.js";
import type { FileDiff } from "../types/domain.js";
import { PathSecurityError } from "../utils/paths.js";
import { WORKTREE_LIMITS } from "./contracts.js";
import {
  counts,
  fail,
  indexHash,
  noFilters,
  nulPaths,
  readText,
  safePath,
  statuses,
  textBytes,
} from "./observations.js";
import type { WorktreeRecord } from "./registry.js";

export interface ResultFile {
  path: string;
  before: string | null;
  after: string | null;
  unsupported?: string;
}
export interface ResultSnapshot {
  files: ResultFile[];
  head: string;
  index: string;
  diffs: FileDiff[];
  omitted: number;
  state: ReturnType<typeof counts>;
}
export const resultHash = (file: ResultFile): string =>
  createHash("sha256")
    .update(JSON.stringify([file.before, file.after]))
    .digest("hex");
export async function readResultSnapshot(
  identity: GitIdentity,
  record: WorktreeRecord,
  selected: readonly string[] | undefined,
  signal?: AbortSignal,
): Promise<ResultSnapshot> {
  await noFilters(record.path, signal);
  const head = await commitOid(record.path, "HEAD", signal);
  const index =
    (await indexHash({ ...identity, gitDir: record.gitDir })) ?? "missing";
  const changed = [
    ...new Set([
      ...nulPaths(
        await gitCommand(
          record.path,
          [
            "diff",
            "--name-only",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "-z",
            record.base,
            "--",
          ],
          signal,
        ),
      ),
      ...nulPaths(
        await gitCommand(
          record.path,
          ["ls-files", "--others", "--exclude-standard", "-z"],
          signal,
        ),
      ),
    ]),
  ].sort();
  const paths = selected?.length ? [...new Set(selected)] : changed;
  if (
    process.platform === "win32" &&
    new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
  )
    fail(
      "WORKTREE_UNSUPPORTED",
      "Selected paths collide under Windows case rules.",
    );
  if (paths.length > WORKTREE_LIMITS.selectedFiles)
    fail(
      "WORKTREE_UNSUPPORTED",
      "Select at most 200 changed paths for this result.",
    );
  if (paths.some((path) => !changed.includes(path)))
    fail("INVALID_TOOL_INPUT", "Select paths from the current result preview.");
  const sourcePolicy = new WorkspacePolicy(
    record.path,
    (await loadProjectConfig(record.path)).ignorePatterns,
  );
  const originPolicy = new WorkspacePolicy(
    record.origin.root,
    (await loadProjectConfig(record.origin.root)).ignorePatterns,
  );
  const files: ResultFile[] = [];
  let bytes = 0;
  let omitted = changed.length - paths.length;
  for (const path of paths) {
    cancelled(signal);
    let before: string | null = null;
    try {
      safePath(path);
      // Reject symlinks before resolving; never read their target as a result.
      const sourceInfo = await lstat(resolve(record.path, path)).catch(
        () => undefined,
      );
      if (sourceInfo?.isSymbolicLink())
        fail("WORKTREE_UNSUPPORTED", "Symlink results cannot be transferred.");
      await sourcePolicy.resolve(path);
      await originPolicy.resolve(path);
      if (
        await gitCommand(
          record.path,
          ["check-ignore", "--no-index", "--", path],
          signal,
          true,
        )
      ) {
        omitted++;
        files.push({
          path,
          before: null,
          after: null,
          unsupported: "Ignored by Git policy; content was not read.",
        });
        continue;
      }
      const entry = nulPaths(
        await gitCommand(
          record.path,
          ["ls-tree", "-z", record.base, "--", path],
          signal,
        ),
      )[0];
      if (entry) {
        if (!entry.startsWith("100644 blob "))
          fail(
            "WORKTREE_UNSUPPORTED",
            "Binary modes, executable files, symlinks and gitlinks are unsupported.",
          );
        const oid = entry.split(" ")[2]?.split("\t")[0];
        if (
          !oid ||
          Number(
            await gitCommand(record.path, ["cat-file", "-s", oid], signal),
          ) > WORKTREE_LIMITS.fileBytes
        )
          fail("WORKTREE_UNSUPPORTED", "Base file exceeds the transfer limit.");
        before = textBytes(
          await gitBytes(
            record.path,
            ["cat-file", "blob", oid as string],
            signal,
          ),
        );
      }
      const after = await readText(sourcePolicy, path, signal);
      const indexed = (
        await gitCommand(
          record.path,
          ["ls-files", "--stage", "-z", "--", path],
          signal,
        )
      )
        .split("\0")
        .filter(Boolean);
      if (
        indexed.some(
          (item) => !item.startsWith("100644 ") || !/ 0\t/.test(item),
        )
      )
        fail(
          "WORKTREE_UNSUPPORTED",
          "Executable, symlink, gitlink or conflicted index entry is unsupported.",
        );
      bytes += Buffer.byteLength(before ?? "") + Buffer.byteLength(after ?? "");
      if (bytes > WORKTREE_LIMITS.totalBytes)
        fail(
          "WORKTREE_UNSUPPORTED",
          "Selected result exceeds the 8 MiB transfer budget.",
        );
      files.push({ path, before, after });
    } catch (error) {
      if (error instanceof PathSecurityError)
        files.push({
          path,
          before: null,
          after: null,
          unsupported:
            "Path boundary or symlink escape is unsupported; no content was read.",
        });
      else if (error instanceof IgnoredPathError) {
        omitted++;
        files.push({
          path,
          before: null,
          after: null,
          unsupported: "Ignored by workspace policy; content was not read.",
        });
      } else if (
        error instanceof RuntimeError &&
        error.code === "WORKTREE_UNSUPPORTED"
      )
        files.push({
          path,
          before: null,
          after: null,
          unsupported: error.message,
        });
      else throw error;
    }
  }
  return {
    head,
    index,
    state: counts(await statuses(record.path, signal)),
    files,
    omitted,
    diffs: files
      .filter((file) => !file.unsupported && file.before !== file.after)
      .map((file) => buildFileDiff(file.path, file.before, file.after)),
  };
}
