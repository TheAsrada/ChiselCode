import { expect, test } from "bun:test";
import { resolveCredential } from "../../src/providers/auth.js";
import { openai } from "../../src/providers/definitions/openai.js";
import { normalizeEndpoint } from "../../src/providers/endpoint.js";
import { normalizeProviderError } from "../../src/providers/errors.js";
import {
  checkAdapterHealth,
  resolveProviderRuntime,
} from "../../src/providers/runtime.js";

test("credential priority never reads store when transient or env key exists", async () => {
  let calls = 0;
  const store = {
    async get() {
      calls++;
      return "stored";
    },
  };
  const profile = { providerId: "openai", apiKeyRef: "old-ref" };
  expect(
    await resolveCredential(openai, profile, store, "typed", {
      OPENAI_API_KEY: "env",
    }),
  ).toBe("typed");
  expect(
    await resolveCredential(openai, profile, store, undefined, {
      OPENAI_API_KEY: "env",
    }),
  ).toBe("env");
  expect(calls).toBe(0);
  expect(await resolveCredential(openai, profile, store, undefined, {})).toBe(
    "stored",
  );
  expect(calls).toBe(1);
});
test("resolver creates AgentRouter using generic OpenAI protocol and blocks missing providers", async () => {
  const r = await resolveProviderRuntime({
    profile: { providerId: "agentrouter" },
    apiKey: "test",
    environment: {},
  });
  expect(r.definition.driverId).toBe("openai-chat");
  expect(r.adapter.providerId).toBe("agentrouter");
  expect(r.adapter.constructor.name).toBe("OpenAIProtocolAdapter");
  await expect(
    resolveProviderRuntime({
      profile: { providerId: "vendor/removed" },
      environment: {},
    }),
  ).rejects.toThrow("unavailable");
});
test("endpoint policies and typed errors", () => {
  expect(normalizeEndpoint("openai-v1", "http://localhost:1234/")).toBe(
    "http://localhost:1234/v1",
  );
  expect(normalizeEndpoint("openai-v1", "https://test.example/api/")).toBe(
    "https://test.example/api",
  );
  expect(normalizeEndpoint("anthropic-root", "https://test.example/v1/")).toBe(
    "https://test.example",
  );
  expect(() =>
    normalizeEndpoint("none", "https://secret:password@test.example"),
  ).toThrow("without credentials");
  const e = normalizeProviderError({ status: 429, message: "rate limit" });
  expect(e.code).toBe("rate_limit");
  expect(e.retryable).toBe(true);
  expect(e.status).toBe(429);
});
test("optional health methods: unsupported is not a failure; explicit check has precedence", async () => {
  const adapter = { kind: "example", async *streamChat() {} };
  expect((await checkAdapterHealth(adapter)).status).toBe("unsupported");
  let listed = false;
  expect(
    (
      await checkAdapterHealth({
        ...adapter,
        async checkConnection() {
          return { status: "healthy" as const, message: "ready" };
        },
        async listModels() {
          listed = true;
          return [];
        },
      })
    ).status,
  ).toBe("healthy");
  expect(listed).toBe(false);
});
