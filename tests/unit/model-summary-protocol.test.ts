import { expect, test } from "bun:test";
import { modelSummarizer } from "../../src/context/model-summary.js";
import { emptySummary } from "../../src/context/summary.js";
import { AnthropicProtocolAdapter } from "../../src/providers/drivers/anthropic-messages.js";
import { OpenAIProtocolAdapter } from "../../src/providers/drivers/openai-chat.js";
import type { ProviderAdapter, TokenUsage } from "../../src/types/domain.js";

const summary = {
  ...emptySummary(),
  goal: "Fix the parser",
  userConstraints: ["Do not change the API"],
  nextAction: "Run the parser regression test",
};
function response(anthropic: boolean, reason: string) {
  const content = JSON.stringify(summary);
  const records = anthropic
    ? [
        {
          type: "message_start",
          message: {
            id: "summary",
            type: "message",
            role: "assistant",
            model: "custom",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              cache_read_input_tokens: 50,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        ...Array.from(
          { length: Math.ceil(content.length / 13) },
          (_, index) => ({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: content.slice(index * 13, index * 13 + 13),
            },
          }),
        ),
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: reason, stop_sequence: null },
          usage: { output_tokens: 40 },
        },
        { type: "message_stop" },
      ]
    : [
        ...Array.from(
          { length: Math.ceil(content.length / 13) },
          (_, index) => ({
            choices: [
              {
                index: 0,
                delta: { content: content.slice(index * 13, index * 13 + 13) },
                finish_reason: null,
              },
            ],
          }),
        ),
        { choices: [{ index: 0, delta: {}, finish_reason: reason }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 50 },
          },
        },
      ];
  return new Response(
    records
      .map(
        (record) =>
          `${anthropic ? `event: ${"type" in record ? record.type : ""}\n` : ""}data: ${JSON.stringify(record)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
for (const anthropic of [false, true]) {
  for (const truncated of [false, true]) {
    test(`${anthropic ? "Anthropic" : "OpenAI"} model summary handles real streamed JSON${truncated ? " with a truncation" : ""}`, async () => {
      let body: Record<string, unknown> = {};
      const reason = truncated
        ? anthropic
          ? "max_tokens"
          : "length"
        : anthropic
          ? "end_turn"
          : "stop";
      const fetchMock = async (url: RequestInfo | URL, init?: RequestInit) => {
        body = await new Request(url, init).json();
        return response(anthropic, reason);
      };
      const provider: ProviderAdapter = anthropic
        ? new AnthropicProtocolAdapter({
            apiKey: "mock",
            baseUrl: "http://fixture",
            fetch: fetchMock,
            adaptiveThinking: true,
          })
        : new OpenAIProtocolAdapter({
            apiKey: "mock",
            baseUrl: "http://fixture/v1",
            fetch: fetchMock,
          });
      const usage: TokenUsage[] = [];
      const result = await modelSummarizer({
        model: "custom",
        provider,
        capabilities: {
          tokenCounting: "local_estimate",
          contextWindow: 10_000,
          maxOutputTokens: 2000,
        },
        contextWindow: 10_000,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Fix the parser, preserving the API" },
            ],
          },
        ],
        targetTokens: 512,
        onUsage: async (value) => {
          usage.push(value);
        },
      });
      expect(result).toEqual(truncated ? undefined : summary);
      expect(body.model).toBe("custom");
      expect(body.tools ?? []).toEqual([]);
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
      expect(body[anthropic ? "max_tokens" : "max_completion_tokens"]).toBe(
        512,
      );
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 50,
        contextInputTokens: anthropic ? 150 : 100,
      });
    });
  }
}
