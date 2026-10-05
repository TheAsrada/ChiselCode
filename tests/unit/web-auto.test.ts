import { expect, test } from "bun:test";
import {
  RuntimeError,
  type RuntimeErrorCode,
} from "../../src/runtime/errors.js";
import { AutoSearchBackend } from "../../src/web/auto-search.js";
import { SearchInputSchema } from "../../src/web/schema.js";
import type { WebSearchBackend } from "../../src/web/search.js";

const input = SearchInputSchema.parse({ query: "official documentation" });
const authorization = {
  destinations: ["first.example", "second.example"],
  assertDestination() {},
};
function backends() {
  const calls: string[] = [];
  const first: WebSearchBackend = {
    id: "exa",
    hostname: "first.example",
    async search() {
      calls.push("exa");
      throw new RuntimeError("WEB_SEARCH_FAILED", "unavailable", {
        retryable: true,
      });
    },
  };
  const second: WebSearchBackend = {
    id: "parallel",
    hostname: "second.example",
    async search() {
      calls.push("parallel");
      return {
        provider: "parallel",
        searchedAt: new Date().toISOString(),
        results: [],
        usage: { requests: 1 },
      };
    },
  };
  return { first, second, calls };
}

for (const code of [
  "WEB_NETWORK_DENIED",
  "WEB_UNSAFE_ADDRESS",
  "WEB_NETWORK_CONFIGURATION",
  "WEB_REQUEST_LIMIT",
  "WEB_TOO_LARGE",
  "WEB_PROTOCOL_ERROR",
  "CANCELLED",
  "WEB_RATE_LIMITED",
] as RuntimeErrorCode[])
  test(`Auto never uses a different service to evade ${code}`, async () => {
    const fixture = backends();
    fixture.first.search = async () => {
      fixture.calls.push("exa");
      throw new RuntimeError(code, "blocked", { retryable: true });
    };
    await expect(
      new AutoSearchBackend([fixture.first, fixture.second], 1000).search(
        input,
        { authorization },
      ),
    ).rejects.toMatchObject({ code });
    expect(fixture.calls).toEqual(["exa"]);
  });

test("Auto uses its total deadline to bound both services and aborts a stalled first service before failover", async () => {
  const fixture = backends();
  let stopped = false;
  fixture.first.search = async (_input, options) => {
    fixture.calls.push("exa");
    return new Promise((_, reject) =>
      options.signal?.addEventListener(
        "abort",
        () => {
          stopped = true;
          reject(new RuntimeError("CANCELLED", "request stopped"));
        },
        { once: true },
      ),
    );
  };
  const result = await new AutoSearchBackend(
    [fixture.first, fixture.second],
    200,
  ).search(input, { authorization });
  expect(stopped).toBe(true);
  expect(result.routing?.attempted).toEqual(["exa", "parallel"]);
  expect(fixture.calls).toEqual(["exa", "parallel"]);
});

test("user cancellation and live policy revocation terminate Auto instead of triggering another service", async () => {
  const fixture = backends();
  const abort = new AbortController();
  fixture.first.search = async () => {
    fixture.calls.push("exa");
    abort.abort();
    throw new RuntimeError("WEB_SEARCH_FAILED", "failed", { retryable: true });
  };
  await expect(
    new AutoSearchBackend([fixture.first, fixture.second], 1000).search(input, {
      authorization,
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect(fixture.calls).toEqual(["exa"]);
  const live = backends();
  live.second.search = async () => {
    live.calls.push("parallel");
    throw new RuntimeError("WEB_NETWORK_DENIED", "permission revoked");
  };
  await expect(
    new AutoSearchBackend([live.first, live.second], 1000).search(input, {
      authorization,
    }),
  ).rejects.toMatchObject({ code: "WEB_NETWORK_DENIED" });
  expect(live.calls).toEqual(["exa", "parallel"]);
});
test("HTTP 403 cannot be worked around by contacting another service", async () => {
  const fixture = backends();
  fixture.first.search = async () => {
    fixture.calls.push("exa");
    throw new RuntimeError("WEB_HTTP_ERROR", "Forbidden", { status: 403 });
  };
  await expect(
    new AutoSearchBackend([fixture.first, fixture.second], 1000).search(input, {
      authorization,
    }),
  ).rejects.toMatchObject({ code: "WEB_HTTP_ERROR" });
  expect(fixture.calls).toEqual(["exa"]);
});
