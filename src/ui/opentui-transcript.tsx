/** @jsxImportSource @opentui/react */
import React from "react";
import { type Palette, THEMES } from "./appearance.js";
import { diffViewForWidth } from "./file-diff-preview.js";
import { ContextCompactionMessage } from "./opentui-compaction.js";
import { FileDiffCard } from "./opentui-file-diff.js";
import { FormattedMessage } from "./opentui-message.js";
import { terminalSafeText } from "./terminal-text.js";
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

export { FormattedMessage } from "./opentui-message.js";
export { diffViewForWidth };

export function OpenTuiTranscript({
  entries,
  contentWidth,
  expandedId,
  expandedIds,
  onToggleDiff,
  windowEnd,
  palette = THEMES.obsidian,
}: {
  entries: readonly TranscriptEntry[];
  contentWidth: number;
  expandedId?: number;
  expandedIds?: ReadonlySet<number>;
  onToggleDiff?: (id: number) => void;
  windowEnd?: number;
  palette?: Palette;
}) {
  const visible = visibleTranscriptWindow(entries, windowEnd);
  let latestDiffId: number | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.fileDiff) {
      latestDiffId = entries[index]?.id;
      break;
    }
  }
  return (
    <React.Fragment>
      {visible.start > 0 && (
        <text fg={palette.muted}>
          Up Ещё {visible.start} сообщений | PgUp / колесо
        </text>
      )}
      {visible.entries.map((entry) => {
        const diff = entry.fileDiff;
        if (!diff && entry.tone === "context")
          return (
            <ContextCompactionMessage
              key={entry.id}
              text={entry.text}
              palette={palette}
            />
          );
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
        return (
          <FileDiffCard
            key={entry.id}
            id={`file-diff-${entry.id}`}
            diff={diff}
            width={contentWidth}
            expanded={expandedIds?.has(entry.id) || expandedId === entry.id}
            latest={entry.id === latestDiffId}
            onToggle={onToggleDiff ? () => onToggleDiff(entry.id) : undefined}
            palette={palette}
          />
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
