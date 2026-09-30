import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { cancelled, RuntimeError } from "../../runtime/errors.js";
import type { WorkspacePolicy } from "../../security/workspace-policy.js";
import type { PatchOperation, PatchPlan } from "./patch-plan.js";
import { revision, sameRevision } from "./revisions.js";

async function content(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function validateOperation(
  operation: PatchOperation,
  workspace: WorkspacePolicy,
): Promise<void> {
  if ((await workspace.resolve(operation.candidate)) !== operation.path)
    throw new RuntimeError(
      "STALE_FILE_REVISION",
      "Path changed after preflight. Read it again.",
    );
  const current = await content(operation.path);
  if (
    operation.before === null
      ? current !== null
      : current === null || !sameRevision(revision(current), operation.expected)
  )
    throw new RuntimeError(
      "STALE_FILE_REVISION",
      `File changed since it was last read: ${operation.candidate}. Read it again before editing.`,
    );
}
async function stage(operation: PatchOperation): Promise<string | undefined> {
  if (operation.after === null) return undefined;
  await mkdir(dirname(operation.path), { recursive: true });
  const temporary = join(
    dirname(operation.path),
    `.chisel-edit-${randomUUID()}.tmp`,
  );
  const file = await open(temporary, "wx", operation.mode ?? 0o644);
  try {
    await file.writeFile(operation.after, "utf8");
    await file.sync();
    if (operation.mode !== undefined) await file.chmod(operation.mode);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
  return temporary;
}
export async function commitPatch(
  plan: PatchPlan,
  workspace: WorkspacePolicy,
  signal?: AbortSignal,
  beforeCommit?: (operation: PatchOperation, index: number) => Promise<void>,
): Promise<void> {
  cancelled(signal);
  for (const operation of plan.operations)
    await validateOperation(operation, workspace);
  const staged: (string | undefined)[] = [];
  const applied: PatchOperation[] = [];
  const directories = new Set<string>();
  try {
    for (const operation of plan.operations) {
      let parent = dirname(operation.path);
      while (!(await stat(parent).catch(() => undefined))) {
        directories.add(parent);
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
      staged.push(await stage(operation));
    }
    for (let index = 0; index < plan.operations.length; index++) {
      cancelled(signal);
      const operation = plan.operations[index];
      if (!operation) continue;
      await beforeCommit?.(operation, index);
      await validateOperation(operation, workspace);
      if (operation.after === null) await rm(operation.path);
      else {
        const file = staged[index];
        if (!file) throw new Error("Missing staged file.");
        await rename(file, operation.path);
      }
      applied.push(operation);
    }
  } catch (error) {
    const rolledBack: string[] = [];
    const rollbackFailed: string[] = [];
    for (const operation of [...applied].reverse()) {
      try {
        const current = await content(operation.path);
        if (
          operation.after === null
            ? current !== null
            : current === null ||
              !sameRevision(revision(current), revision(operation.after))
        )
          throw new Error("Concurrent change prevents rollback.");
        if (operation.before === null) await rm(operation.path);
        else {
          const file = await stage({ ...operation, after: operation.before });
          if (file) await rename(file, operation.path);
        }
        rolledBack.push(operation.path);
      } catch {
        rollbackFailed.push(operation.path);
      }
    }
    if (applied.length)
      throw new RuntimeError(
        "PATCH_PARTIAL_FAILURE",
        "Patch commit failed; review applied files and rollback details.",
        {
          cause: String(error),
          applied: applied.map((operation) => operation.path),
          rolledBack,
          rollbackFailed,
        },
      );
    throw error;
  } finally {
    for (const file of staged)
      if (file) await rm(file, { force: true }).catch(() => {});
    for (const directory of [...directories].sort(
      (a, b) => b.length - a.length,
    ))
      await rmdir(directory).catch(() => {});
  }
}
