import { parsePatch } from "diff";
import stringWidth from "string-width";
import type { FileDiff } from "../types/domain.js";
import type { Palette } from "./appearance.js";
import { type DiffLine, diffLinePrefix } from "./file-diff-model.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";

export const DIFF_PREVIEW_CHANGES = 6;
export interface DiffPreviewLine extends DiffLine {
  id: number;
}
export interface DiffPreview {
  lines: DiffPreviewLine[];
  hiddenChanges: number;
  digits: number;
  error?: string;
}
interface Candidate {
  line: DiffPreviewLine;
  hunk: DiffPreviewLine;
  before?: DiffPreviewLine;
  after?: DiffPreviewLine;
}
const previews = new WeakMap<FileDiff, DiffPreview>();

/** Select both sides of a replacement, retaining source coordinates and context. */
export function diffPreview(diff: FileDiff): DiffPreview {
  const cached = previews.get(diff);
  if (cached) return cached;
  const result: DiffPreview = { lines: [], hiddenChanges: 0, digits: 1 };
  const additions: Candidate[] = [];
  const removals: Candidate[] = [];
  let added = 0;
  let removed = 0;
  let serial = 0;
  try {
    for (const file of parsePatch(diff.patch)) {
      for (const hunk of file.hunks) {
        const heading: DiffPreviewLine = {
          id: serial++,
          kind: "hunk",
          text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        };
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        let previous: DiffPreviewLine | undefined;
        let lastCandidate: Candidate | undefined;
        for (const raw of hunk.lines) {
          const kind =
            raw[0] === "+"
              ? "add"
              : raw[0] === "-"
                ? "remove"
                : raw[0] === " "
                  ? "context"
                  : "note";
          if (kind === "note") continue;
          const line: DiffPreviewLine = {
            id: serial++,
            kind,
            oldLine:
              kind === "remove" || kind === "context" ? oldLine++ : undefined,
            newLine:
              kind === "add" || kind === "context" ? newLine++ : undefined,
            text: raw.slice(1),
          };
          if (kind === "context" && lastCandidate) lastCandidate.after = line;
          lastCandidate = undefined;
          if (kind === "add" || kind === "remove") {
            if (kind === "add") added++;
            else removed++;
            const candidates = kind === "add" ? additions : removals;
            if (candidates.length < DIFF_PREVIEW_CHANGES) {
              lastCandidate = {
                line,
                hunk: heading,
                before: previous?.kind === "context" ? previous : undefined,
              };
              candidates.push(lastCandidate);
            }
          }
          previous = line;
        }
      }
    }
    let removeCount = Math.min(
      removed,
      added ? DIFF_PREVIEW_CHANGES / 2 : DIFF_PREVIEW_CHANGES,
    );
    const addCount = Math.min(added, DIFF_PREVIEW_CHANGES - removeCount);
    removeCount = Math.min(removed, DIFF_PREVIEW_CHANGES - addCount);
    const selected = [
      ...removals.slice(0, removeCount),
      ...additions.slice(0, addCount),
    ].sort((a, b) => a.line.id - b.line.id);
    const rows = new Map<number, DiffPreviewLine>();
    for (const candidate of selected) {
      for (const line of [
        candidate.hunk,
        candidate.before,
        candidate.line,
        candidate.after,
      ]) {
        if (line) rows.set(line.id, line);
      }
    }
    let previous: DiffPreviewLine | undefined;
    for (const line of [...rows.values()].sort((a, b) => a.id - b.id)) {
      if (previous && line.kind !== "hunk" && line.id > previous.id + 1)
        result.lines.push({ id: -line.id, kind: "note", text: "..." });
      result.lines.push({
        ...line,
        text: terminalLine(
          terminalSafeText(line.text, line.text.length).replaceAll("\t", "  "),
          1_000,
        ),
      });
      previous = line;
    }
    result.hiddenChanges = added + removed - selected.length;
    result.digits = String(
      Math.max(
        1,
        ...result.lines.map((line) =>
          Math.max(line.oldLine ?? 0, line.newLine ?? 0),
        ),
      ),
    ).length;
    if (!result.lines.length && (diff.additions || diff.deletions))
      result.error = "Не удалось разобрать дифф";
  } catch {
    result.error = "Не удалось разобрать дифф";
  }
  previews.set(diff, result);
  return result;
}

export function diffAction(diff: FileDiff): string {
  return diff.kind === "create"
    ? "Создан"
    : diff.kind === "delete"
      ? "Удалён"
      : "Изменён";
}
export function emptyDiffMessage(diff: FileDiff): string {
  return diff.kind === "create"
    ? "Создан пустой файл"
    : diff.kind === "delete"
      ? "Удалён пустой файл"
      : "Без изменений";
}

export function hiddenDiffChanges(count: number): string {
  const ending = count % 100;
  const word =
    ending >= 11 && ending <= 14
      ? "изменений"
      : count % 10 === 1
        ? "изменение"
        : count % 10 >= 2 && count % 10 <= 4
          ? "изменения"
          : "изменений";
  return `ещё ${count} ${word}`;
}

/** Clip directories before the filename; Windows paths are normalized only on screen. */
export function diffPathLabel(path: string, width: number): string {
  const clean = terminalSafeText(path, path.length)
    .replaceAll("\\", "/")
    .replace(/[\n\t]/g, " ");
  if (stringWidth(clean) <= width) return clean;
  const basename = clean.slice(clean.lastIndexOf("/") + 1);
  if (stringWidth(basename) + 4 <= width) return `.../${basename}`;
  return terminalLine(basename, width);
}

export function diffPreviewText(diff: FileDiff, width: number): string[] {
  const preview = diffPreview(diff);
  const stats = `+${diff.additions} -${diff.deletions}`;
  const action = diffAction(diff);
  const title = `${action} ${diffPathLabel(diff.path, Math.max(1, width - stats.length - action.length - 4))} | ${stats}`;
  return [
    terminalLine(title, width),
    ...preview.lines.map((line) =>
      terminalLine(
        `${diffLinePrefix(line, preview.digits)}${line.text}`,
        width,
      ),
    ),
    ...(preview.lines.length
      ? []
      : [terminalLine(preview.error ?? emptyDiffMessage(diff), width)]),
    terminalLine(
      `${preview.hiddenChanges ? `${hiddenDiffChanges(preview.hiddenChanges)} | ` : ""}Ctrl+D: полный дифф`,
      width,
    ),
  ];
}

function tint(base: string, color: string, amount: number): string {
  const rgb = (hex: string) =>
    [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  const original = rgb(base);
  return `#${rgb(color)
    .map((channel, index) =>
      Math.round((original[index] ?? 0) * (1 - amount) + channel * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Use the active theme's surface so light and dark diffs have the same contrast. */
export function diffColors(palette: Palette) {
  return {
    addedBg: tint(palette.surface, palette.green, 0.12),
    removedBg: tint(palette.surface, palette.red, 0.12),
    contextBg: palette.surface,
    addedLineNumberBg: tint(palette.surface, palette.green, 0.2),
    removedLineNumberBg: tint(palette.surface, palette.red, 0.2),
    lineNumberBg: palette.surface,
    lineNumberFg: palette.muted,
    addedSignColor: palette.green,
    removedSignColor: palette.red,
    fg: palette.text,
    selectionBg: palette.raised,
    selectionFg: palette.text,
  };
}

export function diffFiletype(path: string): string | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return (
    {
      js: "javascript",
      jsx: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      ts: "typescript",
      tsx: "tsx",
      html: "html",
      htm: "html",
      css: "css",
      json: "json",
      py: "python",
      rs: "rust",
      go: "go",
      c: "c",
      h: "c",
      cpp: "cpp",
      sh: "bash",
      yml: "yaml",
      yaml: "yaml",
      md: "markdown",
    } as Record<string, string>
  )[extension ?? ""];
}

export function diffViewForWidth(width: number): "split" | "unified" {
  return width >= 100 ? "split" : "unified";
}
