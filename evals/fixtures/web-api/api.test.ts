import { expect, test } from "bun:test";
import { functionName } from "./api";
test("migration matches fixture documentation", () => expect(functionName).toBe("fetchFresh"));
