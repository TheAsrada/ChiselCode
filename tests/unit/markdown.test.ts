import { describe, expect, test } from "bun:test";
import {
  estimateMarkdownRows,
  parseBlocks,
  parseInline,
  wrapTextRows,
} from "../../src/ui/markdown.js";

describe("parseInline", () => {
  test("leaves plain text untouched", () => {
    expect(parseInline("просто текст")).toEqual([{ text: "просто текст" }]);
    expect(parseInline("")).toEqual([{ text: "" }]);
  });

  test("parses bold, italic, code, strike and links", () => {
    expect(parseInline("**жирно**")).toEqual([{ text: "жирно", bold: true }]);
    expect(parseInline("*курсив*")).toEqual([{ text: "курсив", italic: true }]);
    expect(parseInline("`код`")).toEqual([{ text: "код", code: true }]);
    expect(parseInline("~~зачёркнуто~~")).toEqual([
      { text: "зачёркнуто", strike: true },
    ]);
    expect(parseInline("[док](https://example.com/x)")).toEqual([
      { text: "док", link: "https://example.com/x" },
    ]);
  });

  test("mixes styled and plain segments in order", () => {
    expect(parseInline("a **b** c `d`")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " c " },
      { text: "d", code: true },
    ]);
  });

  test("keeps unclosed markers literal", () => {
    expect(parseInline("**не закрыто")).toEqual([{ text: "**не закрыто" }]);
    expect(parseInline("путь C:\\*.*")).toEqual([{ text: "путь C:\\*.*" }]);
  });
});

describe("parseBlocks", () => {
  test("detects headings, lists, quotes and rules", () => {
    const blocks = parseBlocks(
      "# Заголовок\n\n- раз\n- два\n\n> цитата\n\n---",
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Заголовок" },
      { kind: "list", ordered: false, items: ["раз", "два"] },
      { kind: "quote", text: "цитата" },
      { kind: "hr" },
    ]);
  });

  test("parses fenced code with language, even unclosed", () => {
    expect(parseBlocks("```ts\nconst x = 1;\n```")).toEqual([
      { kind: "code", language: "ts", code: "const x = 1;" },
    ]);
    expect(parseBlocks("```\nopen fence")).toEqual([
      { kind: "code", language: "", code: "open fence" },
    ]);
  });

  test("keeps single line breaks inside a paragraph", () => {
    expect(parseBlocks("Сервис: X\nМодель: Y")).toEqual([
      { kind: "paragraph", text: "Сервис: X\nМодель: Y" },
    ]);
  });

  test("numbers ordered lists from one", () => {
    expect(parseBlocks("3. третий\n4. четвёртый")).toEqual([
      { kind: "list", ordered: true, items: ["третий", "четвёртый"] },
    ]);
  });
});

describe("estimateMarkdownRows", () => {
  test("wraps by visible cells", () => {
    expect(wrapTextRows("hello", 20)).toBe(1);
    expect(wrapTextRows("x".repeat(45), 20)).toBe(3);
    expect(wrapTextRows("", 20)).toBe(1);
  });

  test("counts blocks like the renderer", () => {
    // Абзац с переносом — по сегментам, маркеры в длину не входят.
    expect(estimateMarkdownRows("a\nb", 20)).toBe(2);
    expect(estimateMarkdownRows(`**${"x".repeat(19)}**`, 20)).toBe(1);
    expect(estimateMarkdownRows("# Заголовок", 20)).toBe(1);
    expect(estimateMarkdownRows("- раз\n- два", 20)).toBe(2);
    expect(estimateMarkdownRows("> цитата", 20)).toBe(1);
    expect(estimateMarkdownRows("---", 20)).toBe(1);
    // Код: рамка 2 + отступы 2 + язык 1 + строки.
    expect(estimateMarkdownRows("```ts\nconst x = 1;\n```", 40)).toBe(6);
    expect(estimateMarkdownRows("```\nopen fence", 40)).toBe(5);
  });
});
