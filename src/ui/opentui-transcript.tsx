/** @jsxImportSource @opentui/react */
import { stripVTControlCharacters } from "node:util";
import React from "react";
import type { FileDiff } from "../types/domain.js";
import { type Palette, THEMES } from "./appearance.js";
import type { TranscriptEntry } from "./tui-controller.js";

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
    stripVTControlCharacters(input.slice(0, maxChars).replaceAll("\r\n", "\n")),
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

function inlineText(value: string, palette: Palette): React.ReactNode[] {
  const occurrences = new Map<string, number>();
  return value
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g)
    .map((part) => {
      const count = (occurrences.get(part) ?? 0) + 1;
      occurrences.set(part, count);
      const key = `${part}:${count}`;
      if (part.startsWith("**") && part.endsWith("**"))
        return (
          <b key={key}>
            <span fg={palette.text}>{part.slice(2, -2)}</span>
          </b>
        );
      if (part.startsWith("`") && part.endsWith("`"))
        return (
          <span key={key} fg={palette.green}>
            {part.slice(1, -1)}
          </span>
        );
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (link)
        return (
          <u key={key}>
            <span fg={palette.accent}>
              {link[1]} ({link[2]})
            </span>
          </u>
        );
      if (part.startsWith("*") && part.endsWith("*"))
        return <i key={key}>{part.slice(1, -1)}</i>;
      return part;
    });
}

/** Native text cells keep formatted answers visible in the windowed scrollbox. */
export function FormattedMessage({
  content,
  palette,
}: {
  content: string;
  palette: Palette;
}) {
  let fenced = false;
  // Appending deltas changes the tail's text, but never its source offset.
  let offset = 0;
  return (
    <box width="100%" flexDirection="column" paddingLeft={1} flexShrink={0}>
      {terminalSafeText(content, 20_000)
        .split("\n")
        .map((line) => {
          const key = offset;
          offset += line.length + 1;
          const fence = /^\s*```\s*([^`]*)$/.exec(line);
          if (fence) {
            fenced = !fenced;
            return (
              <text key={key} fg={palette.muted}>
                {fenced ? `  ┌─ ${fence[1] || "код"}` : "  └─"}
              </text>
            );
          }
          if (fenced)
            return (
              <text key={key} fg={palette.green} selectable>
                {" "}
                │ {line}
              </text>
            );
          const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
          if (heading)
            return (
              <text key={key} fg={palette.accent} selectable>
                <b>{inlineText(heading[1] ?? "", palette)}</b>
              </text>
            );
          const list = /^(\s*)([-*+]|\d+\.)\s+(.+)$/.exec(line);
          if (list)
            return (
              <text key={key} fg={palette.text} selectable>
                {list[1]}
                <span fg={palette.accent}>
                  {/^\d/.test(list[2] ?? "") ? list[2] : "•"}
                </span>{" "}
                {inlineText(list[3] ?? "", palette)}
              </text>
            );
          const quote = /^\s*>\s?(.*)$/.exec(line);
          if (quote)
            return (
              <text key={key} fg={palette.muted} selectable>
                <i>│ {inlineText(quote[1] ?? "", palette)}</i>
              </text>
            );
          if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line))
            return (
              <text key={key} fg={palette.border}>
                ────────────────────
              </text>
            );
          if (/^\s*\|?\s*:?-{3,}/.test(line)) return null;
          if (line.includes("|") && /^\s*\|/.test(line))
            return (
              <text key={key} fg={palette.text} selectable>
                {line
                  .trim()
                  .replace(/^\||\|$/g, "")
                  .split("|")
                  .map((cell) => cell.trim())
                  .join("  │  ")}
              </text>
            );
          return (
            <text key={key} fg={palette.text} selectable>
              {line ? inlineText(line, palette) : " "}
            </text>
          );
        })}
    </box>
  );
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
              <text fg={palette.accent}>◆ Помощник</text>
              <FormattedMessage content={entry.text} palette={palette} />
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
