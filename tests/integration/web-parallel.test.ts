import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testWebAccess } from "../../src/web/diagnostics.js";
import {
  createWebToolProvider,
  WebToolProvider,
} from "../../src/web/provider.js";
import { SearchInputSchema, WebConfigSchema } from "../../src/web/schema.js";
import { effectiveSearchBackend } from "../../src/web/search.js";
import { startHostedSearchFixture } from "../fixtures/mcp-search.js";

const authorization = {
  assertDestination(host: string) {
    expect(host).toBe("search.parallel.ai");
  },
};
const input = SearchInputSchema.parse({
  query: "Fixture API migration",
  domains: ["fixture.docs.example"],
  excludeDomains: ["excluded.example"],
  limit: 2,
});

test("explicit Parallel is keyless even with a saved Brave credential; Auto stays deterministic", async () => {
  const config = WebConfigSchema.parse({ search: { provider: "parallel" } });
  expect(effectiveSearchBackend(config, false)).toBe("parallel");
  expect(effectiveSearchBackend(config, true)).toBe("parallel");
  expect(effectiveSearchBackend(WebConfigSchema.parse({}), false)).toBe("exa");
  expect(effectiveSearchBackend(WebConfigSchema.parse({}), true)).toBe("brave");
  const provider = await createWebToolProvider(config);
  const handler = await provider.getHandler("web_search");
  const plan = await handler.prepare(
    {} as Parameters<typeof handler.prepare>[0],
    input,
  );
  expect(plan.network).toMatchObject({
    hostname: "search.parallel.ai",
    provider: "parallel",
  });
  expect(handler.spec.effect).toBe("external_read");
  expect(handler.spec.permission).toBe("network");
  expect((await provider.listTools()).map((spec) => spec.name)).toEqual([
    "web_search",
    "web_fetch",
  ]);
});

for (const structured of [true, false])
  test(`Parallel negotiates MCP and normalizes ${structured ? "structured" : "text JSON"} results without protocol/identity leakage`, async () => {
    const fixture = await startHostedSearchFixture("parallel");
    fixture.state.structured = structured;
    fixture.state.long = true;
    try {
      const result = await fixture.backend.search(input, { authorization });
      expect(result.provider).toBe("parallel");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        url: "https://fixture.docs.example/article",
        domain: "fixture.docs.example",
      });
      expect(result.results[0]?.snippet).toContain("fetchFresh");
      expect(result.results[0]?.snippet.length).toBeLessThanOrEqual(600);
      expect(fixture.argumentsReceived).toEqual([
        {
          objective: input.query,
          search_queries: [
            "Fixture API migration (site:fixture.docs.example) -site:excluded.example",
          ],
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("server-trace");
      expect(JSON.stringify(result)).not.toContain("server-session");
      expect(
        fixture.connections.every((host) => host === "search.parallel.ai"),
      ).toBe(true);
      expect(
        fixture.headers.every(
          (headers) =>
            !headers.authorization &&
            !headers["x-api-key"] &&
            !headers["x-subscription-token"],
        ),
      ).toBe(true);
      // Filters and limit are enforced locally even if the server ignores operators.
      expect(
        (
          await fixture.backend.search(
            SearchInputSchema.parse({ query: "docs", limit: 1 }),
            { authorization },
          )
        ).results,
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

test("empty Parallel searches and nullable excerpts remain valid, while malformed evidence is rejected", async () => {
  const fixture = await startHostedSearchFixture("parallel");
  try {
    fixture.state.empty = true;
    expect(
      (await fixture.backend.search(input, { authorization })).results,
    ).toEqual([]);
    fixture.state.empty = false;
    fixture.state.nullable = true;
    expect(
      (await fixture.backend.search(input, { authorization })).results[0]
        ?.snippet,
    ).toBe("");
    fixture.state.malformed = true;
    await expect(
      fixture.backend.search(input, { authorization }),
    ).rejects.toMatchObject({ code: "WEB_PROTOCOL_ERROR" });
    fixture.state.structured = false;
    await expect(
      fixture.backend.search(input, { authorization }),
    ).rejects.toMatchObject({ code: "WEB_PROTOCOL_ERROR" });
  } finally {
    await fixture.close();
  }
});

for (const status of [401, 429, 503])
  test(`Parallel HTTP ${status} stays a controlled failure without hidden fallback or private payload`, async () => {
    const fixture = await startHostedSearchFixture("parallel");
    fixture.state.httpStatus = status;
    try {
      let error: unknown;
      try {
        await fixture.backend.search(input, { authorization });
      } catch (cause) {
        error = cause;
      }
      expect(error).toMatchObject({
        code: status === 429 ? "WEB_RATE_LIMITED" : "WEB_HTTP_ERROR",
        details: { provider: "parallel", status, retryable: status !== 401 },
      });
      expect(String(error)).not.toContain("private-error-secret-do-not-show");
      expect(
        fixture.connections.every((host) => host === "search.parallel.ai"),
      ).toBe(true);
      expect(fixture.argumentsReceived).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

test("remote quota/tool errors and missing search capability cannot become successful references", async () => {
  const fixture = await startHostedSearchFixture("parallel");
  try {
    for (const [message, code] of [
      ["quota exceeded secret", "WEB_RATE_LIMITED"],
      ["internal private details", "WEB_SEARCH_FAILED"],
    ]) {
      fixture.state.toolError = message ?? "";
      await expect(
        fixture.backend.search(input, { authorization }),
      ).rejects.toMatchObject({ code });
    }
    fixture.state.toolError = "";
    fixture.state.missingTool = true;
    await expect(
      fixture.backend.search(input, { authorization }),
    ).rejects.toMatchObject({ code: "WEB_PROTOCOL_ERROR" });
  } finally {
    await fixture.close();
  }
});

test("hosted search refuses endpoint redirects, including a redirect to a private destination", async () => {
  const fixture = await startHostedSearchFixture("parallel");
  fixture.state.redirect = "http://127.0.0.1/metadata";
  try {
    await expect(
      fixture.backend.search(input, { authorization }),
    ).rejects.toMatchObject({ code: "WEB_REDIRECT_LIMIT" });
    expect(fixture.argumentsReceived).toHaveLength(0);
    expect(
      fixture.connections.every((host) => host === "search.parallel.ai"),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("cancellation and total deadline terminate hosted requests without poisoning later searches", async () => {
  const fixture = await startHostedSearchFixture("parallel");
  fixture.state.delay = 2000;
  try {
    const abort = new AbortController();
    const running = fixture.backend.search(input, {
      authorization,
      signal: abort.signal,
    });
    for (let n = 0; n < 100 && !fixture.argumentsReceived.length; n++)
      await Bun.sleep(10);
    expect(fixture.argumentsReceived).toHaveLength(1);
    abort.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    fixture.http.limits.requestTimeoutMs = 400;
    await expect(
      fixture.backend.search(input, { authorization }),
    ).rejects.toMatchObject({ code: "WEB_TIMEOUT" });
    fixture.state.delay = 0;
    fixture.http.limits.requestTimeoutMs = 30000;
    expect(
      (await fixture.backend.search(input, { authorization })).results,
    ).toHaveLength(1);
  } finally {
    await fixture.close();
  }
}, 10000);

test("Parallel flows through Plan permissions, Dont Ask and deliberate Bypass without weakening destination policy", async () => {
  const fixture = await startHostedSearchFixture("parallel");
  const root = await mkdtemp(join(tmpdir(), "parallel-runtime-"));
  const provider = new WebToolProvider(
    fixture.config,
    fixture.http,
    fixture.backend,
  );
  try {
    const pending = await testWebAccess(provider, root, { query: input.query });
    expect(pending[0]?.result.requiresApproval).toBe(true);
    expect(pending[0]?.result.preview).toContain("parallel");
    expect(fixture.connections).toHaveLength(0);
    const denied = await testWebAccess(
      provider,
      root,
      { query: input.query },
      { approvalMode: "dontAsk" },
    );
    expect(denied[0]?.result.errorCode).toBe("WEB_NETWORK_DENIED");
    expect(fixture.connections).toHaveLength(0);
    const options = {
      approvalMode: "bypassPermissions" as const,
      allowBypassPermissions: true,
      artifactDirectory: join(root, "artifacts"),
    };
    const allowed = await testWebAccess(
      provider,
      root,
      { query: input.query },
      options,
    );
    expect(allowed[0]?.result.isError).not.toBe(true);
    expect(allowed[0]?.result.contentTrust).toBe("untrusted_external");
    expect(
      allowed[0]?.result.references?.every(
        (reference) => reference.kind === "search_result",
      ),
    ).toBe(true);
    expect(JSON.stringify(allowed)).not.toContain("server-session");
    expect(JSON.stringify(allowed)).not.toContain("server-trace");
    const unsafe = await testWebAccess(
      provider,
      root,
      { url: "http://127.0.0.1/metadata" },
      options,
    );
    expect(unsafe[0]?.result.errorCode).toBe("WEB_UNSAFE_ADDRESS");
    const calls = fixture.argumentsReceived.length;
    fixture.config.permissions.search = "deny";
    const policyDenied = await testWebAccess(
      provider,
      root,
      { query: input.query },
      options,
    );
    expect(policyDenied[0]?.result.errorCode).toBe("WEB_NETWORK_DENIED");
    expect(fixture.argumentsReceived).toHaveLength(calls);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
