import { expect, test } from "bun:test";
import stringWidth from "string-width";
import { buildFileDiff } from "../../src/tools/file-diff.js";
import { THEMES } from "../../src/ui/appearance.js";
import {
  diffColors,
  diffPathLabel,
  diffPreview,
  diffPreviewText,
  emptyDiffMessage,
  hiddenDiffChanges,
} from "../../src/ui/file-diff-preview.js";

test("large replacements preview both sides, with accurate coordinates and omitted counts", () => {
  const before = Array.from({ length: 500 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 500 }, (_, i) => `new ${i}`).join("\n");
  const diff = buildFileDiff("test.txt", before, after);
  const preview = diffPreview(diff);
  expect(
    preview.lines
      .filter((line) => line.kind === "remove")
      .map((line) => line.oldLine),
  ).toEqual([1, 2, 3]);
  expect(
    preview.lines
      .filter((line) => line.kind === "add")
      .map((line) => line.newLine),
  ).toEqual([1, 2, 3]);
  expect(preview.lines.some((line) => line.text === "...")).toBe(true);
  expect(preview.hiddenChanges).toBe(994);
  expect(diffPreview(diff)).toBe(preview);
  expect(diff.patch).toContain("+new 499");
});

test("small edits retain context and hunk coordinates across distant hunks", () => {
  const before = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const diff = buildFileDiff(
    "test.txt",
    before,
    before
      .replace("line 51\n", "updated 51\nextra\n")
      .replace("line 149\n", "updated 149\n"),
  );
  const preview = diffPreview(diff);
  expect(preview.hiddenChanges).toBe(0);
  expect(preview.lines.filter((line) => line.kind === "hunk")).toHaveLength(2);
  expect(
    preview.lines.find((line) => line.text === "updated 149")?.newLine,
  ).toBe(150);
  expect(preview.lines.find((line) => line.text === "line 50")?.oldLine).toBe(
    50,
  );
  expect(preview.lines.find((line) => line.text === "line 52")?.newLine).toBe(
    53,
  );
  expect(preview.digits).toBe(3);
});

test("unbalanced, new and deleted files use the whole six-line preview budget", () => {
  for (const diff of [
    buildFileDiff("x", null, "1\n2\n3\n4\n5\n6\n7\n"),
    buildFileDiff("x", "1\n2\n3\n4\n5\n6\n7\n", null),
    buildFileDiff("x", "old\n", "1\n2\n3\n4\n5\n6\n7\n"),
  ]) {
    const preview = diffPreview(diff);
    expect(
      preview.lines.filter(
        (line) => line.kind === "add" || line.kind === "remove",
      ),
    ).toHaveLength(6);
    expect(preview.hiddenChanges).toBe(diff.additions + diff.deletions - 6);
  }
  expect(emptyDiffMessage(buildFileDiff("x", null, ""))).toBe(
    "Создан пустой файл",
  );
  expect(emptyDiffMessage(buildFileDiff("x", "", null))).toBe(
    "Удалён пустой файл",
  );
  expect(emptyDiffMessage(buildFileDiff("x", "same", "same"))).toBe(
    "Без изменений",
  );
});

test("terminal-safe previews clip by cells, retain filenames and preserve the complete source", () => {
  const diff = buildFileDiff(
    "C:\\deep\\directory\\проверка.ts",
    null,
    `\u001b]0;bad title\u0007\t${"界".repeat(600)}\u001b[31m\n`,
  );
  const source = diff.patch;
  const preview = diffPreview(diff);
  expect(preview.lines.find((line) => line.kind === "add")?.text).toStartWith(
    "  界",
  );
  for (const width of [16, 40, 80]) {
    const rows = diffPreviewText(diff, width);
    expect(rows.every((line) => stringWidth(line) <= width)).toBe(true);
    expect(rows.join("\n")).not.toContain("bad title");
    expect(rows.join("\n")).not.toContain("\u001b");
  }
  expect(diffPathLabel(diff.path, 20)).toBe(".../проверка.ts");
  expect(diff.patch).toBe(source);
});

test("diff colors follow all four themes rather than fixed dark backgrounds", () => {
  for (const palette of Object.values(THEMES)) {
    const colors = diffColors(palette);
    expect(colors.fg).toBe(palette.text);
    expect(colors.contextBg).toBe(palette.surface);
    expect(colors.addedBg).not.toBe(colors.removedBg);
    expect(colors.addedSignColor).toBe(palette.green);
    expect(colors.removedSignColor).toBe(palette.red);
  }
  const colors = diffColors(THEMES.paper);
  expect(Number.parseInt(colors.addedBg.slice(1, 3), 16)).toBeGreaterThan(180);
  expect(Number.parseInt(colors.removedBg.slice(1, 3), 16)).toBeGreaterThan(
    180,
  );
});

test("missing-newline metadata does not add fake omitted source rows", () => {
  const preview = diffPreview(buildFileDiff("x.txt", "old", "new"));
  expect(preview.hiddenChanges).toBe(0);
  expect(preview.lines.filter((line) => line.kind === "note")).toHaveLength(0);
  expect(hiddenDiffChanges(1)).toBe("ещё 1 изменение");
  expect(hiddenDiffChanges(2)).toBe("ещё 2 изменения");
  expect(hiddenDiffChanges(11)).toBe("ещё 11 изменений");
  expect(hiddenDiffChanges(21)).toBe("ещё 21 изменение");
});
