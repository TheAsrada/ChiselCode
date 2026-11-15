import { expect, test } from "bun:test";
import { normalize } from "./value.js";
test("normalizes strings and null", () => {
  expect(normalize(" hello ")).toBe("hello");
  expect(normalize(null)).toBe("");
});
