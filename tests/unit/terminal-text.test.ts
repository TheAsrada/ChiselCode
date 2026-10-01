import { expect, test } from "bun:test";
import stringWidth from "string-width";
import { cleanSettingsInput } from "../../src/ui/opentui-settings-input.js";
import {
  clipText,
  terminalLine,
  terminalSafeText,
} from "../../src/ui/terminal-text.js";
import { truncate } from "../../src/ui/theme.js";
import { textTail } from "../../src/utils/text.js";

const corpus = [
  "Кириллица и ASCII",
  "a😀b",
  "👩‍💻 разработчик",
  "🇷🇺 проект",
  "e\u0301cole",
  "汉字 model",
  "1️⃣ задача",
];
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

test("every clipping boundary preserves whole Unicode graphemes", () => {
  for (const value of corpus) {
    const boundaries = new Set([
      0,
      ...Array.from(
        segmenter.segment(value),
        ({ index, segment }) => index + segment.length,
      ),
    ]);
    for (let limit = 0; limit <= value.length + 1; limit++) {
      for (const result of [
        clipText(value, limit),
        terminalSafeText(value, limit),
      ]) {
        expect(result).not.toMatch(/\p{Cs}/u);
        expect(result.length).toBeLessThanOrEqual(limit);
        expect(boundaries.has(result.length)).toBe(true);
        expect(value.startsWith(result)).toBe(true);
      }
      const shortened = truncate(value, limit);
      expect(shortened).not.toMatch(/\p{Cs}/u);
      expect(shortened.length).toBeLessThanOrEqual(limit);
      const tail = textTail(value, limit);
      expect(tail).not.toMatch(/\p{Cs}/u);
      expect(tail.length).toBeLessThanOrEqual(limit);
      expect(value.endsWith(tail)).toBe(true);
      expect(boundaries.has(value.length - tail.length)).toBe(true);
    }
  }
});

test("UI lines fit cells without cutting wide, combining, flag or ZWJ characters", () => {
  for (const value of corpus) {
    const prefixes = new Set([
      "",
      ...Array.from(segmenter.segment(value), ({ index, segment }) =>
        value.slice(0, index + segment.length),
      ),
    ]);
    for (let limit = 0; limit <= stringWidth(value) + 1; limit++) {
      const result = terminalLine(value, limit);
      expect(result).not.toMatch(/\p{Cs}/u);
      expect(stringWidth(result)).toBeLessThanOrEqual(limit);
      expect(
        prefixes.has(
          result.endsWith("...")
            ? result.slice(0, -3)
            : /^\.{1,2}$/.test(result)
              ? ""
              : result,
        ),
      ).toBe(true);
    }
  }
  expect(terminalLine("👩‍💻xyz-long", 5)).toBe("👩‍💻...");
  expect(terminalLine("e\u0301cole", 4)).toBe("e\u0301...");
  expect(terminalLine("汉字abc", 5)).toBe("汉...");
  expect(terminalLine("a\n\tb", 4)).toBe("a  b");
});

test("sanitizing precedes clipping so truncated escape sequences cannot leave artifacts", () => {
  expect(terminalSafeText("abc\u001b[31mred\u001b[0m", 6)).toBe("abcred");
  expect(terminalSafeText("a\u001b]0;window title\u0007b", 2)).toBe("ab");
  expect(
    terminalSafeText(
      "a\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\b",
    ),
  ).toBe("alinkb");
  expect(terminalSafeText("a\u009d0;window title\u009cb")).toBe("ab");
  expect(terminalSafeText("a\u001b]0;incomplete title")).toBe("a");
  expect(terminalSafeText("x\u0085y\u009bz")).toBe("x y z");
  expect(terminalSafeText("x\r\n", 2)).toBe("x\n");
});

test("malformed UTF-16 is display-safe while original and valid Unicode remain intact", () => {
  const original = "a\ud83db\udc00c😀";
  expect(terminalSafeText(original)).toBe("a?b?c😀");
  expect(original).toBe("a\ud83db\udc00c😀");
  expect(terminalSafeText("😀 汉字 e\u0301 👩‍💻")).toBe("😀 汉字 e\u0301 👩‍💻");
  expect(cleanSettingsInput(original)).toBe("abc😀");
  const long = `${"x".repeat(4095)}👩‍💻`;
  expect(cleanSettingsInput(long)).toBe("x".repeat(4095));
});
