import type { ContextCompactionRecord } from "../context/types.js";
import { elapsedSeconds } from "./request-timing.js";

/** Presentation metadata stays outside the model conversation. */
export function compactionNotice(record: ContextCompactionRecord): string {
  const approximate = record.estimated ? "~" : "";
  const tokens = (value: number) =>
    approximate + Math.ceil(value).toLocaleString("ru-RU");
  const freed =
    record.beforeTokens > 0
      ? Math.max(
          0,
          Math.round((1 - record.afterTokens / record.beforeTokens) * 100),
        )
      : 0;
  return `Контекст сжат автоматически\n${tokens(record.beforeTokens)} -> ${tokens(record.afterTokens)} токенов · освобождено ${freed}% · ${elapsedSeconds(record.durationMs, true)}`;
}
