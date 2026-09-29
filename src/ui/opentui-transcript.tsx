/** @jsxImportSource @opentui/react */
import { stripVTControlCharacters } from "node:util";
import { SyntaxStyle } from "@opentui/core";
import React from "react";
import type { FileDiff } from "../types/domain.js";
import { type Palette, THEMES } from "./appearance.js";
import type { TranscriptEntry } from "./tui-controller.js";

const markdownStyles = new Map<string, SyntaxStyle>();

export function markdownStyleFor(palette: Palette): SyntaxStyle {
  const key = `${palette.text}:${palette.accent}`;
  let style = markdownStyles.get(key);
  if (!style) {
    style = SyntaxStyle.fromStyles({
      default: { fg: palette.text },
      "markup.heading": { fg: palette.accent, bold: true },
      "markup.strong": { fg: palette.text, bold: true },
      "markup.italic": { fg: palette.text, italic: true },
      "markup.raw": { fg: palette.green },
      "markup.link": { fg: palette.accent, underline: true },
      "markup.quote": { fg: palette.muted, italic: true },
      "markup.list": { fg: palette.accent },
      keyword: { fg: palette.accent, bold: true },
      string: { fg: palette.green },
      number: { fg: palette.yellow },
      comment: { fg: palette.muted, italic: true },
    });
    markdownStyles.set(key, style);
  }
  return style;
}
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
          ↑ Ещё {visible.start} сообщений · PgUp / колесо
        </text>
      )}
      {visible.entries.map((entry) => {
        const diff = entry.fileDiff;
        if (!diff && entry.tone === "assistant")
          return (
            <React.Fragment key={entry.id}>
              <text fg={palette.accent}>◆ Chisel</text>
              <markdown
                content={terminalSafeText(entry.text, 20_000)}
                syntaxStyle={markdownStyleFor(palette)}
                conceal
                fg={palette.text}
                width={Math.max(12, contentWidth - 2)}
                marginLeft={2}
              />
            </React.Fragment>
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
                ❯{" "}
                <span fg={palette.text}>
                  {terminalSafeText(entry.text.replace(/^❯\s*/, ""), 20_000)}
                </span>
              </text>
            </box>
          );
        if (!diff && entry.tone === "tool")
          return (
            <text key={entry.id} fg={palette.muted}>
              {" "}
              ◆{" "}
              {terminalSafeText(
                entry.text.replace(/^\[chisel\]\s*/, ""),
                20_000,
              )}
            </text>
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
              {terminalSafeText(diff.path, 180)} · +{diff.additions} −
              {diff.deletions} · Ctrl+D
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
          ↓ Ещё {entries.length - visible.end} сообщений · PgDn / колесо
        </text>
      )}
    </React.Fragment>
  );
}
