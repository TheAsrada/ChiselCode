import type { ToolInvocationState } from "../tools/invocation.js";
import type { ToolSource } from "../tools/types.js";
import type { OwnedChatCard } from "../types/chat-presentation.js";
import type { ToolExecutionResult } from "../types/domain.js";
import type { TranscriptEntry } from "./tui-controller.js";

export interface ToolAction {
  id: string;
  name: string;
  input: Record<string, unknown>;
  source?: ToolSource;
  state: ToolInvocationState | "interrupted";
  result?: ToolExecutionResult;
  progress?: string;
  foreground?: OwnedChatCard;
}
export type ToolActionUpdate = Pick<ToolAction, "id" | "name"> &
  Partial<ToolAction>;
export interface ActionGroup {
  id: string;
  kind: "actions" | "skills";
  items: ToolAction[];
}
export type TranscriptRow = TranscriptEntry & { actionGroup?: ActionGroup };
export interface ActionPresentation {
  expanded: Set<string>;
  outputs: Set<string>;
  limits: Map<string, number>;
  pages: Map<
    string,
    {
      offset: number;
      text: string;
      chunk?: number;
      loading?: boolean;
      error?: string;
    }
  >;
}
export function createActionPresentation(): ActionPresentation {
  return {
    expanded: new Set(),
    outputs: new Set(),
    limits: new Map(),
    pages: new Map(),
  };
}
export const ACTION_PAGE = 40;
export const OUTPUT_CHUNK = 6000;
const mutations = new Set([
  "edit_file",
  "write_file",
  "delete_file",
  "apply_patch",
]);
export function actionIsSeparate(
  name: string,
  result?: ToolExecutionResult,
): boolean {
  if (mutations.has(name)) return true;
  if (!result) return false;
  if (result.diffs?.length || result.fileDiff) return true;
  if (
    result.details?.backgroundTask ||
    result.details?.backgroundTasks ||
    result.details?.subagent ||
    result.details?.subagents
  )
    return true;
  const web = result.details?.web;
  if (
    web &&
    typeof web === "object" &&
    "action" in web &&
    web.action === "download"
  )
    return true;
  return Boolean(
    result.presentation &&
      !(
        name === "run_shell" &&
        result.presentation.extensionId === "builtin.background" &&
        typeof result.details?.foregroundTaskId === "string"
      ),
  );
}
export function actionState(result: ToolExecutionResult): ToolAction["state"] {
  if (result.requiresApproval) return "awaiting_approval";
  if (result.errorCode === "CANCELLED") return "cancelled";
  if (
    result.isError &&
    /DENIED|PERMISSION|MODE_RESTRICTION/.test(result.errorCode ?? "")
  )
    return "denied";
  return result.isError ? "failed" : "succeeded";
}
export function actionRunning(action: ToolAction): boolean {
  return ["queued", "prepared", "awaiting_approval", "running"].includes(
    action.state,
  );
}
export function actionFailed(action: ToolAction): boolean {
  return ["failed", "denied", "cancelled", "interrupted"].includes(
    action.state,
  );
}
export const actionStateLabels: Record<ToolAction["state"], string> = {
  queued: "В очереди",
  prepared: "Подготовлено",
  awaiting_approval: "Ожидает ответа",
  running: "Выполняется",
  succeeded: "Готово",
  failed: "Ошибка",
  denied: "Отказ",
  cancelled: "Отменено",
  interrupted: "Прервано",
};
export function actionCategory(action: ToolAction): string {
  if (
    ["read_file", "read_tool_result", "list_directory", "list_dir"].includes(
      action.name,
    )
  )
    return "Чтение";
  if (
    ["search_files", "grep", "glob", "git_diff", "git_status"].includes(
      action.name,
    )
  )
    return "Поиск";
  if (action.name === "run_shell") return "Команды";
  if (action.source?.type === "web" || /^web_/.test(action.name)) return "Web";
  if (action.source?.type === "mcp") return "MCP";
  if (/lsp|definition|reference|symbol|diagnostic/i.test(action.name))
    return "Код";
  if (action.source?.type === "extension") return "Расширения";
  return "Инструменты";
}
export function actionLabel(action: ToolAction): string {
  const input = action.input;
  const value =
    input.command ??
    input.path ??
    input.pattern ??
    input.query ??
    input.url ??
    input.name;
  const name =
    action.source?.type === "mcp"
      ? `${action.source.serverTitle} · ${action.source.title ?? action.source.originalName}`
      : action.source?.type === "extension"
        ? `${action.source.chat?.title ?? action.source.originalName} · ${action.source.extensionId}`
        : action.name;
  return `${name}${typeof value === "string" ? ` · ${value}` : ""}`;
}
export function actionReason(action: ToolAction): string {
  if (typeof action.result?.details?.failureReason === "string")
    return action.result.details.failureReason;
  const lines = action.result?.output.trim().split(/\r?\n/) ?? [];
  return (
    (
      lines.find((line) =>
        /\b\w*(?:Error|Exception)\b|\b(?:FAILED|denied)\b|ошибк|отказ/i.test(
          line,
        ),
      ) ?? lines.find((line) => line.trim())
    )?.trim() || actionStateLabels[action.state]
  );
}
export function mergeToolAction(
  previous: ToolAction | undefined,
  update: ToolActionUpdate,
): ToolAction {
  return {
    input: {},
    state: "running",
    ...previous,
    ...update,
    ...(update.result ? { state: actionState(update.result) } : {}),
  };
}
/** Only structured invocation entries participate; messages/cards remain hard boundaries. */
export function groupToolActions(
  entries: readonly TranscriptEntry[],
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let previous: ActionGroup | undefined;
  for (const entry of entries) {
    if (entry.toolBoundary) {
      previous = undefined;
      continue;
    }
    if (!entry.toolAction) {
      rows.push(entry);
      previous = undefined;
      continue;
    }
    if (entry.toolAction.state === "awaiting_approval") {
      rows.push({
        ...entry,
        text: `${actionStateLabels[entry.toolAction.state]} · ${actionLabel(entry.toolAction)}`,
        tone: "warn",
      });
      previous = undefined;
      continue;
    }
    const kind = entry.toolAction.name === "load_skill" ? "skills" : "actions";
    if (previous?.kind === kind) previous.items.push(entry.toolAction);
    else {
      previous = {
        id: `action-group:${kind}:${entry.toolAction.id}`,
        kind,
        items: [entry.toolAction],
      };
      rows.push({
        ...entry,
        actionGroup: previous,
      });
    }
  }
  return rows;
}
export interface ActionTarget {
  id: string;
  group?: ActionGroup;
  action?: ToolAction;
  page?: -1 | 1;
  more?: boolean;
}
/** A late standalone presentation can split a group while its details are open. */
export function preserveActionExpansion(
  state: ActionPresentation,
  previous: readonly TranscriptEntry[],
  next: readonly TranscriptEntry[],
): void {
  if (!state.expanded.size) return;
  const expandedItems = new Map<string, number>();
  for (const row of groupToolActions(previous)) {
    const group = row.actionGroup;
    if (!group || !state.expanded.has(group.id)) continue;
    for (const item of group.items)
      expandedItems.set(item.id, state.limits.get(group.id) ?? ACTION_PAGE);
    state.expanded.delete(group.id);
  }
  for (const row of groupToolActions(next)) {
    const group = row.actionGroup;
    if (!group) continue;
    const limits = group.items.flatMap((item) => {
      const limit = expandedItems.get(item.id);
      return limit === undefined ? [] : [limit];
    });
    if (limits.length) {
      state.expanded.add(group.id);
      state.limits.set(group.id, Math.max(...limits));
    }
  }
}
export async function activateActionTarget(
  state: ActionPresentation,
  target: ActionTarget,
  changed: () => void,
  read?: (action: ToolAction, offset: number) => Promise<string>,
  signal?: AbortSignal,
): Promise<void> {
  if (target.group) {
    if (target.more)
      state.limits.set(
        target.group.id,
        (state.limits.get(target.group.id) ?? ACTION_PAGE) + ACTION_PAGE,
      );
    else if (state.expanded.has(target.group.id))
      state.expanded.delete(target.group.id);
    else state.expanded.add(target.group.id);
    changed();
    return;
  }
  const action = target.action;
  if (!action?.result) return;
  const previous = state.pages.get(action.id);
  if (!target.page) {
    if (state.outputs.has(action.id)) {
      state.outputs.delete(action.id);
      changed();
      return;
    }
    state.outputs.add(action.id);
    if (previous) {
      changed();
      return;
    }
  }
  const text = previous?.text ?? action.result.output;
  const chunk = (previous?.chunk ?? 0) + (target.page ?? 0);
  if (
    !action.result.artifact ||
    (previous && chunk >= 0 && chunk * OUTPUT_CHUNK < text.length)
  ) {
    state.pages.set(action.id, {
      offset: previous?.offset ?? 0,
      text,
      chunk: Math.max(
        0,
        Math.min(Math.max(0, Math.ceil(text.length / OUTPUT_CHUNK) - 1), chunk),
      ),
    });
    changed();
    return;
  }
  const offset = Math.max(
    0,
    (previous?.offset ?? 0) + (target.page ?? 0) * 100,
  );
  if (previous?.loading) return;
  state.pages.set(action.id, {
    offset,
    text: previous?.text ?? "",
    loading: true,
  });
  changed();
  try {
    if (!read) throw new Error("Полный результат недоступен в этом просмотре.");
    const output = await read(action, offset);
    if (signal?.aborted) return;
    state.pages.set(action.id, {
      offset,
      text: output,
      chunk:
        target.page === -1
          ? Math.max(0, Math.ceil(output.length / OUTPUT_CHUNK) - 1)
          : 0,
    });
  } catch (error) {
    if (signal?.aborted) return;
    state.pages.set(action.id, { offset, text: "", error: String(error) });
  }
  changed();
}
export function actionTargets(
  rows: readonly TranscriptRow[],
  state: ActionPresentation,
): ActionTarget[] {
  return rows.flatMap((row): ActionTarget[] => {
    const group = row.actionGroup;
    if (!group) return row.sideOperationId ? [{ id: row.sideOperationId }] : [];
    const targets: ActionTarget[] = [{ id: group.id, group }];
    if (!state.expanded.has(group.id)) return targets;
    const limit = state.limits.get(group.id) ?? ACTION_PAGE;
    for (const action of group.items.slice(0, limit)) {
      if (group.kind === "skills" || !action.result) continue;
      targets.push({ id: `action-output:${action.id}`, action });
      if (state.outputs.has(action.id)) {
        targets.push(
          { id: `action-prev:${action.id}`, action, page: -1 },
          { id: `action-next:${action.id}`, action, page: 1 },
        );
      }
    }
    if (group.items.length > limit)
      targets.push({ id: `action-more:${group.id}`, group, more: true });
    return targets;
  });
}
