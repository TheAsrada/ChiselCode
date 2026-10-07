import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { webResultSummary } from "../../src/ui/web-result.js";
import { AutoSearchBackend } from "../../src/web/auto-search.js";
import { testWebAccess } from "../../src/web/diagnostics.js";
import { WebToolProvider } from "../../src/web/provider.js";
import { startHostedSearchFixture } from "../fixtures/mcp-search.js";

async function environment() {
  const root = await mkdtemp(join(tmpdir(), "auto-search-"));
  const exa = await startHostedSearchFixture("exa");
  const parallel = await startHostedSearchFixture("parallel");
  exa.config.search.provider = "auto";
  const provider = new WebToolProvider(
    exa.config,
    exa.http,
    new AutoSearchBackend(
      [exa.backend, parallel.backend],
      exa.config.limits.requestTimeoutMs,
    ),
  );
  return {
    root,
    exa,
    parallel,
    provider,
    close: async () => {
      await exa.close();
      await parallel.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const approvalMode of ["default", "dontAsk"] as const)
  test(`default Auto search and fallback run in ${approvalMode} without grants or approval`, async () => {
    const env = await environment();
    env.exa.state.httpStatus = 429;
    try {
      const result = (
        await testWebAccess(
          env.provider,
          env.root,
          { query: "official documentation" },
          { approvalMode },
        )
      )[0]?.result;
      expect(result?.isError).not.toBe(true);
      expect(result?.requiresApproval).not.toBe(true);
      expect(result?.details?.web).toMatchObject({
        provider: "parallel",
        routing: { mode: "auto", attempted: ["exa", "parallel"] },
      });
      expect(env.parallel.argumentsReceived).toHaveLength(1);
    } finally {
      await env.close();
    }
  });

test("project search denies exclude an Auto service and deny the whole route when all services are blocked", async () => {
  for (const denyDomains of [
    ["mcp.exa.ai"],
    ["mcp.exa.ai", "search.parallel.ai"],
  ]) {
    const env = await environment();
    try {
      const result = (
        await testWebAccess(
          env.provider,
          env.root,
          { query: "official docs" },
          {
            allow: ["web_search"],
            approvalMode: "bypassPermissions",
            allowBypassPermissions: true,
            project: { ...DEFAULT_PROJECT_CONFIG, web: { denyDomains } },
          },
        )
      )[0]?.result;
      expect(env.exa.connections).toHaveLength(0);
      if (denyDomains.length === 1) {
        expect(result?.isError).not.toBe(true);
        expect(result?.details?.web).toMatchObject({ provider: "parallel" });
      } else {
        expect(result?.errorCode).toBe("WEB_NETWORK_DENIED");
        expect(env.parallel.connections).toHaveLength(0);
      }
    } finally {
      await env.close();
    }
  }
});

test("Auto uses a single successful service and does not multiply calls for an empty search", async () => {
  const env = await environment();
  try {
    env.exa.state.empty = true;
    const result = (
      await testWebAccess(
        env.provider,
        env.root,
        { query: "current docs" },
        { allow: ["web_search"] },
      )
    )[0]?.result;
    expect(result?.isError).not.toBe(true);
    expect(result?.details?.web).toMatchObject({
      provider: "exa",
      results: [],
      routing: { mode: "auto", attempted: ["exa"] },
    });
    expect(env.parallel.connections).toHaveLength(0);
  } finally {
    await env.close();
  }
});

test("one Auto approval previews both fixed services and falls back from Exa quota to real Parallel MCP", async () => {
  const env = await environment();
  env.exa.config.permissions.search = "ask";
  env.exa.state.httpStatus = 429;
  const previews: string[] = [];
  try {
    const result = (
      await testWebAccess(
        env.provider,
        env.root,
        { query: "current docs" },
        {
          resolver: {
            requestApproval: async (request) => {
              previews.push(request.preview);
              return "approved";
            },
          },
          artifactDirectory: join(env.root, "artifacts"),
        },
      )
    )[0]?.result;
    expect(previews).toHaveLength(1);
    expect(previews[0]).toContain("mcp.exa.ai");
    expect(previews[0]).toContain("search.parallel.ai");
    expect(result?.isError).not.toBe(true);
    expect(result?.details?.web).toMatchObject({
      provider: "parallel",
      usage: { requests: 2 },
      routing: { mode: "auto", attempted: ["exa", "parallel"] },
    });
    expect(env.parallel.argumentsReceived).toHaveLength(1);
    expect(
      result?.references?.every(
        (reference) => reference.kind === "search_result",
      ),
    ).toBe(true);
    expect(webResultSummary(result ?? { output: "" })).toContain(
      "Parallel · Авто",
    );
    expect(JSON.stringify(result)).not.toContain("private-error-secret");
  } finally {
    await env.close();
  }
});

test("Auto skips a policy-denied primary without executing it, including in Bypass", async () => {
  const env = await environment();
  env.exa.config.permissions.denyDomains.push("mcp.exa.ai");
  try {
    const result = (
      await testWebAccess(
        env.provider,
        env.root,
        { query: "docs" },
        {
          approvalMode: "bypassPermissions",
          allowBypassPermissions: true,
          artifactDirectory: join(env.root, "artifacts"),
        },
      )
    )[0]?.result;
    expect(result?.isError).not.toBe(true);
    expect(result?.details?.web).toMatchObject({
      provider: "parallel",
      routing: { attempted: ["parallel"] },
    });
    expect(env.exa.connections).toHaveLength(0);
    expect(env.parallel.argumentsReceived).toHaveLength(1);
  } finally {
    await env.close();
  }
});
test("malformed provider results are discarded and Auto can obtain valid evidence from another approved service", async () => {
  const env = await environment();
  env.exa.state.malformed = true;
  try {
    const result = (
      await testWebAccess(
        env.provider,
        env.root,
        { query: "current docs" },
        {
          allow: ["web_search"],
          artifactDirectory: join(env.root, "artifacts"),
        },
      )
    )[0]?.result;
    expect(result?.isError).not.toBe(true);
    expect(result?.details?.web).toMatchObject({
      provider: "parallel",
      routing: { attempted: ["exa", "parallel"] },
    });
    expect(result?.output).not.toContain("not valid JSON");
    expect(
      result?.references?.every((source) => source.kind === "search_result"),
    ).toBe(true);
  } finally {
    await env.close();
  }
});

test("a denied fallback cannot be contacted after a service failure; Dont Ask rejects explicit Ask", async () => {
  const env = await environment();
  env.exa.config.permissions.search = "ask";
  try {
    const denied = (
      await testWebAccess(
        env.provider,
        env.root,
        { query: "docs" },
        { approvalMode: "dontAsk" },
      )
    )[0]?.result;
    expect(denied?.errorCode).toBe("WEB_NETWORK_DENIED");
    expect(env.exa.connections).toHaveLength(0);
    expect(env.parallel.connections).toHaveLength(0);
    env.exa.state.httpStatus = 503;
    env.exa.config.permissions.denyDomains.push("search.parallel.ai");
    const unavailable = (
      await testWebAccess(
        env.provider,
        env.root,
        { query: "docs" },
        { allow: ["web_search"] },
      )
    )[0]?.result;
    expect(unavailable?.errorCode).toBe("WEB_HTTP_ERROR");
    expect(env.parallel.connections).toHaveLength(0);
  } finally {
    await env.close();
  }
});
