import {
  admitWorkspace,
  WorkspaceAdmissionError,
  type WorkspaceRef,
} from "./admission.js";
import type { ApplicationPaths } from "./paths.js";

export interface LaunchIntent {
  readonly invocationCwd: string;
  readonly explicitCwd?: string;
  readonly launcher?: boolean;
  readonly prompt?: boolean;
  readonly resume?: string;
  readonly paths?: ApplicationPaths;
  readonly configPath?: string;
}

/** Capture cwd provenance before Commander or any UI applies defaults. */
export async function resolveLaunchWorkspace(
  intent: LaunchIntent,
): Promise<WorkspaceRef | undefined> {
  const required = Boolean(
    intent.prompt || intent.resume || intent.explicitCwd,
  );
  if (intent.launcher && !intent.explicitCwd) {
    if (required)
      throw new WorkspaceAdmissionError(
        "WORKSPACE_REQUIRED",
        "Для задачи и восстановления из ярлыка нужен явный проект.",
      );
    return undefined;
  }
  try {
    return await admitWorkspace(intent.explicitCwd ?? intent.invocationCwd, {
      base: intent.invocationCwd,
      source: intent.explicitCwd ? "explicit" : "terminal",
      paths: intent.paths,
      configPath: intent.configPath,
    });
  } catch (error) {
    if (
      !required &&
      error instanceof WorkspaceAdmissionError &&
      error.code === "WORKSPACE_PRIVATE"
    )
      return undefined;
    throw error;
  }
}
