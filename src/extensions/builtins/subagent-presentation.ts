import type {
  SubagentDescriptor,
  SubagentStatus,
} from "../../subagents/contracts.js";
import { SUBAGENT_STATES } from "../../subagents/contracts.js";
import { subagentStatusTitle } from "../../subagents/service.js";
import type {
  ChatCard,
  ChatPresentation,
} from "../../types/chat-presentation.js";
import type { ToolExecutionResult } from "../../types/domain.js";

const titles = {
  submit_readonly: "Запуск субагента · Чтение",
  submit_coding: "Запуск субагента · Рабочая копия",
  list: "Субагенты · Список задач",
  status: "Субагент · Проверка состояния",
  wait: "Субагенты · Ожидание задач",
  result: "Субагент · Получение результата",
  cancel: "Субагент · Остановка",
};
export type SubagentAction = keyof typeof titles;
export const subagentActionTitle = (action: SubagentAction) => titles[action];

export function subagentChatCard(child: SubagentDescriptor): ChatCard {
  const status = child.status;
  const tone =
    status === "completed"
      ? "success"
      : ["awaiting_approval", "interrupted", "cancelling"].includes(status)
        ? "warning"
        : [
              "failed",
              "timed_out",
              "budget_exhausted",
              "approval_unavailable",
            ].includes(status)
          ? "error"
          : ["running", "preparing"].includes(status)
            ? "accent"
            : "muted";
  return {
    id: child.id,
    revision: child.revision,
    title: child.label,
    subtitle: `Субагент ${String(child.ordinal).padStart(2, "0")} · ${child.mode === "coding" ? "Рабочая копия" : "Чтение"} · ${child.model}`,
    description: child.task,
    detail: child.step,
    status: { label: subagentStatusTitle(status), tone },
    target: { type: "subagent", id: child.id },
  };
}
function readChild(value: unknown): SubagentDescriptor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return ["id", "label", "task", "model", "step"].every(
    (key) => typeof record[key] === "string",
  ) &&
    ["readonly", "coding"].includes(String(record.mode)) &&
    SUBAGENT_STATES.includes(record.status as SubagentStatus) &&
    typeof record.ordinal === "number" &&
    typeof record.revision === "number"
    ? (record as unknown as SubagentDescriptor)
    : undefined;
}
export function subagentTaskView(value: unknown): ChatPresentation | undefined {
  const child =
    value && typeof value === "object" && "child" in value
      ? readChild(value.child)
      : undefined;
  return child ? { cards: [subagentChatCard(child)] } : undefined;
}
export function subagentToolView(
  action: SubagentAction,
  value: unknown,
): ChatPresentation | undefined {
  if (!value || typeof value !== "object" || !("output" in value))
    return undefined;
  const result = value as ToolExecutionResult;
  let data = result.details?.subagents;
  if (data === undefined) {
    try {
      data = JSON.parse(result.output);
    } catch {
      return undefined;
    }
  }
  const children = (Array.isArray(data) ? data : [data])
    .map(readChild)
    .filter((child) => child !== undefined);
  const cards = children.map(subagentChatCard);
  if (action.startsWith("submit_") && cards.length) return { cards };
  let summary = titles[action];
  if (Array.isArray(data))
    summary = `${action === "wait" ? "Субагенты · Статусы обновлены" : summary} · ${data.length}`;
  else if (
    data &&
    typeof data === "object" &&
    "status" in data &&
    SUBAGENT_STATES.includes(data.status as SubagentStatus)
  )
    summary += ` · ${subagentStatusTitle(data.status as SubagentStatus)}`;
  return { summary, ...(cards.length ? { cards } : {}) };
}
