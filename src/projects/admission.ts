import { realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { WorktreeService } from "../worktrees/service.js";
import {
  type ApplicationPaths,
  applicationPaths,
  isPrivatePath,
  pathIdentity,
} from "./paths.js";

export type WorkspaceSource =
  | "explicit"
  | "terminal"
  | "picker"
  | "resume"
  | "runtime"
  | "worktree";
export interface WorkspaceRef {
  readonly root: string;
  readonly kind: "directory" | "managed";
  readonly source: WorkspaceSource;
}
type Identity = {
  requested: string;
  dev: number;
  ino: number;
  paths: ApplicationPaths;
};
const admitted = new WeakMap<WorkspaceRef, Identity>();

export class WorkspaceAdmissionError extends RuntimeError {
  constructor(
    code:
      | "WORKSPACE_REQUIRED"
      | "WORKSPACE_UNAVAILABLE"
      | "WORKSPACE_PRIVATE"
      | "WORKSPACE_CHANGED",
    message: string,
  ) {
    super(code, `${message} Выберите рабочую папку или укажите --cwd <путь>.`);
  }
}

export async function admitWorkspace(
  input: string | undefined,
  options: {
    base?: string;
    source?: WorkspaceSource;
    allowFile?: boolean;
    paths?: ApplicationPaths;
    configPath?: string;
    signal?: AbortSignal;
  } = {},
): Promise<WorkspaceRef> {
  cancelled(options.signal);
  if (!input?.trim())
    throw new WorkspaceAdmissionError(
      "WORKSPACE_REQUIRED",
      "Проект не выбран.",
    );
  const clean = input.trim().replace(/^["']([\s\S]*)["']$/, "$1");
  let requested = resolve(options.base ?? process.cwd(), clean);
  let root: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(requested);
    if (!info.isDirectory() && options.allowFile && info.isFile()) {
      requested = dirname(requested);
      info = await stat(requested);
    }
    if (!info.isDirectory()) throw new Error("Ожидается каталог.");
    root = pathIdentity(await realpath(requested));
  } catch {
    throw new WorkspaceAdmissionError(
      "WORKSPACE_UNAVAILABLE",
      `Папка недоступна: ${requested}.`,
    );
  }
  cancelled(options.signal);
  const paths = options.paths ?? (await applicationPaths(options.configPath));
  let kind: WorkspaceRef["kind"] = "directory";
  if (isPrivatePath(paths, root)) {
    const managed = await new WorktreeService(
      paths.home,
    ).verifyManagedWorkspace(root, options.signal);
    if (!managed)
      throw new WorkspaceAdmissionError(
        "WORKSPACE_PRIVATE",
        "Это служебная папка ChiselCode, а не рабочий проект.",
      );
    kind = "managed";
  }
  cancelled(options.signal);
  const ref = Object.freeze({
    root,
    kind,
    source: options.source ?? "runtime",
  });
  admitted.set(ref, { requested, dev: info.dev, ino: info.ino, paths });
  await revalidateWorkspace(ref, options.signal);
  return ref;
}

/** Deserialized metadata and extension/model objects cannot manufacture admission. */
export async function revalidateWorkspace(
  ref: WorkspaceRef,
  signal?: AbortSignal,
): Promise<void> {
  cancelled(signal);
  const identity = admitted.get(ref);
  if (!identity)
    throw new WorkspaceAdmissionError(
      "WORKSPACE_CHANGED",
      "Допуск проекта не подтверждён.",
    );
  try {
    const root = await realpath(identity.requested);
    const info = await stat(root);
    if (
      !info.isDirectory() ||
      pathIdentity(root) !== pathIdentity(ref.root) ||
      info.dev !== identity.dev ||
      info.ino !== identity.ino
    )
      throw new Error("identity");
    if (
      ref.kind === "managed" &&
      !(await new WorktreeService(identity.paths.home).verifyManagedWorkspace(
        root,
        signal,
      ))
    )
      throw new Error("managed");
  } catch {
    cancelled(signal);
    throw new WorkspaceAdmissionError(
      "WORKSPACE_CHANGED",
      "Папка изменилась во время открытия.",
    );
  }
  cancelled(signal);
}
