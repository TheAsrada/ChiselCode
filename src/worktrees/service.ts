import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { hostname } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { loadProjectConfig } from "../config/load.js";
import type { Disposable } from "../extensions/contracts.js";
import {
  commitOid,
  commonGitResource,
  type GitIdentity,
  gitBytes,
  gitCommand,
  gitIdentity,
  gitLine,
  localGitResource,
  rejectExternalFilters,
} from "../git/driver.js";
import { chiselHomeDir } from "../paths/home.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import {
  IgnoredPathError,
  WorkspacePolicy,
} from "../security/workspace-policy.js";
import { withLock } from "../sessions/lock.js";
import type { PatchPlan } from "../tools/editing/patch-plan.js";
import { EditingService } from "../tools/editing/service.js";
import { buildFileDiff } from "../tools/file-diff.js";
import type { ToolContext, ToolPlan } from "../tools/types.js";
import type { WorkspaceAccess } from "../tools/workspace-coordinator.js";
import type { FileDiff, ToolExecutionResult } from "../types/domain.js";
import { PathSecurityError } from "../utils/paths.js";
import {
  bindWorktreePlanLifetime,
  onAbandonWorktreePlan,
  ownWorktreePlan,
} from "./capability.js";
import {
  atomicWorktreeJson,
  readWorktreeRegistry,
  updateWorktreeRegistry,
  type WorktreeRecord,
  type WorktreeRegistry,
} from "./registry.js";

export const WORKTREE_LIMITS = Object.freeze({
  fileBytes: 512_000,
  totalBytes: 8 * 1024 * 1024,
  selectedFiles: 200,
  metadataPaths: 20_000,
  records: 1000,
});
export type WorktreeAction =
  | "list"
  | "status"
  | "create"
  | "diff"
  | "apply"
  | "remove";
export interface WorktreeInput {
  id?: string;
  label?: string;
  ref?: string;
  paths?: string[];
}
export interface WorktreeDescriptor {
  id?: string;
  label: string;
  path: string;
  base?: string;
  head?: string;
  state: WorktreeRecord["state"] | "external";
  readOnly: boolean;
  origin?: string;
  retainedRef?: string;
  retainedCommit?: string;
  activeUsers?: number;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  ignored?: number;
  conflicted?: number;
  reason?: string;
}
export interface WorktreeWorkspacePort {
  access(
    action: WorktreeAction,
    input: WorktreeInput,
  ): Promise<readonly WorkspaceAccess[]>;
  prepare(
    action: WorktreeAction,
    input: WorktreeInput,
    context: ToolContext,
  ): Promise<ToolPlan>;
  open(id: string): Promise<{
    readonly descriptor: Readonly<WorktreeDescriptor>;
    dispose(): void | Promise<void>;
  }>;
}
interface Repository {
  identity: GitIdentity;
  directory: string;
  registry: string;
  trees: string;
  users: string;
}
interface GitStatus {
  path: string;
  status: string;
}
interface ResultFile {
  path: string;
  before: string | null;
  after: string | null;
  unsupported?: string;
}
interface ResultSnapshot {
  files: ResultFile[];
  head: string;
  index: string;
  diffs: FileDiff[];
  omitted: number;
  state: ReturnType<typeof counts>;
}
const hash = (value: string | Buffer | null): string | null =>
  value === null ? null : createHash("sha256").update(value).digest("hex");
const ownership = (
  record: Pick<
    WorktreeRecord,
    | "id"
    | "repository"
    | "origin"
    | "path"
    | "gitDir"
    | "base"
    | "label"
    | "conversationId"
    | "extensionId"
  >,
) =>
  hash(
    JSON.stringify([
      record.id,
      record.repository,
      record.origin,
      record.path,
      record.gitDir,
      record.base,
      record.label,
      record.conversationId,
      record.extensionId,
    ]),
  ) as string;
const stamp = async (path: string) => {
  const info = await lstat(path);
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
};
const samePath = (a: string, b: string) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : a === b;
const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
const fail = (
  code: ConstructorParameters<typeof RuntimeError>[0],
  message: string,
): never => {
  throw new RuntimeError(code, message);
};
function safePath(path: string): void {
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
async function noFilters(root: string, signal?: AbortSignal): Promise<void> {
  await rejectExternalFilters(root, signal);
}
function nulPaths(text: string): string[] {
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
async function statuses(
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
function counts(items: GitStatus[]) {
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
async function indexHash(identity: GitIdentity): Promise<string | null> {
  try {
    return hash(await readFile(join(identity.gitDir, "index")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function textBytes(bytes: Buffer): string {
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
async function readText(
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

/** Repository bookkeeping and controlled plans. No model, Session store, branch
 * switching or recursive deletion is implemented here. */
export class WorktreeService {
  constructor(private readonly home = chiselHomeDir()) {}
  private async repository(
    root: string,
    signal?: AbortSignal,
  ): Promise<Repository> {
    if (
      gitLine(
        await gitCommand(
          root,
          ["rev-parse", "--is-bare-repository"],
          signal,
          true,
        ),
      ) === "true"
    )
      fail(
        "WORKTREE_UNSUPPORTED",
        "Bare repositories are unsupported; open a working checkout.",
      );
    const identity = await gitIdentity(root, signal);
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const home = await realpath(this.home);
    if (within(identity.root, home))
      fail(
        "WORKTREE_UNSUPPORTED",
        "ChiselCode Home must be outside this checkout.",
      );
    const directory = join(
      home,
      "worktrees",
      createHash("sha256")
        .update(
          process.platform === "win32"
            ? identity.commonDir.toLowerCase()
            : identity.commonDir,
        )
        .digest("hex"),
    );
    for (const path of [
      dirname(directory),
      directory,
      join(directory, "trees"),
      join(directory, "users"),
    ]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      if (!samePath(await realpath(path), path))
        fail(
          "WORKTREE_RECOVERY_REQUIRED",
          "Managed storage path was replaced by a symlink.",
        );
    }
    return {
      identity,
      directory,
      registry: join(directory, "registry.json"),
      trees: join(directory, "trees"),
      users: join(directory, "users"),
    };
  }
  private checkedRecord(
    repository: Repository,
    registry: WorktreeRegistry,
    id: string,
  ): WorktreeRecord {
    const record = registry.records[id];
    if (
      !record ||
      record.id !== id ||
      record.ownership !== ownership(record) ||
      !samePath(record.repository, repository.identity.commonDir) ||
      !samePath(record.path, join(repository.trees, id)) ||
      !samePath(
        record.gitDir,
        join(repository.identity.commonDir, "worktrees", id),
      )
    )
      return fail(
        "WORKTREE_RECOVERY_REQUIRED",
        "Unknown worktree or registry identity mismatch; no filesystem action was authorized.",
      );
    return record;
  }
  private async verify(
    repository: Repository,
    record: WorktreeRecord,
    signal?: AbortSignal,
  ): Promise<GitIdentity> {
    await this.verifyOwner(repository, record);
    if (record.state !== "ready")
      fail(
        "WORKTREE_RECOVERY_REQUIRED",
        "Worktree is not ready. Inspect its recovery state.",
      );
    const identity = await gitIdentity(record.path, signal);
    if (
      !samePath(await realpath(record.path), record.path) ||
      !samePath(identity.root, record.path) ||
      !samePath(identity.commonDir, record.repository) ||
      !samePath(identity.gitDir, record.gitDir) ||
      (record.rootStamp && record.rootStamp !== (await stamp(record.path)))
    )
      fail(
        "WORKTREE_RECOVERY_REQUIRED",
        "Disk/Git ownership changed. This object is read-only.",
      );
    const registration = parseWorktreePorcelain(
      await gitCommand(
        repository.identity.root,
        ["worktree", "list", "--porcelain", "-z"],
        signal,
      ),
    );
    if (!registration.some((item) => samePath(item.path, record.path)))
      fail(
        "WORKTREE_RECOVERY_REQUIRED",
        "Git no longer registers this owned worktree.",
      );
    return identity;
  }
  private async verifyOwner(
    repository: Repository,
    record: WorktreeRecord,
  ): Promise<void> {
    const ownerPath = join(repository.directory, `${record.id}.owner.json`);
    const ownerInfo = await lstat(ownerPath).catch(() => undefined);
    let marker: unknown;
    if (
      ownerInfo?.isFile() &&
      !ownerInfo.isSymbolicLink() &&
      ownerInfo.size <= 256
    ) {
      try {
        marker = JSON.parse(await readFile(ownerPath, "utf8"));
      } catch {
        /* Invalid marker remains private. */
      }
    }
    if (
      !ownerInfo?.isFile() ||
      ownerInfo.isSymbolicLink() ||
      ownerInfo.size > 256 ||
      marker !== record.ownership
    )
      fail(
        "WORKTREE_RECOVERY_REQUIRED",
        "Immutable ownership marker does not match the registry.",
      );
  }
  workspace(root: string, lifetime: AbortSignal): WorktreeWorkspacePort {
    const assert = () => cancelled(lifetime);
    return Object.freeze({
      access: async (_action: WorktreeAction, input: WorktreeInput) => {
        assert();
        const repo = await this.repository(root, lifetime);
        const accesses: WorkspaceAccess[] = [
          { resource: repo.identity.root, mode: "read" },
          { resource: commonGitResource(repo.identity), mode: "read" },
          { resource: localGitResource(repo.identity), mode: "read" },
          { resource: repo.registry, mode: "write" },
        ];
        if (input.id) {
          const record = this.checkedRecord(
            repo,
            await readWorktreeRegistry(repo.registry),
            input.id,
          );
          accesses.push(
            { resource: record.path, mode: "read" },
            { resource: record.origin.root, mode: "read" },
            { resource: `git:local:${record.gitDir}`, mode: "read" },
          );
        }
        return accesses;
      },
      prepare: async (
        action: WorktreeAction,
        input: WorktreeInput,
        context: ToolContext,
      ) => {
        assert();
        if (!samePath(context.workspace.root, root))
          fail(
            "PERMISSION_DENIED",
            "Worktree port belongs to another workspace.",
          );
        const repo = await this.repository(root, context.signal);
        return bindWorktreePlanLifetime(
          await this.prepare(repo, action, input, {
            ...context,
            signal: context.signal
              ? AbortSignal.any([context.signal, lifetime])
              : lifetime,
          }),
          lifetime,
          action,
        );
      },
      open: async (id: string) => {
        assert();
        const repo = await this.repository(root, lifetime);
        const descriptor = await withLock(repo.registry, async () => {
          const record = this.checkedRecord(
            repo,
            await readWorktreeRegistry(repo.registry),
            id,
          );
          await this.verify(repo, record, lifetime);
          return Object.freeze(await this.descriptor(repo, record, lifetime));
        });
        const lease = await this.acquireUse(descriptor.path);
        try {
          assert();
          await withLock(repo.registry, async () =>
            this.verify(
              repo,
              this.checkedRecord(
                repo,
                await readWorktreeRegistry(repo.registry),
                id,
              ),
              lifetime,
            ),
          );
          return Object.freeze({ descriptor, dispose: () => lease.dispose() });
        } catch (error) {
          await lease.dispose();
          throw error;
        }
      },
    });
  }
  private plan(
    context: ToolContext,
    preview: string,
    execution: WorkspaceAccess[],
    execute: (context: ToolContext) => Promise<ToolExecutionResult>,
    diffs?: FileDiff[],
    command?: string,
  ): ToolPlan {
    const plan = {
      data: undefined,
      preview,
      resources: execution
        .map((access) => access.resource)
        .filter((path) => !path.startsWith("git:")),
      diffs,
      command,
    };
    return ownWorktreePlan(plan, {
      sessionId: context.session.id,
      invocationId: context.invocationId,
      execution,
      execute,
    });
  }
  private async supported(
    repo: Repository,
    base: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const version = /git version (\d+)\.(\d+)/.exec(
      await gitCommand(repo.identity.root, ["--version"], signal),
    );
    if (
      !version ||
      Number(version[1]) < 2 ||
      (Number(version[1]) === 2 && Number(version[2]) < 39)
    )
      fail("WORKTREE_UNSUPPORTED", "Git 2.39 or newer is required.");
    if (
      gitLine(
        await gitCommand(
          repo.identity.root,
          ["rev-parse", "--is-bare-repository"],
          signal,
        ),
      ) !== "false"
    )
      fail("WORKTREE_UNSUPPORTED", "Bare repositories are unsupported.");
    if (
      (
        await gitCommand(
          repo.identity.root,
          ["config", "--get", "core.sparseCheckout"],
          signal,
          true,
        )
      ).trim() === "true"
    )
      fail("WORKTREE_UNSUPPORTED", "Sparse checkout is unsupported.");
    await noFilters(repo.identity.root, signal);
    const infoAttributes = await readFile(
      join(repo.identity.commonDir, "info", "attributes"),
      "utf8",
    ).catch(() => "");
    if (/\bfilter\b/.test(infoAttributes))
      fail(
        "WORKTREE_UNSUPPORTED",
        "Repository filter attributes are unsupported.",
      );
    const entries = nulPaths(
      await gitCommand(
        repo.identity.root,
        ["ls-tree", "-r", "-z", base],
        signal,
      ),
    );
    if (process.platform === "win32") {
      const names = entries.map((entry) =>
        entry.slice(entry.indexOf("\t") + 1),
      );
      for (const path of names) safePath(path);
      if (
        new Set(names.map((path) => path.toLowerCase())).size !== names.length
      )
        fail(
          "WORKTREE_UNSUPPORTED",
          "Committed paths collide under Windows case rules.",
        );
    }
    if (entries.some((entry) => entry.startsWith("160000 ")))
      fail("WORKTREE_UNSUPPORTED", "Submodules are unsupported.");
    for (const entry of entries) {
      const path = entry.slice(entry.indexOf("\t") + 1);
      if (basename(path) !== ".gitattributes") continue;
      const attributes = await gitBytes(
        repo.identity.root,
        ["show", `${base}:${path}`],
        signal,
      );
      if (
        attributes.length > WORKTREE_LIMITS.fileBytes ||
        /\bfilter\b/.test(attributes.toString("utf8"))
      )
        fail(
          "WORKTREE_UNSUPPORTED",
          "Checkout filter attributes are unsupported.",
        );
    }
  }
  private async prepare(
    repo: Repository,
    action: WorktreeAction,
    input: WorktreeInput,
    context: ToolContext,
  ): Promise<ToolPlan> {
    if (action === "list")
      return this.plan(
        context,
        "List managed and external worktrees",
        [
          { resource: repo.registry, mode: "write" },
          { resource: commonGitResource(repo.identity), mode: "read" },
        ],
        async (ctx) => ({
          output: JSON.stringify(await this.list(repo, ctx.signal), null, 2),
        }),
      );
    if (action === "create") return this.prepareCreate(repo, input, context);
    const record = structuredClone(
      this.checkedRecord(
        repo,
        await readWorktreeRegistry(repo.registry),
        input.id ?? "",
      ),
    );
    if (action === "status")
      return this.plan(
        context,
        `Inspect worktree ${record.label}`,
        [
          { resource: record.path, mode: "read" },
          { resource: commonGitResource(repo.identity), mode: "read" },
          { resource: repo.registry, mode: "write" },
        ],
        async (ctx) => {
          await this.list(repo, ctx.signal);
          const current = this.checkedRecord(
            repo,
            await readWorktreeRegistry(repo.registry),
            record.id,
          );
          return {
            output: JSON.stringify(
              await this.descriptor(repo, current, ctx.signal),
              null,
              2,
            ),
          };
        },
      );
    await this.verify(repo, record, context.signal);
    if (action === "remove") return this.prepareRemove(repo, record, context);
    const snapshot = await this.result(
      repo,
      record,
      input.paths,
      context.signal,
    );
    if (action === "diff")
      return this.plan(
        context,
        `Result from committed base ${record.base}`,
        [
          { resource: record.path, mode: "read" },
          { resource: commonGitResource(repo.identity), mode: "read" },
        ],
        async (ctx) => {
          await this.recheckSource(repo, record, snapshot, ctx.signal);
          return {
            output: JSON.stringify(
              {
                worktree: record.id,
                label: record.label,
                base: record.base,
                head: snapshot.head,
                omitted: snapshot.omitted,
                state: snapshot.state,
                files: snapshot.files.map(({ path, unsupported }) => ({
                  path,
                  unsupported,
                })),
              },
              null,
              2,
            ),
            diffs: snapshot.diffs,
          };
        },
        snapshot.diffs,
      );
    return this.prepareApply(repo, record, snapshot, context);
  }
  private async prepareCreate(
    repo: Repository,
    input: WorktreeInput,
    context: ToolContext,
  ): Promise<ToolPlan> {
    const base = await commitOid(repo.identity.root, input.ref, context.signal);
    await this.supported(repo, base, context.signal);
    const dirty = counts(await statuses(repo.identity.root, context.signal));
    const id = randomUUID();
    const path = join(repo.trees, id);
    const gitDir = join(repo.identity.commonDir, "worktrees", id);
    if (
      (await lstat(path).catch(() => undefined)) ||
      (await lstat(gitDir).catch(() => undefined))
    )
      fail("WORKTREE_RECOVERY_REQUIRED", "Managed path is already occupied.");
    const now = new Date().toISOString();
    const record: WorktreeRecord = {
      schemaVersion: 1,
      id,
      revision: 1,
      repository: repo.identity.commonDir,
      origin: repo.identity,
      path,
      gitDir,
      base,
      label: input.label ?? "Рабочая копия",
      conversationId: context.approvalOwner?.rootOwnerId ?? context.session.id,
      extensionId: context.approvalOwner?.childId
        ? "builtin.subagents"
        : "builtin.worktrees",
      createdAt: now,
      updatedAt: now,
      state: "creating",
      generation: 1,
      ownership: "",
      intent: {
        action: "create",
        phase: "awaiting_approval",
        operationId: context.invocationId ?? randomUUID(),
        checkpointSession: context.session.id,
        ownerPid: process.pid,
        ownerHost: hostname(),
        ownerStart: await processStart(process.pid),
      },
    };
    record.ownership = ownership(record);
    await atomicWorktreeJson(
      join(repo.directory, `${id}.owner.json`),
      record.ownership,
    );
    await updateWorktreeRegistry(
      repo.registry,
      async (registry, _assertOwned) => {
        if (Object.keys(registry.records).length >= WORKTREE_LIMITS.records)
          fail(
            "WORKTREE_UNSUPPORTED",
            "Registry record limit reached; inspect archived results before creating more worktrees.",
          );
        registry.records[id] = record;
      },
    );
    const command = `git worktree add --detach ${JSON.stringify(path)} ${base}`;
    const plan = this.plan(
      context,
      `Создать рабочую копию «${record.label}»\nID: ${id}\nOrigin: ${repo.identity.root}\nBase: ${base}\nDetached HEAD; новые ветки не создаются. Незакоммиченные изменения origin не копируются.\nOrigin: staged ${dirty.staged}, unstaged ${dirty.unstaged}, untracked ${dirty.untracked}\nPath: ${path}`,
      [
        { resource: repo.identity.root, mode: "read" },
        { resource: path, mode: "write" },
        { resource: commonGitResource(repo.identity), mode: "write" },
        { resource: repo.registry, mode: "write" },
      ],
      async (ctx) =>
        updateWorktreeRegistry(repo.registry, async (registry, assertOwned) => {
          const current = this.checkedRecord(repo, registry, id);
          if (
            current.revision !== record.revision ||
            current.state !== "creating"
          )
            fail(
              "WORKTREE_STALE",
              "Create intent changed; submit a fresh call.",
            );
          const actual = await gitIdentity(repo.identity.root, ctx.signal);
          if (
            !samePath(actual.commonDir, repo.identity.commonDir) ||
            !samePath(actual.gitDir, repo.identity.gitDir)
          )
            fail("WORKTREE_STALE", "Origin Git identity changed.");
          await this.supported(repo, base, ctx.signal);
          if (
            !samePath(await realpath(repo.trees), repo.trees) ||
            (await lstat(path).catch(() => undefined)) ||
            (await lstat(gitDir).catch(() => undefined))
          )
            fail(
              "WORKTREE_STALE",
              "Managed destination changed before creation.",
            );
          current.intent = {
            ...(current.intent as NonNullable<WorktreeRecord["intent"]>),
            phase: "executing",
          };
          current.revision++;
          await assertOwned();
          await atomicWorktreeJson(repo.registry, registry, assertOwned);
          try {
            await assertOwned();
            await gitCommand(
              repo.identity.root,
              ["worktree", "add", "--detach", "--", path, base],
              ctx.signal,
            );
            const identity = await gitIdentity(path, ctx.signal);
            if (
              !samePath(identity.gitDir, gitDir) ||
              !samePath(identity.commonDir, current.repository) ||
              !samePath(identity.root, path) ||
              (await commitOid(path, "HEAD", ctx.signal)) !== base
            )
              fail(
                "WORKTREE_RECOVERY_REQUIRED",
                "Created directory failed its Git identity verification.",
              );
            await ctx.checkpoint();
            current.rootStamp = await stamp(path);
            current.state = "ready";
            current.lastAction = "created";
            current.intent = undefined;
            current.updatedAt = new Date().toISOString();
            current.revision++;
            return {
              output: JSON.stringify(
                await this.descriptor(repo, current, ctx.signal),
                null,
                2,
              ),
            };
          } catch (error) {
            // Cancellation never recursively deletes a partially materialized path.
            current.state = "recovery_required";
            current.lastAction = "create_interrupted";
            throw error;
          }
        }),
      undefined,
      command,
    );
    return onAbandonWorktreePlan(plan, async () => {
      await updateWorktreeRegistry(repo.registry, async (registry) => {
        const current = this.checkedRecord(repo, registry, id);
        if (
          current.intent?.operationId === record.intent?.operationId &&
          current.intent?.checkpointSession === context.session.id &&
          current.intent?.phase === "awaiting_approval"
        ) {
          current.state = "failed";
          current.lastAction = "create_not_executed";
          current.intent.outcome = "not-applied";
          current.revision++;
        }
      });
    });
  }
  private async origin(
    record: WorktreeRecord,
    signal?: AbortSignal,
  ): Promise<GitIdentity> {
    const identity = await gitIdentity(record.origin.root, signal);
    if (
      !samePath(identity.root, record.origin.root) ||
      !samePath(identity.commonDir, record.repository) ||
      !samePath(identity.gitDir, record.origin.gitDir)
    )
      fail(
        "WORKTREE_RECOVERY_REQUIRED",
        "Origin identity changed. No target path was authorized.",
      );
    return identity;
  }
  private async result(
    repo: Repository,
    record: WorktreeRecord,
    selected: readonly string[] | undefined,
    signal?: AbortSignal,
  ): Promise<ResultSnapshot> {
    await this.verify(repo, record, signal);
    await noFilters(record.path, signal);
    const head = await commitOid(record.path, "HEAD", signal);
    const index =
      (await indexHash({ ...repo.identity, gitDir: record.gitDir })) ??
      "missing";
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
      fail(
        "INVALID_TOOL_INPUT",
        "Select paths from the current result preview.",
      );
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
          fail(
            "WORKTREE_UNSUPPORTED",
            "Symlink results cannot be transferred.",
          );
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
            fail(
              "WORKTREE_UNSUPPORTED",
              "Base file exceeds the transfer limit.",
            );
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
        bytes +=
          Buffer.byteLength(before ?? "") + Buffer.byteLength(after ?? "");
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
  private async recheckSource(
    repo: Repository,
    record: WorktreeRecord,
    snapshot: ResultSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.result(
      repo,
      record,
      snapshot.files.map((file) => file.path),
      signal,
    );
    if (JSON.stringify(current) !== JSON.stringify(snapshot))
      fail(
        "WORKTREE_STALE",
        "Source changed since preview. Refresh the result and approve a new call.",
      );
  }
  private async targetStaging(
    record: WorktreeRecord,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const staged = nulPaths(
      await gitCommand(
        record.origin.root,
        [
          "diff",
          "--cached",
          "--name-only",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          "-z",
          "HEAD",
          "--",
        ],
        signal,
      ),
    );
    const unmerged = await gitCommand(
      record.origin.root,
      ["ls-files", "--unmerged", "-z", "--", ...paths],
      signal,
    );
    if (staged.some((path) => paths.includes(path)) || unmerged)
      fail(
        "WORKTREE_CONFLICT",
        "Selected origin paths have staged or conflicted changes. They were preserved.",
      );
  }
  private async prepareApply(
    repo: Repository,
    record: WorktreeRecord,
    source: ResultSnapshot,
    context: ToolContext,
  ): Promise<ToolPlan> {
    await this.assertTransferable(repo, record.id);
    if (source.files.some((file) => file.unsupported))
      fail(
        "WORKTREE_UNSUPPORTED",
        "This selection contains unsupported or ignored items. Select a supported subset from diff.",
      );
    if (record.intent?.phase === "executing" && !record.intent.outcome)
      fail(
        "WORKTREE_RECOVERY_REQUIRED",
        "An unfinished operation must be reconciled before applying another result.",
      );
    const target = await this.origin(record, context.signal);
    const targetHead = await commitOid(target.root, "HEAD", context.signal);
    const targetIndex = await indexHash(target);
    const targetStamp = await stamp(target.root);
    const config = await loadProjectConfig(target.root);
    const policy = new WorkspacePolicy(target.root, config.ignorePatterns);
    const editing = samePath(context.workspace.root, target.root)
      ? context.editing
      : new EditingService(
          policy,
          context.session.runtime?.workspaceObservations ?? {},
          true,
        );
    const changes: [string, string | null][] = [];
    const targetBytes = new Map<string, string | null>();
    await this.targetStaging(
      record,
      source.files.map((file) => file.path),
      context.signal,
    );
    for (const file of source.files) {
      if (
        await gitCommand(
          target.root,
          ["check-ignore", "--no-index", "--", file.path],
          context.signal,
          true,
        )
      )
        fail(
          "WORKTREE_UNSUPPORTED",
          "A selected target path is ignored by Git policy.",
        );
      const current = await readText(policy, file.path, context.signal);
      targetBytes.set(file.path, current);
      if (current !== file.before && current !== file.after)
        fail(
          "WORKTREE_CONFLICT",
          `Origin conflicts with the result at ${JSON.stringify(file.path)}; no files were changed.`,
        );
      if (current !== null)
        await editing.observe(file.path, Buffer.from(current, "utf8"));
      if (current !== file.after) changes.push([file.path, file.after]);
    }
    const patch: PatchPlan = await editing.replaceBatch(changes);
    const operationId = context.invocationId ?? randomUUID();
    await updateWorktreeRegistry(
      repo.registry,
      async (registry, _assertOwned) => {
        const current = this.checkedRecord(repo, registry, record.id);
        if (current.revision !== record.revision)
          fail(
            "WORKTREE_STALE",
            "Worktree metadata changed before preparation.",
          );
        current.intent = {
          action: "apply",
          phase: "awaiting_approval",
          operationId,
          sourceHead: source.head,
          targetHead,
          checkpointSession: context.session.id,
          files: source.files.map((file) => ({
            path: file.path,
            before: hash(targetBytes.get(file.path) ?? null),
            after: hash(file.after),
          })),
        };
        current.revision++;
        record.revision = current.revision;
      },
    );
    return this.plan(
      context,
      `Применить результат «${record.label}»\nID: ${record.id}\nSource: ${record.path}\nTarget origin: ${target.root}\nBase: ${record.base}\n${patch.operations.length} файлов; HEAD и index target не меняются. Все выбранные файлы проверены.`,
      [
        { resource: record.path, mode: "read" },
        { resource: target.root, mode: "write" },
        { resource: commonGitResource(target), mode: "read" },
        { resource: localGitResource(target), mode: "read" },
        { resource: repo.registry, mode: "write" },
      ],
      async (ctx) =>
        updateWorktreeRegistry(repo.registry, async (registry, assertOwned) => {
          await this.assertTransferable(repo, record.id);
          const current = this.checkedRecord(repo, registry, record.id);
          const intent = current.intent;
          if (
            current.revision !== record.revision ||
            !intent ||
            intent.operationId !== operationId
          )
            throw new RuntimeError(
              "WORKTREE_STALE",
              "Apply intent changed after approval.",
            );
          await this.recheckSource(repo, record, source, ctx.signal);
          const actual = await this.origin(record, ctx.signal);
          if (
            !samePath(actual.gitDir, target.gitDir) ||
            (await stamp(target.root)) !== targetStamp ||
            (await commitOid(target.root, "HEAD", ctx.signal)) !== targetHead ||
            (await indexHash(actual)) !== targetIndex
          )
            fail(
              "WORKTREE_STALE",
              "Origin HEAD, index or identity changed after preview.",
            );
          const livePolicy = new WorkspacePolicy(
            target.root,
            (await loadProjectConfig(target.root)).ignorePatterns,
          );
          await this.targetStaging(
            record,
            source.files.map((file) => file.path),
            ctx.signal,
          );
          for (const [path, bytes] of targetBytes)
            if ((await readText(livePolicy, path, ctx.signal)) !== bytes)
              fail(
                "WORKTREE_STALE",
                "Origin bytes changed after preview. Refresh the diff.",
              );
          intent.phase = "executing";
          current.revision++;
          await assertOwned();
          await atomicWorktreeJson(repo.registry, registry, assertOwned);
          await ctx.checkpoint();
          try {
            const outcome = await editing.commit(
              patch,
              ctx.signal,
              async () => {
                await assertOwned();
                await this.assertTransferable(repo, record.id);
                await this.recheckSource(repo, record, source, ctx.signal);
                const origin = await this.origin(record, ctx.signal);
                if (
                  (await stamp(origin.root)) !== targetStamp ||
                  (await commitOid(origin.root, "HEAD", ctx.signal)) !==
                    targetHead ||
                  (await indexHash(origin)) !== targetIndex
                )
                  fail(
                    "WORKTREE_STALE",
                    "Origin Git identity changed during apply.",
                  );
                const policyNow = new WorkspacePolicy(
                  origin.root,
                  (await loadProjectConfig(origin.root)).ignorePatterns,
                );
                for (const file of source.files) {
                  await policyNow.resolve(file.path);
                  if (
                    await gitCommand(
                      origin.root,
                      ["check-ignore", "--no-index", "--", file.path],
                      ctx.signal,
                      true,
                    )
                  )
                    fail("WORKTREE_STALE", "Path policy changed during apply.");
                }
                await assertOwned();
              },
            );
            intent.outcome = "completed";
            current.lastAction = patch.operations.length
              ? "applied"
              : "identical_noop";
            current.revision++;
            current.updatedAt = new Date().toISOString();
            return {
              output: `${outcome.modelMessage}\nOrigin: ${target.root}\nSource ${record.id} retained.`,
              diffs: outcome.diffs,
              details: {
                worktreeId: record.id,
                target: target.root,
                applied: outcome.changes.map((change) => change.path),
              },
            };
          } catch (error) {
            const outcome = await this.applyOutcome(current, livePolicy);
            intent.outcome = outcome;
            current.lastAction = "apply_failed";
            if (outcome === "partial-or-unknown")
              current.state = "recovery_required";
            throw error;
          }
        }),
      patch.diffs,
    );
  }
  private async applyOutcome(
    record: WorktreeRecord,
    policy: WorkspacePolicy,
  ): Promise<string> {
    const files = record.intent?.files ?? [];
    let before = 0,
      after = 0;
    try {
      for (const file of files) {
        const current = hash(await readText(policy, file.path));
        if (current === file.before) before++;
        if (current === file.after) after++;
      }
    } catch {
      return "partial-or-unknown";
    }
    return after === files.length
      ? "completed"
      : before === files.length
        ? "not-applied"
        : "partial-or-unknown";
  }
  private async prepareRemove(
    repo: Repository,
    record: WorktreeRecord,
    context: ToolContext,
  ): Promise<ToolPlan> {
    const check = async (signal?: AbortSignal) => {
      await this.verify(repo, record, signal);
      if (record.intent?.phase === "executing" && !record.intent.outcome)
        fail(
          "WORKTREE_RECOVERY_REQUIRED",
          "An unfinished operation blocks removal.",
        );
      if ((await this.users(repo, record.id)).length)
        fail(
          "WORKTREE_IN_USE",
          "Worktree is open in a conversation, scope/LSP or another application. Close its users before removal.",
        );
      if ((await statuses(record.path, signal)).length)
        fail(
          "WORKTREE_DIRTY",
          "Tracked, staged, untracked, ignored or conflicted files block removal. No discard/force is supported.",
        );
      const list = parseWorktreePorcelain(
        await gitCommand(
          repo.identity.root,
          ["worktree", "list", "--porcelain", "-z"],
          signal,
        ),
      );
      if (list.some((item) => samePath(item.path, record.path) && item.locked))
        fail(
          "WORKTREE_IN_USE",
          "Git worktree is locked; this service will not unlock it.",
        );
      return commitOid(record.path, "HEAD", signal);
    };
    const head = await check(context.signal);
    const command = `git worktree remove ${JSON.stringify(record.path)}`;
    return this.plan(
      context,
      `Удалить чистую рабочую копию «${record.label}»\nID: ${record.id}\nPath: ${record.path}\nBase: ${record.base}\n${head === record.base ? "HEAD совпадает с base." : `Commit-result ${head} будет удержан в internal ref перед удалением.`}\nDirty/ignored files и active users запрещают удаление.`,
      [
        { resource: record.path, mode: "write" },
        { resource: commonGitResource(repo.identity), mode: "write" },
        { resource: repo.registry, mode: "write" },
      ],
      async (ctx) =>
        updateWorktreeRegistry(repo.registry, async (registry, assertOwned) => {
          const current = this.checkedRecord(repo, registry, record.id);
          if (
            current.revision !== record.revision ||
            (await check(ctx.signal)) !== head
          )
            fail("WORKTREE_STALE", "Worktree changed after removal preview.");
          current.state = "removing";
          current.intent = {
            action: "remove",
            phase: "executing",
            operationId: ctx.invocationId ?? randomUUID(),
            checkpointSession: ctx.session.id,
            sourceHead: head,
          };
          current.revision++;
          await assertOwned();
          await atomicWorktreeJson(repo.registry, registry, assertOwned);
          if (head !== record.base) {
            const ref = `refs/chiselcode/worktrees/${record.id}/${head}`;
            await assertOwned();
            await gitCommand(
              repo.identity.root,
              ["update-ref", "--no-deref", ref, head],
              ctx.signal,
            );
            if ((await commitOid(repo.identity.root, ref, ctx.signal)) !== head)
              fail(
                "WORKTREE_RECOVERY_REQUIRED",
                "Commit retention failed; worktree was preserved.",
              );
            current.retainedRef = ref;
            current.retainedCommit = head;
            await assertOwned();
            await atomicWorktreeJson(repo.registry, registry, assertOwned);
          }
          // Recheck after retention, without force or raw filesystem deletion.
          await check(ctx.signal);
          await assertOwned();
          await gitCommand(
            repo.identity.root,
            ["worktree", "remove", "--", record.path],
            ctx.signal,
          );
          await ctx.checkpoint();
          if (await lstat(record.path).catch(() => undefined))
            fail(
              "WORKTREE_RECOVERY_REQUIRED",
              "Git remove did not remove the owned directory.",
            );
          current.state = "removed";
          current.intent = undefined;
          current.lastAction = "removed";
          current.updatedAt = new Date().toISOString();
          current.revision++;
          return {
            output: JSON.stringify(
              {
                id: current.id,
                state: current.state,
                retainedCommit: current.retainedCommit,
                retainedRef: current.retainedRef,
                recovery: current.retainedRef
                  ? `git show ${current.retainedRef}`
                  : undefined,
              },
              null,
              2,
            ),
          };
        }),
      undefined,
      command,
    );
  }
  private async descriptor(
    repo: Repository,
    record: WorktreeRecord,
    signal?: AbortSignal,
  ): Promise<WorktreeDescriptor> {
    const descriptor: WorktreeDescriptor = {
      id: record.id,
      label: record.label,
      path: record.path,
      base: record.base,
      origin: record.origin.root,
      state: record.state,
      readOnly: record.state !== "ready",
      retainedRef: record.retainedRef,
      retainedCommit: record.retainedCommit,
      activeUsers: (await this.users(repo, record.id)).length,
    };
    if (record.state === "ready") {
      try {
        await this.verify(repo, record, signal);
        descriptor.head = await commitOid(record.path, "HEAD", signal);
        Object.assign(descriptor, counts(await statuses(record.path, signal)));
      } catch (error) {
        cancelled(signal);
        descriptor.state = "recovery_required";
        descriptor.readOnly = true;
        descriptor.reason =
          error instanceof RuntimeError
            ? error.message
            : "Git state is unavailable.";
      }
    }
    if (record.state === "recovery_required" || record.state === "missing")
      descriptor.reason =
        "Inspect Git registration and the preserved directory. No automatic replay/repair/discard is performed.";
    return descriptor;
  }
  private async list(
    repo: Repository,
    signal?: AbortSignal,
  ): Promise<WorktreeDescriptor[]> {
    const actual = parseWorktreePorcelain(
      await gitCommand(
        repo.identity.root,
        ["worktree", "list", "--porcelain", "-z"],
        signal,
      ),
    );
    return updateWorktreeRegistry(
      repo.registry,
      async (registry, _assertOwned) => {
        const result: WorktreeDescriptor[] = [];
        for (const value of Object.values(registry.records)) {
          cancelled(signal);
          const record = this.checkedRecord(repo, registry, value.id);
          try {
            await this.verifyOwner(repo, record);
          } catch {
            record.state = "recovery_required";
            result.push({
              id: record.id,
              label: record.label,
              path: record.path,
              state: record.state,
              readOnly: true,
              reason: "Ownership marker changed; no action is authorized.",
            });
            continue;
          }
          if (
            record.intent?.action === "create" &&
            record.intent.phase === "awaiting_approval" &&
            !record.intent.outcome &&
            (await operationAlive(record.intent))
          ) {
            result.push({
              id: record.id,
              label: record.label,
              path: record.path,
              base: record.base,
              state: "creating",
              readOnly: true,
              reason:
                "Ожидает разрешения владельца; чтение списка не отменяет создание.",
            });
            continue;
          }
          const exists = await lstat(record.path).catch(() => undefined);
          const registered = actual.some((item) =>
            samePath(item.path, record.path),
          );
          const previous = record.state;
          if (!exists && !registered) {
            record.state =
              record.state === "removed" || record.intent?.action === "remove"
                ? "removed"
                : record.intent?.action === "create"
                  ? "failed"
                  : "missing";
            if (record.intent?.action === "remove") {
              record.lastAction = "remove_reconciled";
              record.intent = undefined;
            }
          } else if (!exists || !registered || exists.isSymbolicLink())
            record.state = "recovery_required";
          else if (
            record.intent?.action === "create" &&
            record.intent.phase === "executing"
          ) {
            try {
              const identity = await gitIdentity(record.path, signal);
              if (
                !samePath(identity.gitDir, record.gitDir) ||
                !samePath(identity.commonDir, record.repository) ||
                (await commitOid(record.path, "HEAD", signal)) !== record.base
              )
                fail(
                  "WORKTREE_RECOVERY_REQUIRED",
                  "Create identity could not be reconciled.",
                );
              record.rootStamp = await stamp(record.path);
              record.state = "ready";
              record.intent = undefined;
              record.lastAction = "create_reconciled";
            } catch {
              cancelled(signal);
              record.state = "recovery_required";
            }
          } else if (record.state === "removing") {
            record.state = "ready";
            record.intent = undefined;
            record.lastAction = "remove_not_applied";
          }
          if (
            record.intent?.action === "apply" &&
            record.intent.phase === "executing" &&
            !record.intent.outcome
          ) {
            const policy = new WorkspacePolicy(
              record.origin.root,
              (await loadProjectConfig(record.origin.root)).ignorePatterns,
            );
            record.intent.outcome = await this.applyOutcome(record, policy);
            if (record.intent.outcome === "partial-or-unknown")
              record.state = "recovery_required";
            record.lastAction = `apply_${record.intent.outcome}`;
          }
          if (previous !== record.state) {
            record.revision++;
            record.updatedAt = new Date().toISOString();
          }
          result.push(await this.descriptor(repo, record, signal));
        }
        for (const item of actual)
          if (
            !Object.values(registry.records).some((record) =>
              samePath(record.path, item.path),
            )
          )
            result.push({
              label: basename(item.path),
              path: item.path,
              head: item.head,
              state: "external",
              readOnly: true,
              reason:
                "External/origin worktree; this service does not own or remove it.",
            });
        return result;
      },
    );
  }
  private async users(
    repo: Repository,
    id: string,
  ): Promise<{ token: string; role?: string }[]> {
    const result: { token: string; role?: string }[] = [];
    for (const name of await readdir(repo.users)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      let user: {
        id: string;
        pid: number;
        host: string;
        start?: string;
        token: string;
        role?: string;
      };
      try {
        const info = await lstat(join(repo.users, name));
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
          throw new Error("Invalid owner record");
        user = JSON.parse(await readFile(join(repo.users, name), "utf8"));
      } catch {
        result.push({ token: "unknown-owner" });
        continue;
      }
      if (user.id !== id) continue;
      if (
        !Number.isInteger(user.pid) ||
        user.pid <= 0 ||
        user.host !== hostname()
      ) {
        result.push({ token: "unknown-owner" });
        continue;
      }
      try {
        process.kill(user.pid, 0);
        if (
          user.start &&
          process.platform === "linux" &&
          user.start !== (await processStart(user.pid))
        ) {
          if (user.role === "subagent_write")
            result.push({ token: user.token, role: user.role });
          continue;
        }
        result.push({ token: user.token, role: user.role });
      } catch (error) {
        if (user.role === "subagent_write") {
          result.push({ token: user.token, role: user.role });
          continue;
        }
        if (
          (error as NodeJS.ErrnoException).code !== "ESRCH" &&
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          result.push({ token: "unknown-owner" });
      }
    }
    return result;
  }
  private async assertTransferable(
    repo: Repository,
    id: string,
  ): Promise<void> {
    if (
      (await this.users(repo, id)).some(
        (user) =>
          user.role === "subagent_write" || user.token === "unknown-owner",
      )
    )
      fail(
        "WORKTREE_IN_USE",
        "Помощник ещё использует копию либо cleanup требует проверки. Остановите задачу и дождитесь завершения перед переносом.",
      );
  }
  /** Cross-process admission and remove share the registry lock. A scope holds
   * this through LSP/process shutdown; inactive tabs remain users. */
  async acquireUse(
    root: string,
    role: "workspace" | "subagent_write" = "workspace",
  ): Promise<Disposable> {
    const home = await realpath(this.home).catch(() => resolve(this.home));
    if (!within(join(home, "worktrees"), await realpath(root)))
      return { dispose() {} };
    let repo: Repository;
    try {
      repo = await this.repository(root);
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        (error.code === "WORKTREE_UNAVAILABLE" ||
          error.code === "WORKTREE_GIT_ERROR")
      )
        return { dispose() {} };
      throw error;
    }
    const token = randomUUID();
    // Ordinary repositories are not registry users. A damaged registry must
    // not disable their manifest, LSP, /btw or normal agent activation.
    if (!within(repo.trees, repo.identity.root)) return { dispose() {} };
    const file = join(repo.users, `${token}.json`);
    let owner: Record<string, unknown> | undefined;
    await withLock(repo.registry, async () => {
      const registry = await readWorktreeRegistry(repo.registry);
      const value = Object.values(registry.records).find((record) =>
        samePath(record.path, repo.identity.root),
      );
      if (!value) return;
      const record = this.checkedRecord(repo, registry, value.id);
      await this.verify(repo, record);
      owner = {
        id: record.id,
        root: record.path,
        token,
        role,
        pid: process.pid,
        host: hostname(),
        start: await processStart(process.pid),
        updatedAt: Date.now(),
      };
      await atomicWorktreeJson(file, owner);
    });
    if (!owner) return { dispose() {} };
    let heartbeat = Promise.resolve();
    let closed = false;
    const timer = setInterval(() => {
      heartbeat = heartbeat
        .then(async () => {
          if (!closed && owner)
            await atomicWorktreeJson(file, { ...owner, updatedAt: Date.now() });
        })
        .catch(() => {});
    }, 5000);
    timer.unref();
    return {
      dispose: async () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        await heartbeat;
        if (!samePath(await realpath(repo.users), repo.users))
          fail(
            "WORKTREE_RECOVERY_REQUIRED",
            "Use lease storage identity changed; no deletion was authorized.",
          );
        await rm(file, { force: true });
      },
    };
  }
}
async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  return value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
}

async function operationAlive(
  intent: NonNullable<WorktreeRecord["intent"]>,
): Promise<boolean> {
  if (!intent.ownerPid) return false;
  if (intent.ownerHost !== hostname()) return true;
  try {
    process.kill(intent.ownerPid, 0);
    return (
      !intent.ownerStart ||
      process.platform !== "linux" ||
      intent.ownerStart === (await processStart(intent.ownerPid))
    );
  } catch (error) {
    return !["ESRCH", "ENOENT"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    );
  }
}
