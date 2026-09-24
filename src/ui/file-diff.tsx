import { stripVTControlCharacters } from "node:util";
import { parsePatch } from "diff";
import { Box, Text } from "ink";
import type { FileDiff } from "../types/domain.js";
import { DIFF_COLORS, truncate } from "./theme.js";

export const MAX_DIFF_LINES = 200;
export const MAX_DIFF_LINE_CHARS = 1000;
export interface DiffLine {
  kind: "add" | "remove" | "context" | "hunk" | "note";
  oldLine?: number;
  newLine?: number;
  text: string;
}
export interface DiffRenderModel {
  lines: (DiffLine & { id: number })[];
  hiddenLines: number;
  shortenedLines: number;
  error?: string;
}

/** Only the display is bounded; FileDiff.patch remains complete for storage. */
const models = new WeakMap<FileDiff, DiffRenderModel>();
export function diffRenderModel(diff: FileDiff): DiffRenderModel {
  const cached = models.get(diff);
  if (cached) return cached;
  const model: DiffRenderModel = {
    lines: [],
    hiddenLines: 0,
    shortenedLines: 0,
  };
  const add = (line: DiffLine) => {
    if (model.lines.length >= MAX_DIFF_LINES) {
      model.hiddenLines++;
      return;
    }
    if (line.text.length > MAX_DIFF_LINE_CHARS) model.shortenedLines++;
    model.lines.push({
      ...line,
      id: model.lines.length,
      text: displayText(line.text),
    });
  };
  try {
    for (const file of parsePatch(diff.patch)) {
      for (const hunk of file.hunks) {
        add({
          kind: "hunk",
          text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        });
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const raw of hunk.lines) {
          if (raw.startsWith("+"))
            add({ kind: "add", newLine: newLine++, text: raw.slice(1) });
          else if (raw.startsWith("-"))
            add({ kind: "remove", oldLine: oldLine++, text: raw.slice(1) });
          else if (raw.startsWith(" "))
            add({
              kind: "context",
              oldLine: oldLine++,
              newLine: newLine++,
              text: raw.slice(1),
            });
          else add({ kind: "note", text: raw });
        }
      }
    }
  } catch {
    model.error = "Diff preview unavailable.";
  }
  models.set(diff, model);
  return model;
}

function displayText(text: string): string {
  return stripVTControlCharacters(truncate(text, MAX_DIFF_LINE_CHARS))
    .replace(/\t/g, "  ")
    .replace(/[\p{Cc}]/gu, "");
}

export function fileDiffTitle(diff: FileDiff): string {
  const action =
    diff.kind === "create"
      ? "Create"
      : diff.kind === "delete"
        ? "Delete"
        : "Update";
  return `${action}(${displayText(diff.path)})`;
}

export function fileDiffStats(diff: FileDiff): string {
  const count = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;
  if (diff.additions && diff.deletions)
    return `Added ${count(diff.additions)}, removed ${count(diff.deletions)}`;
  if (diff.additions) return `Added ${count(diff.additions)}`;
  if (diff.deletions) return `Removed ${count(diff.deletions)}`;
  return diff.kind === "create"
    ? "Created empty file"
    : diff.kind === "delete"
      ? "Deleted empty file"
      : "No changes";
}

export function diffLinePrefix(line: DiffLine, digits: number): string {
  if (line.kind === "hunk" || line.kind === "note") return "";
  const old = String(line.oldLine ?? "").padStart(digits);
  const next = String(line.newLine ?? "").padStart(digits);
  return `${old} ${next} ${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} `;
}

/** Unified layout on all widths; each source line occupies one bounded row. */
export function FileDiffView({
  fileDiff,
  columns,
}: {
  fileDiff: FileDiff;
  columns: number;
}) {
  const model = diffRenderModel(fileDiff);
  const color = process.env.NO_COLOR === undefined;
  const stats = fileDiffStats(fileDiff);
  const compactStats =
    stats.length + 3 > columns && (fileDiff.additions || fileDiff.deletions)
      ? `+${fileDiff.additions} -${fileDiff.deletions} lines`
      : stats;
  const digits = Math.max(
    1,
    ...model.lines.map(
      (line) => String(Math.max(line.oldLine ?? 0, line.newLine ?? 0)).length,
    ),
  );
  return (
    <Box flexDirection="column" width={Math.max(1, columns)} flexShrink={0}>
      <Text bold={color} wrap="truncate-end">
        ● {fileDiffTitle(fileDiff)}
      </Text>
      <Text wrap="truncate-end"> └ {compactStats}</Text>
      {model.lines.map((line) => (
        <Text key={line.id} wrap="truncate-end">
          <Text dimColor={color}>{diffLinePrefix(line, digits)}</Text>
          <Text
            color={color ? DIFF_COLORS[line.kind] : undefined}
            dimColor={
              color && (line.kind === "context" || line.kind === "note")
            }
          >
            {line.text}
          </Text>
        </Text>
      ))}
      {model.hiddenLines > 0 ? (
        <Text dimColor={color} wrap="truncate-end">
          … {model.hiddenLines} more diff lines
        </Text>
      ) : null}
      {model.shortenedLines > 0 ? (
        <Text dimColor={color} wrap="truncate-end">
          … {model.shortenedLines} long lines shortened
        </Text>
      ) : null}
      {model.lines.length > 0 ? (
        <Text dimColor={color} wrap="truncate-end">
          old / new · long rows clipped to width
        </Text>
      ) : null}
      {model.error ? <Text wrap="truncate-end">{model.error}</Text> : null}
    </Box>
  );
}

export function fileDiffRows(diff: FileDiff): number {
  const model = diffRenderModel(diff);
  return (
    2 +
    model.lines.length +
    Number(model.hiddenLines > 0) +
    Number(model.shortenedLines > 0) +
    Number(model.lines.length > 0) +
    Number(Boolean(model.error))
  );
}
