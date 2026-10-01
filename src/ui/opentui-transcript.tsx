/** @jsxImportSource @opentui/react */
import React from "react";
import type { FileDiff } from "../types/domain.js";
import { type Palette, THEMES } from "./appearance.js";
import { FormattedMessage } from "./opentui-message.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";
import type { TranscriptEntry } from "./tui-controller.js";

export { terminalSafeText } from "./terminal-text.js";

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

export function changedLinePreview(diff: FileDiff, maxLines = 5): string[] {
  const result: string[] = [];
  for (const line of terminalSafeText(diff.patch).split("\n")) {
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      result.push(terminalLine(line, 240));
      if (result.length >= maxLines) break;
    }
  }
  return result;
}

export function diffViewForWidth(width: number): "split" | "unified" {
  return width >= 100 ? "split" : "unified";
}

export { FormattedMessage } from "./opentui-message.js";

export function OpenTuiTranscript({
  entries,
  contentWidth,
  expandedId,
  windowEnd,
  palette = THEMES.obsidian,
}: {
  entries: readonly TranscriptEntry[];
  contentWidth: number;
  expandedId?: number;
  windowEnd?: number;
  palette?: Palette;
}) {
  const visible = visibleTranscriptWindow(entries, windowEnd);
  return (
    <React.Fragment>
      {visible.start > 0 && (
        <text fg={palette.muted}>
          Up Ещё {visible.start} сообщений | PgUp / колесо
        </text>
      )}
      {visible.entries.map((entry) => {
        const diff = entry.fileDiff;
        if (!diff && entry.tone === "assistant")
          return (
            <FormattedMessage
              key={entry.id}
              id={`assistant-${entry.id}`}
              content={entry.text}
              palette={palette}
              width={contentWidth}
            />
          );
        if (!diff && entry.tone === "user")
          return (
            <box
              key={entry.id}
              width="100%"
              backgroundColor={palette.surface}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
            >
              <text fg={palette.accent}>
                {">"}{" "}
                <span fg={palette.text}>
                  {terminalSafeText(
                    entry.text.replace(/^[>\u276f]\s*/, ""),
                    20_000,
                  )}
                </span>
              </text>
            </box>
          );
        if (!diff && entry.tone === "tool")
          return (
            <text key={entry.id} fg={palette.muted}>
              {" "}
              •{" "}
              {terminalSafeText(
                entry.text.replace(/^\[chisel\]\s*/, ""),
                20_000,
              )}
            </text>
          );
        if (!diff && entry.tone === "dim")
          return (
            <box key={entry.id} width="100%" paddingLeft={1}>
              <text fg={palette.muted} selectable>
                {terminalSafeText(entry.text, 20_000)}
              </text>
            </box>
          );
        if (!diff)
          return (
            <text
              key={entry.id}
              fg={
                entry.tone === "error"
                  ? palette.red
                  : entry.tone === "warn"
                    ? palette.yellow
                    : entry.tone === "success"
                      ? palette.green
                      : palette.muted
              }
              selectable
            >
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
            <text fg={palette.accent}>
              {terminalSafeText(diff.path, 180)} | +{diff.additions} -
              {diff.deletions} | Ctrl+D
            </text>
            {previewItems.map(({ key, line }) => (
              <text
                key={key}
                fg={line.startsWith("+") ? palette.green : palette.red}
              >
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
        <text fg={palette.muted}>
          Down Ещё {entries.length - visible.end} сообщений | PgDn / колесо
        </text>
      )}
    </React.Fragment>
  );
}
