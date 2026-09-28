/** @jsxImportSource @opentui/react */
import { stripVTControlCharacters } from "node:util";
import React from "react";
import type { FileDiff } from "../types/domain.js";
import type { TranscriptEntry } from "./tui-controller.js";

const colors: Record<TranscriptEntry["tone"], string> = {
  assistant: "#d6dce5",
  user: "#f0f3f7",
  tool: "#98a6b6",
  info: "#aebbc9",
  warn: "#e5bf74",
  error: "#e98484",
  success: "#88c89b",
  dim: "#8390a0",
  logo: "#83cbd5",
};
export const TRANSCRIPT_WINDOW = 240;

export function visibleTranscriptWindow(
  entries: readonly TranscriptEntry[],
  requestedEnd?: number,
) {
  const end = Math.max(
    0,
    Math.min(entries.length, requestedEnd ?? entries.length),
  );
  const start = Math.max(0, end - TRANSCRIPT_WINDOW);
  return { start, end, entries: entries.slice(start, end) };
}

/** Keep the original patch in the session; sanitize only the render model. */
export function terminalSafeText(input: string, maxChars = 100_000): string {
  return Array.from(
    stripVTControlCharacters(input.slice(0, maxChars)),
    (character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && code !== 10 && code !== 9) || code === 127
        ? " "
        : character;
    },
  ).join("");
}

export function changedLinePreview(diff: FileDiff, maxLines = 5): string[] {
  const result: string[] = [];
  for (const line of terminalSafeText(diff.patch).split("\n")) {
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      result.push(line.slice(0, 240));
      if (result.length >= maxLines) break;
    }
  }
  return result;
}

export function diffViewForWidth(width: number): "split" | "unified" {
  return width >= 100 ? "split" : "unified";
}

export function OpenTuiTranscript({
  entries,
  contentWidth,
  expandedId,
  windowEnd,
}: {
  entries: readonly TranscriptEntry[];
  contentWidth: number;
  expandedId?: number;
  windowEnd?: number;
}) {
  const visible = visibleTranscriptWindow(entries, windowEnd);
  return (
    <React.Fragment>
      {visible.start > 0 && (
        <text fg="#8390a0">
          ↑ Ещё {visible.start} сообщений · PgUp / колесо
        </text>
      )}
      {visible.entries.map((entry) => {
        const diff = entry.fileDiff;
        if (!diff)
          return (
            <text key={entry.id} fg={colors[entry.tone]} selectable>
              {terminalSafeText(entry.text, 20_000)}
            </text>
          );
        const preview = changedLinePreview(diff);
        const occurrences = new Map<string, number>();
        const previewItems = preview.map((line) => {
          const count = (occurrences.get(line) ?? 0) + 1;
          occurrences.set(line, count);
          return { key: `${entry.id}:${line}:${count}`, line };
        });
        return (
          <box key={entry.id} width="100%" flexDirection="column">
            <text fg="#9fb0c0">
              {terminalSafeText(diff.path, 180)} · +{diff.additions} −
              {diff.deletions} · Ctrl+D
            </text>
            {previewItems.map(({ key, line }) => (
              <text key={key} fg={line.startsWith("+") ? "#88c89b" : "#e98484"}>
                {line}
              </text>
            ))}
            {expandedId === entry.id && (
              <diff
                diff={terminalSafeText(diff.patch)}
                view={diffViewForWidth(contentWidth)}
                height={Math.min(
                  20,
                  Math.max(5, diff.patch.split("\n").length),
                )}
                showLineNumbers
              />
            )}
          </box>
        );
      })}
      {visible.end < entries.length && (
        <text fg="#8390a0">
          ↓ Ещё {entries.length - visible.end} сообщений · PgDn / колесо
        </text>
      )}
    </React.Fragment>
  );
}
