import { expect, test } from "bun:test";
import * as app from "./index";
test("sum feature preserves double", () => { expect(app.double(3)).toBe(6); expect((app as any).sum([1, 2, 3])).toBe(6); expect((app as any).sum([])).toBe(0); });
