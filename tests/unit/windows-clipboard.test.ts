import { expect, test } from "bun:test";
import { copiedCharactersNotice } from "../../src/ui/windows-clipboard.js";

test("copy notice uses Russian character counts", () => {
  expect(copiedCharactersNotice(1)).toBe("Скопировано 1 символ");
  expect(copiedCharactersNotice(2)).toBe("Скопировано 2 символа");
  expect(copiedCharactersNotice(11)).toBe("Скопировано 11 символов");
  expect(copiedCharactersNotice(21)).toBe("Скопировано 21 символ");
});
