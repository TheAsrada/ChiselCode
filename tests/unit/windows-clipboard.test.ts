import { expect, test } from "bun:test";
import {
  copiedCharactersNotice,
  windowsConsoleInputMode,
} from "../../src/ui/windows-clipboard.js";

test("copy notice uses Russian character counts", () => {
  expect(copiedCharactersNotice(1)).toBe("Скопировано 1 символ");
  expect(copiedCharactersNotice(2)).toBe("Скопировано 2 символа");
  expect(copiedCharactersNotice(11)).toBe("Скопировано 11 символов");
  expect(copiedCharactersNotice(21)).toBe("Скопировано 21 символ");
});

test("native selection enables QuickEdit without mouse capture", () => {
  const normal = windowsConsoleInputMode(0x80, false);
  expect(normal & 0x40).toBe(0x40);
  expect(normal & 0x80).toBe(0x80);
  const captured = windowsConsoleInputMode(normal, true);
  expect(captured & 0x40).toBe(0);
  expect(captured & 0x10).toBe(0x10);
  expect(captured & 0x200).toBe(0x200);
  const alternate = windowsConsoleInputMode(0x80, false, true);
  expect(alternate & 0x40).toBe(0x40);
  expect(alternate & 0x200).toBe(0x200);
  expect(alternate & 0x10).toBe(0);
});
