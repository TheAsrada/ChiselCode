import { expect, test } from "bun:test";
import { retryAfterMs } from "../../src/network/retry.js";

test("Retry-After accepts seconds or HTTP dates without shortening the server deadline", () => {
  const now = Date.parse("2026-10-15T09:00:00Z");
  expect(retryAfterMs("120", now)).toBe(120000);
  expect(retryAfterMs("0", now)).toBe(0);
  expect(retryAfterMs("Thu, 15 Oct 2026 09:02:00 GMT", now)).toBe(120000);
  expect(retryAfterMs("Thu, 15 Oct 2026 08:00:00 GMT", now)).toBe(0);
  expect(retryAfterMs("invalid", now)).toBeUndefined();
});
