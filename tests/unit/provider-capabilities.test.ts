import { expect, test } from "bun:test";
import { observedInputTokens } from "../../src/core/context-usage.js";
import { openai } from "../../src/providers/definitions/openai.js";
import { normalizeAnthropicUsage } from "../../src/providers/drivers/anthropic-messages.js";
import { createDriverRegistry } from "../../src/providers/drivers/index.js";
import {
  OpenAIProtocolAdapter,
  openaiChatDriver,
} from "../../src/providers/drivers/openai-chat.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import {
  checkAdapterHealth,
  resolveProviderRuntime,
} from "../../src/providers/runtime.js";
import { estimateCost } from "../../src/sessions/store.js";

test("definition without model listing exposes optional methods and unsupported health", async () => {
  const drivers = createDriverRegistry();
  const registry = new ProviderRegistry(drivers);
  registry.register({
    ...openai,
    id: "local/no-auth",
    auth: { required: false, envVars: [] },
    capabilities: { ...openai.capabilities, modelListing: false },
  });
  const runtime = await resolveProviderRuntime({
    profile: { providerId: "local/no-auth" },
    registry,
    drivers,
    environment: {},
  });
  expect(runtime.adapter.listModels).toBeUndefined();
  expect(runtime.adapter.countTokens).toBeUndefined();
  expect((await checkAdapterHealth(runtime.adapter)).status).toBe(
    "unsupported",
  );
});
test("unknown prices lack USD and known prices are estimates, generic cache accounting supports custom providers", () => {
  expect(estimateCost("vendor/unknown", "unknown", 1000, 100)).toEqual({
    source: "unknown",
  });
  expect(estimateCost("anthropic", "unknown-model", 1000, 100)).toEqual({
    source: "unknown",
  });
  expect(estimateCost("anthropic", "claude-opus-5", 1000, 100)).toEqual({
    source: "estimated",
    usd: 0.0075,
  });
  expect(
    observedInputTokens(
      "example/anth",
      normalizeAnthropicUsage({
        input_tokens: 100,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
      }),
    ),
  ).toBe(1100);
});

test("OpenAI effort support is scoped to exact models and a declared or native endpoint", async () => {
  const native = new OpenAIProtocolAdapter({
    apiKey: "mock",
    baseUrl: "https://api.openai.com/v1",
    allowModelMetadata: false,
  });
  const gateway = new OpenAIProtocolAdapter({
    apiKey: "mock",
    baseUrl: "https://example.test/v1",
    allowModelMetadata: false,
  });
  expect((await native.getCapabilities("gpt-5")).reasoningEffort).toMatchObject(
    { levels: ["minimal", "low", "medium", "high"], defaultLevel: "medium" },
  );
  expect(
    (await native.getCapabilities("gpt-4o")).reasoningEffort?.reason,
  ).toContain("нет подтверждённых");
  expect(
    (await gateway.getCapabilities("gpt-5")).reasoningEffort?.reason,
  ).toContain("provider.json");
  expect(
    openaiChatDriver.validateDefinition?.({
      ...openai,
      driverOptions: {
        reasoningEffort: { example: { levels: ["low"], defaultLevel: "high" } },
      },
    })?.[0]?.code,
  ).toBe("invalid_driver_options");
});
