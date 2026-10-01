import { stripVTControlCharacters } from "node:util";
import { parsePatch } from "diff";
import type { FileDiff } from "../types/domain.js";
import { terminalSafeText } from "./terminal-text.js";
import { truncate } from "./theme.js";
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

function displayText(text: string): string {
  const clean = stripVTControlCharacters(text)
    .replace(/\t/g, "  ")
    .replace(/[\p{Cc}]/gu, "");
  return truncate(terminalSafeText(clean), MAX_DIFF_LINE_CHARS);
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
