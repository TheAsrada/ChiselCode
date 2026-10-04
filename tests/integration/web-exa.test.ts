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
import { startExaFixture } from "../fixtures/exa-search.js";

const authorization = {
  assertDestination(host: string) {
    expect(host).toBe("mcp.exa.ai");
  },
};

test("default search works without a key; legacy explicit Brave and saved keys remain selectable", async () => {
  const config = WebConfigSchema.parse({});
  expect(config.search.provider).toBe("auto");
  expect(effectiveSearchBackend(config, false)).toBe("exa");
  expect(effectiveSearchBackend(config, true)).toBe("brave");
  expect(
    effectiveSearchBackend(
      WebConfigSchema.parse({ search: { provider: "exa" } }),
      true,
    ),
  ).toBe("exa");
  const provider = await createWebToolProvider(
    WebConfigSchema.parse({ search: { provider: "exa" } }),
  );
  const handler = await provider.getHandler("web_search");
  const prepared = await handler.prepare(
    {} as Parameters<typeof handler.prepare>[0],
    { query: "official docs", domains: [], excludeDomains: [], limit: 5 },
  );
  expect(prepared.preview).toContain("exa");
  expect(prepared.preview).not.toContain("API-ключ");
});

test("real MCP handshake/discovery/search uses compact normalized results, filters, and no credential/session/model metadata", async () => {
  const fixture = await startExaFixture();
  try {
    const result = await fixture.backend.search(
      SearchInputSchema.parse({
        query: "Fixture migration",
        domains: ["fixture.docs.example"],
        excludeDomains: ["excluded.example"],
        limit: 5,
      }),
      { authorization },
    );
    expect(result.provider).toBe("exa");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toBe("https://fixture.docs.example/article");
    expect(result.results[0]?.snippet).toContain("fetchFresh");
    expect(result.results[0]?.snippet.length).toBeLessThanOrEqual(600);
    expect(fixture.argumentsReceived[0]).toMatchObject({
      query: "Fixture migration",
      includeDomains: ["fixture.docs.example"],
      excludeDomains: ["excluded.example"],
      numResults: 5,
      textMaxCharacters: 600,
    });
    expect(fixture.argumentsReceived[0]).not.toHaveProperty("session_id");
    expect(fixture.argumentsReceived[0]).not.toHaveProperty("model_name");
    expect(fixture.connections.every((host) => host === "mcp.exa.ai")).toBe(
      true,
    );
    expect(
      fixture.headers.every(
        (headers) =>
          !headers.authorization &&
          !headers["x-api-key"] &&
          !headers["x-subscription-token"],
      ),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});

for (const status of [429, 403, 503])
  test(`anonymous search HTTP ${status} becomes a safe classified failure`, async () => {
    const fixture = await startExaFixture();
    fixture.state.httpStatus = status;
    try {
      await expect(
        fixture.backend.search(SearchInputSchema.parse({ query: "docs" }), {
          authorization,
        }),
      ).rejects.toMatchObject({
        code: status === 429 ? "WEB_RATE_LIMITED" : "WEB_HTTP_ERROR",
        details: { status },
      });
      try {
        await fixture.backend.search(
          SearchInputSchema.parse({ query: "docs" }),
          { authorization },
        );
      } catch (error) {
        expect(String(error)).not.toContain("private-error-secret-do-not-show");
      }
    } finally {
      await fixture.close();
    }
  });

test("malformed results and remote quota errors never become successful search evidence", async () => {
  const fixture = await startExaFixture();
  try {
    fixture.state.malformed = true;
    await expect(
      fixture.backend.search(SearchInputSchema.parse({ query: "docs" }), {
        authorization,
      }),
    ).rejects.toMatchObject({ code: "WEB_PROTOCOL_ERROR" });
    fixture.state.malformed = false;
    fixture.state.toolError = "429 rate limit private-error-secret-do-not-show";
    await expect(
      fixture.backend.search(SearchInputSchema.parse({ query: "docs" }), {
        authorization,
      }),
    ).rejects.toMatchObject({ code: "WEB_RATE_LIMITED" });
  } finally {
    await fixture.close();
  }
});

test("documented empty results and nullable optional Exa fields are valid without inventing source evidence", async () => {
  const fixture = await startExaFixture();
  const input = SearchInputSchema.parse({
    query: "docs",
    domains: ["fixture.docs.example"],
  });
  try {
    fixture.state.empty = true;
    expect(
      (await fixture.backend.search(input, { authorization })).results,
    ).toEqual([]);
    fixture.state.empty = false;
    fixture.state.nullable = true;
    expect(
      (await fixture.backend.search(input, { authorization })).results,
    ).toEqual([
      {
        title: "https://fixture.docs.example/article#code",
        url: "https://fixture.docs.example/article",
        domain: "fixture.docs.example",
        snippet: "",
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test("Ctrl+C aborts an in-flight anonymous search and later searches still work", async () => {
  const fixture = await startExaFixture();
  fixture.state.delay = 2000;
  try {
    const abort = new AbortController();
    const pending = fixture.backend.search(
      SearchInputSchema.parse({ query: "docs" }),
      { authorization, signal: abort.signal },
    );
    for (let n = 0; n < 100 && fixture.argumentsReceived.length === 0; n++)
      await Bun.sleep(10);
    expect(fixture.argumentsReceived).toHaveLength(1);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    fixture.state.delay = 0;
    expect(
      (
        await fixture.backend.search(
          SearchInputSchema.parse({ query: "docs" }),
          { authorization },
        )
      ).results.length,
    ).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
}, 10000);

test("anonymous search uses Plan permissions and normal runtime results, including untrusted source framing", async () => {
  const fixture = await startExaFixture();
  const root = await mkdtemp(join(tmpdir(), "exa-runtime-"));
  const provider = new WebToolProvider(
    fixture.config,
    fixture.http,
    fixture.backend,
  );
  try {
    const blocked = await testWebAccess(provider, root, { query: "docs" });
    expect(blocked[0]?.result.requiresApproval).toBe(true);
    expect(fixture.connections).toHaveLength(0);
    const allowed = await testWebAccess(
      provider,
      root,
      { query: "docs" },
      { allow: ["web_search"], artifactDirectory: join(root, "artifacts") },
    );
    expect(allowed[0]?.result.isError).not.toBe(true);
    expect(allowed[0]?.result.contentTrust).toBe("untrusted_external");
    expect(allowed[0]?.result.references?.[0]?.kind).toBe("search_result");
    expect(allowed[0]?.result.output).toContain("untrusted");
    const denied = await testWebAccess(
      provider,
      root,
      { query: "docs" },
      { approvalMode: "dontAsk" },
    );
    expect(denied[0]?.result.errorCode).toBe("WEB_NETWORK_DENIED");
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
