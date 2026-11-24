import { stat } from "node:fs/promises";
import { RuntimeError } from "../runtime/errors.js";
import type { WorkspacePolicy } from "../security/workspace-policy.js";
import type { ManagedOutcome } from "./managed.js";

async function requireDirectory(cwd: string): Promise<void> {
  let directory: boolean;
  try {
    directory = (await stat(cwd)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "каталог не существует"
        : code === "ENOTDIR"
          ? "компонент пути не является каталогом"
          : code === "EACCES" || code === "EPERM"
            ? "нет доступа к каталогу"
            : undefined;
    if (!reason) throw error;
    throw new RuntimeError("INVALID_TOOL_INPUT", `cwd «${cwd}»: ${reason}.`);
  }
  if (!directory)
    throw new RuntimeError(
      "INVALID_TOOL_INPUT",
      `cwd «${cwd}»: путь не является каталогом.`,
    );
}

export async function resolveShellCwd(
  cwd: string,
  workspace: WorkspacePolicy,
): Promise<string> {
  const resolved = await workspace.resolve(cwd);
  await requireDirectory(resolved);
  return resolved;
}

export async function recheckShellCwd(
  cwd: string,
  workspace?: WorkspacePolicy,
): Promise<void> {
  if (!workspace) return requireDirectory(cwd);
  if ((await resolveShellCwd(cwd, workspace)) !== cwd)
    throw new RuntimeError(
      "STALE_WORKSPACE",
      `Путь cwd «${cwd}» изменился до запуска.`,
    );
}

export async function shellStartError(
  cwd: string,
  outcome: ManagedOutcome,
): Promise<RuntimeError | undefined> {
  const failure = outcome.startFailure;
  if (
    !failure ||
    (!failure.spawnFailed &&
      outcome.cleanup &&
      (outcome.reason === "cancelled" || outcome.reason === "timed_out"))
  )
    return;
  if (outcome.cleanup && failure.spawnFailed) {
    try {
      await requireDirectory(cwd);
    } catch (error) {
      if (error instanceof RuntimeError)
        return new RuntimeError(
          error.code,
          `${error.message} Причина запуска: ${failure.message}`,
        );
    }
  }
  return new RuntimeError(
    "TOOL_EXECUTION_FAILURE",
    `Не удалось запустить команду в cwd «${cwd}». ${failure.message}`,
  );
}
