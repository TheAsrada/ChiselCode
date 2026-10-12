import type { ChatPresentation } from "../types/chat-presentation.js";
import type { BackgroundState, BackgroundTask } from "./contracts.js";
export const backgroundStateLabels: Record<BackgroundState, string> = {
  queued: "В очереди",
  waiting_resources: "Ждёт ресурсы",
  awaiting_approval: "Нужно разрешение",
  starting: "Запускается",
  running: "Работает",
  stopping: "Останавливается",
  completed: "Завершено",
  failed: "Ошибка",
  cancelled: "Остановлено",
  timed_out: "Истёк срок",
  output_limit: "Лимит вывода",
  start_failed: "Не запущено",
  denied: "Отклонено",
  interrupted: "Прервано",
  lost: "Процесс потерян",
  cleanup_unknown: "Завершение не подтверждено",
};
export function backgroundTaskView(
  value: unknown,
): ChatPresentation | undefined {
  if (!value || typeof value !== "object" || !("task" in value)) return;
  const task = (value as { task: BackgroundTask }).task;
  if ("busy" in value && typeof value.busy === "string") {
    return {
      cards: [
        {
          id: `background-busy:${value.busy}`,
          revision: task.revision,
          title: "Ресурс занят фоновой задачей",
          subtitle: `${task.label} · ${task.ownerLabel} · ${task.workspaceLabel}`,
          description:
            "Связанные операции доступны после завершения команды. Можно остановить её, дождаться результата или выбрать другую копию.",
          status: { label: backgroundStateLabels[task.state], tone: "warning" },
          target: { type: "background_task", id: task.id },
          actions: [
            {
              label: "Открыть",
              action: "open",
              target: { type: "background_task", id: task.id },
            },
            {
              label: "Остановить",
              action: "stop",
              target: { type: "background_task", id: task.id },
            },
            {
              label: "Дождаться",
              action: "wait",
              target: { type: "background_task", id: task.id },
            },
          ],
        },
      ],
    };
  }
  const error = [
    "failed",
    "start_failed",
    "lost",
    "interrupted",
    "cleanup_unknown",
    "output_limit",
    "timed_out",
  ].includes(task.state);
  return {
    cards: [
      {
        id: task.id,
        revision: task.revision,
        title: task.label,
        subtitle: `${task.foreground ? "Команда" : "Фон"} · ${task.kind === "service" ? "Сервис" : "Проверка"} · ${task.ownerLabel} · ${task.workspaceLabel}`,
        description: task.tail.join("\n"),
        detail:
          task.exitCode != null
            ? `Код ${task.exitCode}${task.cleanup.confirmed ? "" : " · Завершение процессов не подтверждено"}`
            : task.readiness === "signal_seen"
              ? "Сигнал готовности получен"
              : "",
        status: {
          label:
            task.promoted && task.state === "running"
              ? "Продолжает в фоне"
              : backgroundStateLabels[task.state],
          tone: error
            ? "error"
            : task.state === "completed"
              ? "success"
              : task.state === "running"
                ? "accent"
                : ["awaiting_approval", "waiting_resources", "queued"].includes(
                      task.state,
                    )
                  ? "warning"
                  : "muted",
        },
        actions:
          task.foreground && ["starting", "running"].includes(task.state)
            ? [
                {
                  label: "В фон",
                  action: "promote",
                  target: { type: "background_task", id: task.id },
                },
                {
                  label: "Остановить",
                  action: "stop",
                  target: { type: "background_task", id: task.id },
                },
              ]
            : undefined,
        target:
          task.foreground && task.cleanup.confirmed && task.finishedAt
            ? undefined
            : { type: "background_task", id: task.id },
      },
    ],
  };
}
