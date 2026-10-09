import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { RuntimeError } from "../runtime/errors.js";
import { withLock } from "../sessions/lock.js";

export const worktreeStates = [
  "creating",
  "ready",
  "removing",
  "removed",
  "missing",
  "recovery_required",
  "failed",
] as const;
const identity = z
  .object({ root: z.string(), gitDir: z.string(), commonDir: z.string() })
  .strict();
const fileIntent = z
  .object({
    path: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
  })
  .strict();
export const WorktreeRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    revision: z.number().int().nonnegative(),
    repository: z.string(),
    origin: identity,
    path: z.string(),
    gitDir: z.string(),
    base: z.string().regex(/^[a-f0-9]{40,64}$/),
    label: z.string().min(1).max(120),
    conversationId: z.string(),
    extensionId: z.enum(["builtin.worktrees", "builtin.subagents"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    state: z.enum(worktreeStates),
    generation: z.number().int().positive(),
    ownership: z.string().regex(/^[a-f0-9]{64}$/),
    rootStamp: z.string().optional(),
    retainedRef: z.string().optional(),
    retainedCommit: z.string().optional(),
    lastAction: z.string().optional(),
    intent: z
      .object({
        operationId: z.string(),
        ownerPid: z.number().int().positive().optional(),
        ownerHost: z.string().optional(),
        ownerStart: z.string().optional(),
        action: z.enum(["create", "remove", "apply"]),
        phase: z.enum(["awaiting_approval", "executing"]),
        sourceHead: z.string().optional(),
        targetHead: z.string().optional(),
        files: z.array(fileIntent).max(200).optional(),
        checkpointSession: z.string(),
        outcome: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorktreeRecord = z.infer<typeof WorktreeRecordSchema>;
const RegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    records: z.record(z.string(), WorktreeRecordSchema),
  })
  .strict();
export type WorktreeRegistry = z.infer<typeof RegistrySchema>;

export async function atomicWorktreeJson(
  path: string,
  data: unknown,
  assertOwned?: () => Promise<void>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = dirname(path);
  const checkParent = async () => {
    const actual = await realpath(parent);
    if (
      process.platform === "win32"
        ? resolve(actual).toLowerCase() !== resolve(parent).toLowerCase()
        : actual !== parent
    )
      throw new RuntimeError(
        "WORKTREE_RECOVERY_REQUIRED",
        "Managed metadata parent identity changed; no write was authorized.",
      );
  };
  await checkParent();
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(data));
      await file.sync();
    } finally {
      await file.close();
    }
    await assertOwned?.();
    await checkParent();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function readWorktreeRegistry(
  path: string,
): Promise<WorktreeRegistry> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 8 * 1024 * 1024)
      throw new Error("Invalid registry file.");
    return RegistrySchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, revision: 0, records: {} };
    throw new RuntimeError(
      "WORKTREE_RECOVERY_REQUIRED",
      "Worktree registry is invalid; it was preserved. Restore a valid registry before changing worktrees.",
    );
  }
}
export async function updateWorktreeRegistry<T>(
  path: string,
  work: (
    registry: WorktreeRegistry,
    assertOwned: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withLock(path, async (assertLease) => {
    const registry = await readWorktreeRegistry(path);
    const initialRevision = registry.revision;
    const assertOwned = async () => {
      try {
        await assertLease();
      } catch {
        throw new RuntimeError(
          "WORKTREE_STALE",
          "Registry lease was replaced; no stale write is permitted.",
        );
      }
      if ((await readWorktreeRegistry(path)).revision !== initialRevision)
        throw new RuntimeError(
          "WORKTREE_STALE",
          "Registry version changed; refresh before retrying.",
        );
    };
    try {
      await assertOwned();
      return await work(registry, assertOwned);
    } finally {
      await assertOwned();
      registry.revision++;
      await atomicWorktreeJson(path, registry, assertOwned);
    }
  });
}
