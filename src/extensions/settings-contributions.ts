import { effectiveBackgroundConfig } from "../background/config.js";
import { effectiveLspMode, globalLspDisabled } from "../lsp/config.js";
import { effectiveSubagentConfig } from "../subagents/config.js";
import type { GlobalConfig, ProjectConfig } from "../types/domain.js";

export interface SettingsContribution {
  title: string;
  description: string;
  keywords: readonly string[];
  fields: readonly { id: string; title: string; keywords: readonly string[] }[];
}

export function builtinAvailability(
  id: string,
  global: GlobalConfig,
  project?: ProjectConfig,
): { enabled: boolean; effective: boolean } {
  switch (id) {
    case "builtin.lsp": {
      const lsp = global.lsp ?? { servers: {} };
      return {
        enabled: !globalLspDisabled(lsp),
        effective:
          effectiveLspMode({
            global: lsp,
            project: project?.lsp,
            ignorePatterns: [],
          }) !== "off",
      };
    }
    case "builtin.subagents":
      return {
        enabled: effectiveSubagentConfig(global.subagents).enabled,
        effective: effectiveSubagentConfig(global.subagents, project?.subagents)
          .enabled,
      };
    case "builtin.background":
      return {
        enabled: effectiveBackgroundConfig(global.backgroundTasks).enabled,
        effective: effectiveBackgroundConfig(
          global.backgroundTasks,
          project?.backgroundTasks,
        ).enabled,
      };
    default:
      return { enabled: true, effective: true };
  }
}

export function externalAllowed(id: string, project?: ProjectConfig): boolean {
  const config = project?.externalExtensions;
  return !config?.disabled && !config?.disabledIds?.includes(id);
}
