import { expect, test } from "bun:test";
import { observedInputTokens } from "../../src/core/context-usage.js";
import { openai } from "../../src/providers/definitions/openai.js";
import { normalizeAnthropicUsage } from "../../src/providers/drivers/anthropic-messages.js";
import { createDriverRegistry } from "../../src/providers/drivers/index.js";
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
