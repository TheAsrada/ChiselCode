import type { AgentResult } from "../types/domain.js";

export function elapsedSeconds(elapsedMs: number, finished = false): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  return `${finished ? seconds.toFixed(1).replace(/\.0$/, "").replace(".", ",") : Math.floor(seconds)} с`;
}

export function requestCompletion(
  status: AgentResult["status"],
  elapsedMs: number,
): string {
  const duration = elapsedSeconds(elapsedMs, true);
  switch (status) {
    case "completed":
      return `Завершено за ${duration}`;
    case "failed":
      return `Завершено с ошибкой · ${duration}`;
    case "cancelled":
      return `Остановлено · ${duration}`;
    case "approval_required":
      return `Нужно подтверждение · ${duration}`;
  }
}
