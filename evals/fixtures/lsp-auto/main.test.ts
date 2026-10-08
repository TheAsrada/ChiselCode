import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { value } from "./main";
test("public value and declared result agree", () => {
  expect(value).toBe("world");
  expect(readFileSync(new URL("./main.ts", import.meta.url), "utf8")).toContain("value: string");
});
