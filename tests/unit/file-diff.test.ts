import { describe, expect, test } from "bun:test";
import { buildFileDiff } from "../../src/tools/file-diff.js";
import {
  diffLinePrefix,
  diffRenderModel,
  fileDiffStats,
  MAX_DIFF_LINE_CHARS,
  MAX_DIFF_LINES,
} from "../../src/ui/file-diff.js";

describe("file diff model", () => {
  for (const [name, before, after, added, removed] of [
    ["add only", "a\n", "a\nb\nc\n", 2, 0],
    ["delete only", "a\nb\nc\n", "a\n", 0, 2],
    ["single line", "old", "new", 1, 1],
    ["multiline", "a\nb\nc\n", "a\nx\ny\nz\n", 3, 2],
    ["new file", null, "a\nb\n", 2, 0],
    ["empty create", null, "", 0, 0],
    ["empty delete", "", null, 0, 0],
    ["no change", "a\n", "a\n", 0, 0],
    ["patch-like content", "--- x\n+++ y\n", "@@ new\n", 1, 2],
    ["CRLF", "a\r\nb\r\n", "a\r\nc\r\n", 1, 1],
    ["final newline", "a", "a\n", 1, 1],
  ] as const) {
    test(name, () => {
      const diff = buildFileDiff("file.ts", before, after);
      expect(diff.additions).toBe(added);
      expect(diff.deletions).toBe(removed);
      expect(diff.kind).toBe(
        before === null ? "create" : after === null ? "delete" : "edit",
      );
    });
  }
  test("statistics and empty file labels", () => {
    expect(fileDiffStats(buildFileDiff("x", "a", "b"))).toBe(
      "Added 1 line, removed 1 line",
    );
    expect(fileDiffStats(buildFileDiff("x", null, "a\nb\n"))).toBe(
      "Added 2 lines",
    );
    expect(fileDiffStats(buildFileDiff("x", "a", ""))).toBe("Removed 1 line");
    expect(fileDiffStats(buildFileDiff("x", null, ""))).toBe(
      "Created empty file",
    );
    expect(fileDiffStats(buildFileDiff("x", "a", "a"))).toBe("No changes");
  });
  test("parses hunks and tracks independent old/new numbers", () => {
    const model = diffRenderModel(
      buildFileDiff("x", "a\nb\nc\n", "a\nx\ny\nc\n"),
    );
    expect(model.lines.map(({ id: _, ...line }) => line)).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,4 @@" },
      { kind: "context", text: "a", oldLine: 1, newLine: 1 },
      { kind: "remove", text: "b", oldLine: 2 },
      { kind: "add", text: "x", newLine: 2 },
      { kind: "add", text: "y", newLine: 3 },
      { kind: "context", text: "c", oldLine: 3, newLine: 4 },
    ]);
    const removed = model.lines[2];
    const added = model.lines[3];
    if (!removed || !added) throw new Error("Missing diff rows");
    expect(diffLinePrefix(removed, 2)).toBe(" 2    - ");
    expect(diffLinePrefix(added, 2)).toBe("    2 + ");
  });
  test("multiple hunks reset numbers and missing-newline notes do not consume them", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join(
      "\n",
    );
    const diff = buildFileDiff(
      "x",
      before,
      before.replace("line2\n", "new2\n").replace("line30", "new30"),
    );
    const model = diffRenderModel(diff);
    expect(model.lines.filter((line) => line.kind === "hunk")).toHaveLength(2);
    expect(model.lines.find((line) => line.text === "new30")?.newLine).toBe(30);
    expect(
      model.lines
        .filter((line) => line.kind === "note")
        .every((line) => !line.oldLine && !line.newLine),
    ).toBe(true);
  });
  test("bounds rendered rows and long text without losing original patch", () => {
    const diff = buildFileDiff(
      "x",
      null,
      `${Array.from({ length: 400 }, (_, i) => `line${i}`).join("\n")}\n`,
    );
    const patch = diff.patch;
    const model = diffRenderModel(diff);
    expect(model.lines).toHaveLength(MAX_DIFF_LINES);
    expect(model.hiddenLines).toBe(201);
    expect(diff.patch).toBe(patch);
    expect(diffRenderModel(diff)).toBe(model);
    const long = diffRenderModel(
      buildFileDiff("x", null, `${"x".repeat(100_000)}\n`),
    );
    expect(long.shortenedLines).toBe(1);
    expect(long.lines[1]?.text.length).toBe(MAX_DIFF_LINE_CHARS);
  });
  test("content control sequences cannot become terminal commands", () => {
    const model = diffRenderModel(
      buildFileDiff("x", null, "\u001b[31mred\u001b[0m\n"),
    );
    expect(model.lines[1]?.text).toBe("red");
  });
});
