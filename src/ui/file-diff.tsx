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
const fullModels = new WeakMap<FileDiff, DiffRenderModel>();
export function diffRenderModel(diff: FileDiff, full = false): DiffRenderModel {
  const cache = full ? fullModels : models;
  const cached = cache.get(diff);
  if (cached) return cached;
  const model: DiffRenderModel = {
    lines: [],
    hiddenLines: 0,
    shortenedLines: 0,
  };
  const add = (line: DiffLine) => {
    if (!full && model.lines.length >= MAX_DIFF_LINES) {
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
  cache.set(diff, model);
  return model;
}

export const DIFF_PREVIEW_ROWS = 5;

/** Quiet summary in the conversation; full details live in Ctrl+O. */
export function CompactFileDiff({
  fileDiff,
  columns,
}: {
  fileDiff: FileDiff;
  columns: number;
}) {
  const model = diffRenderModel(fileDiff);
  const changed = model.lines.filter(
    (line) => line.kind === "add" || line.kind === "remove",
  );
  const preview = changed.slice(0, DIFF_PREVIEW_ROWS);
  const hidden = Math.max(
    0,
    fileDiff.additions + fileDiff.deletions - preview.length,
  );
  return (
    <Box
      width={columns}
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexShrink={0}
    >
      <Text bold wrap="truncate-end">
        {fileDiffTitle(fileDiff)}
      </Text>
      <Text wrap="truncate-end">
        <Text color="green">+{fileDiff.additions}</Text>
        {"  "}
        <Text color="red">−{fileDiff.deletions}</Text>
        <Text dimColor> · строки</Text>
      </Text>
      {preview.map((line) => (
        <Text key={line.id} wrap="truncate-end" color={DIFF_COLORS[line.kind]}>
          {line.kind === "add" ? "+" : "−"} {line.text}
        </Text>
      ))}
      <Text dimColor wrap="truncate-end">
        {hidden ? `Ещё ${hidden} · ` : ""}Ctrl+O — раскрыть дифф
      </Text>
      {model.error ? <Text wrap="truncate-end">{model.error}</Text> : null}
    </Box>
  );
}

export function compactFileDiffRows(diff: FileDiff): number {
  const model = diffRenderModel(diff);
  return (
    5 +
    Math.min(
      DIFF_PREVIEW_ROWS,
      model.lines.filter(
        (line) => line.kind === "add" || line.kind === "remove",
      ).length,
    ) +
    Number(Boolean(model.error))
  );
}

/** Independent one-row items keep even very large expanded patches virtual. */
export function expandedDiffRows(diff: FileDiff): React.ReactNode[] {
  const model = diffRenderModel(diff, true);
  const digits = String(
    model.lines.reduce(
      (maximum, line) =>
        Math.max(maximum, line.oldLine ?? 0, line.newLine ?? 0),
      1,
    ),
  ).length;
  return [
    <Text key="title" bold wrap="truncate-end">
      ● {fileDiffTitle(diff)}
    </Text>,
    <Text key="stats" wrap="truncate-end">
      +{diff.additions} −{diff.deletions} · строки
    </Text>,
    ...model.lines.map((line) => (
      <Text key={line.id} wrap="truncate-end">
        <Text dimColor>{diffLinePrefix(line, digits)}</Text>
        <Text color={DIFF_COLORS[line.kind]}>{line.text}</Text>
      </Text>
    )),
    <Text key="end" dimColor wrap="truncate-end">
      {model.error ?? "Старые / новые строки · Ctrl+O — свернуть"}
    </Text>,
  ];
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
