import { resolve } from "node:path";
import type { AgentMode } from "../runtime/agent-mode.js";
import type { JsonObject, ToolExecutionResult } from "../types/domain.js";
import type { WorktreeDescriptor } from "../worktrees/service.js";

export type WorktreeManagerAction =
  | "list"
  | "status"
  | "create"
  | "diff"
  | "apply"
  | "remove"
  | "open"
  | "origin";
/** Application-owned command lane; UI receives data, never a filesystem capability. */
export interface WorktreeManagerActions {
  dispose?(): void;
  readonly root: string;
  readonly owner: string;
  readonly mode: AgentMode;
  run(
    action: WorktreeManagerAction,
    input?: JsonObject,
  ): Promise<ToolExecutionResult>;
  tabs(): readonly {
    key: string;
    label: string;
    path: string;
    busy: boolean;
    stopsProcesses?: boolean;
  }[];
  closeTab(key: string): boolean;
}
export const worktreeKey = (item: WorktreeDescriptor): string =>
  item.id ?? `${item.kind ?? "external"}:${item.path}`;
/** UI grouping only; the backend independently verifies identities and grants. */
export function sameWorktreePath(left: string, right: string): boolean {
  const a = resolve(left),
    b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}
export const worktreeOwned = (item: WorktreeDescriptor): boolean =>
  item.kind === "managed" || (item.kind === undefined && !!item.id);
export function worktreeRemoveBlock(
  item: WorktreeDescriptor,
): string | undefined {
  if (!worktreeOwned(item))
    return "Менеджер не удаляет основной проект и копии, созданные вне ChiselCode.";
  if (item.readOnly || item.state !== "ready")
    return item.reason ?? "Нужна проверка состояния копии.";
  if (item.activeUsers)
    return "Копия открыта во вкладке, используется задачей или другим процессом.";
  const counts = [
    item.staged,
    item.unstaged,
    item.untracked,
    item.ignored,
    item.conflicted,
  ];
  if (counts.some((count) => count === undefined))
    return "Состояние файлов ещё не проверено.";
  if (counts.some((count) => (count ?? 0) > 0))
    return "В копии остались изменения, новые или игнорируемые файлы. Посмотрите результат перед удалением.";
  return undefined;
}
