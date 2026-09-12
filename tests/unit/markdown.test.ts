import { describe, expect, test } from "bun:test";
import { parseBlocks, parseInline } from "../../src/ui/markdown.js";

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
