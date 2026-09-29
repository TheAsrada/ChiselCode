import { expect, test } from "bun:test";
import {
  contextProgress,
  observedContextSnapshot,
  observedInputTokens,
} from "../../src/core/context-usage.js";
import { normalizeOpenAIUsage } from "../../src/providers/openai.js";

test("OpenAI completion cache detail is reported without adding it twice", () => {
  const usage = normalizeOpenAIUsage({
    prompt_tokens: 1200,
    completion_tokens: 50,
    total_tokens: 1250,
    prompt_tokens_details: { cached_tokens: 900 },
  });
  expect(usage.cacheReadTokens).toBe(900);
  expect(observedInputTokens("openai", usage)).toBe(1200);
});

test("provider cache semantics count Anthropic cache once and OpenAI cache within prompt tokens", () => {
  const usage = {
    inputTokens: 100,
    outputTokens: 25,
    cacheReadTokens: 800,
    cacheCreationTokens: 200,
  };
  expect(observedInputTokens("anthropic", usage)).toBe(1100);
  expect(observedInputTokens("anthropic-compatible", usage)).toBe(1100);
  expect(observedInputTokens("openai", usage)).toBe(100);
  expect(observedInputTokens("openai-compatible", usage)).toBe(100);
  expect(observedInputTokens("agentrouter", usage)).toBe(100);
});

test("only a matching known model supplies a context percentage", () => {
  const usage = { inputTokens: 150, outputTokens: 5 };
  const unknown = observedContextSnapshot("openai", "model-a", usage, {
    id: "model-b",
    contextWindow: 100,
  });
  expect(unknown.contextWindow).toBeUndefined();
  expect(contextProgress(unknown).barPercent).toBeUndefined();
  const known = observedContextSnapshot("openai", "model-a", usage, {
    id: "model-a",
    contextWindow: 100,
  });
  expect(known.observedInputTokens).toBe(150);
  expect(contextProgress(known).barPercent).toBe(100);
  expect(contextProgress(known).label).toContain("150%");
  expect(contextProgress()).toEqual({ label: "—" });
});
