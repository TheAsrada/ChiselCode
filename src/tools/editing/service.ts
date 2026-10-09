import { readFile, realpath, stat } from "node:fs/promises";
import { relative } from "node:path";
import { RuntimeError } from "../../runtime/errors.js";
import type { WorkspacePolicy } from "../../security/workspace-policy.js";
import type { FileRevision } from "../../types/domain.js";
import { buildFileDiff } from "../file-diff.js";
import { commitPatch } from "./patch-commit.js";
import { applyHunks, parsePatch } from "./patch-parser.js";
import type { EditingResult, PatchOperation, PatchPlan } from "./patch-plan.js";
import { revision, sameRevision } from "./revisions.js";

export class EditingService {
  constructor(
    readonly workspace: WorkspacePolicy,
    readonly observations: Record<string, FileRevision>,
    readonly requireFreshRead = true,
    private readonly beforeCommit?: (
      operation: PatchOperation,
      index: number,
    ) => Promise<void>,
  ) {}
  async observe(candidate: string, bytes: Buffer): Promise<void> {
    this.observations[await this.workspace.resolve(candidate)] =
      revision(bytes);
  }
  private async operation(
    candidate: string,
    after: string | null,
    mustExist = false,
    mustBeNew = false,
  ): Promise<PatchOperation> {
    const path = await this.workspace.resolve(candidate);
    let before: string | null = null;
    let mode: number | undefined;
    try {
      const bytes = await readFile(path);
      before = bytes.toString("utf8");
      mode = (await stat(path)).mode & 0o777;
      const observed = this.observations[path];
      if (this.requireFreshRead && !observed)
        throw new RuntimeError(
          "STALE_FILE_REVISION",
          "Read-before-write policy: read this existing file first.",
        );
      if (observed && !sameRevision(observed, revision(bytes)))
        throw new RuntimeError(
          "STALE_FILE_REVISION",
          "File changed since it was last read. Read it again before editing.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (mustExist && before === null)
      throw new RuntimeError(
        "PATCH_CONFLICT",
        `File does not exist: ${candidate}`,
      );
    if (mustBeNew && before !== null)
      throw new RuntimeError(
        "PATCH_CONFLICT",
        `File already exists: ${candidate}`,
      );
    return {
      path,
      candidate,
      before,
      after,
      expected: before === null ? undefined : revision(before),
      mode,
    };
  }
  private async plan(operations: PatchOperation[]): Promise<PatchPlan> {
    const seen = new Set<string>();
    for (const operation of operations) {
      if (seen.has(operation.path))
        throw new RuntimeError(
          "PATCH_CONFLICT",
          `Conflicting operations for ${operation.candidate}`,
        );
      seen.add(operation.path);
    }
    const changed = operations.filter(
      (operation) => operation.before !== operation.after,
    );
    const root = await realpath(this.workspace.root);
    return {
      operations: changed,
      diffs: changed.map((operation) =>
        buildFileDiff(
          relative(root, operation.path),
          operation.before,
          operation.after,
        ),
      ),
      permissionResources: changed.map((operation) => operation.path),
    };
  }
  async writeBatch(files: [string, string][]): Promise<PatchPlan> {
    const operations: PatchOperation[] = [];
    for (const [path, content] of files)
      operations.push(await this.operation(path, content));
    return this.plan(operations);
  }
  /** Core multi-root consumers still use this same fresh-read/commit engine. */
  async replaceBatch(
    files: readonly [string, string | null][],
  ): Promise<PatchPlan> {
    const operations: PatchOperation[] = [];
    for (const [path, content] of files)
      operations.push(await this.operation(path, content, content === null));
    return this.plan(operations);
  }
  async write(path: string, content: string): Promise<PatchPlan> {
    return this.plan([await this.operation(path, content)]);
  }
  async edit(path: string, old: string, next: string): Promise<PatchPlan> {
    const operation = await this.operation(path, null, true);
    const occurrences = (operation.before ?? "").split(old).length - 1;
    if (!old || occurrences !== 1)
      throw new RuntimeError(
        "PATCH_CONFLICT",
        occurrences === 0
          ? "old_str was not found in the file."
          : "old_str occurs more than once; include more context for a unique replacement.",
      );
    operation.after = (operation.before ?? "").replace(old, () => next);
    return this.plan([operation]);
  }
  async delete(path: string): Promise<PatchPlan> {
    return this.plan([await this.operation(path, null, true)]);
  }
  async patch(text: string): Promise<PatchPlan> {
    const operations: PatchOperation[] = [];
    for (const parsed of parsePatch(text)) {
      if (parsed.kind === "add")
        operations.push(
          await this.operation(parsed.path, parsed.content ?? "", false, true),
        );
      else {
        const operation = await this.operation(parsed.path, null, true);
        if (parsed.kind === "update") {
          const after = applyHunks(operation.before ?? "", parsed.hunks);
          if (parsed.moveTo)
            operations.push(
              await this.operation(parsed.moveTo, after, false, true),
            );
          else operation.after = after;
        }
        operations.push(operation);
      }
    }
    return this.plan(operations);
  }
  async commit(
    plan: PatchPlan,
    signal?: AbortSignal,
    validate?: () => Promise<void>,
  ): Promise<EditingResult> {
    await commitPatch(
      plan,
      this.workspace,
      signal,
      async (operation, index) => {
        await this.beforeCommit?.(operation, index);
        await validate?.();
      },
    );
    const newRevisions: Record<string, FileRevision> = {};
    for (const operation of plan.operations) {
      if (operation.after === null) delete this.observations[operation.path];
      else {
        const next = revision(operation.after);
        this.observations[operation.path] = next;
        newRevisions[operation.path] = next;
      }
    }
    return {
      modelMessage: plan.operations.length
        ? `Updated ${plan.operations.length} files:\n${plan.diffs.map((diff) => `- ${diff.path} (${diff.kind})`).join("\n")}`
        : "No changes.",
      changes: plan.operations.map(({ path, before, after }) => ({
        path,
        before,
        after,
      })),
      diffs: plan.diffs,
      newRevisions,
    };
  }
}
