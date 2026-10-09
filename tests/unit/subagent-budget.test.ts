import { expect, test } from "bun:test";
import { builtinDefinitions } from "../../src/providers/definitions/index.js";
import { AnthropicProtocolAdapter } from "../../src/providers/drivers/anthropic-messages.js";
import { OpenAIProtocolAdapter } from "../../src/providers/drivers/openai-chat.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import {
  boundedChildProvider,
  ChildBudget,
  DelegationEnvelope,
} from "../../src/subagents/budget.js";
import type { ProviderRequest, StreamEvent } from "../../src/types/domain.js";
import { childFixture } from "../helpers/subagent.js";

const request = (): ProviderRequest => ({
  model: "fixture-model",
  system: "Поручение",
  messages: [{ role: "user", content: [{ type: "text", text: "Вопрос" }] }],
  tools: [],
  maxTokens: 20,
});
test("parallel token reservations are atomic and ambiguous spend is retained; observed receipts deduplicate", async () => {
  const group = new DelegationEnvelope(100);
  const a = childFixture();
  const b = childFixture();
  const first = new ChildBudget(
    a,
    group,
    new AbortController(),
    async () => {},
  );
  const second = new ChildBudget(
    b,
    group,
    new AbortController(),
    async () => {},
  );
  const attempt = await first.reserve({ ...request(), maxTokens: 70 });
  expect(group.used).toBe(attempt.reserved);
  await expect(second.reserve({ ...request(), maxTokens: 70 })).rejects.toThrow(
    "бюджет",
  );
  await first.complete(attempt);
  expect(group.used).toBe(attempt.reserved);
  expect(a.spend.unknownUsage).toBe(true);
  const third = new ChildBudget(
    childFixture(),
    new DelegationEnvelope(10000),
    new AbortController(),
    async () => {},
  );
  const observed = await third.reserve(request());
  await third.complete(
    observed,
    { inputTokens: 12, outputTokens: 2 },
    true,
    builtinDefinitions[0],
  );
  await third.complete(
    observed,
    { inputTokens: 12, outputTokens: 2 },
    true,
    builtinDefinitions[0],
  );
  expect(third.record.spend.usage.inputTokens).toBe(12);
  expect(third.record.consumption.accountedTokens).toBe(14);
});
for (const protocol of ["openai", "anthropic"] as const)
  test(`real ${protocol} HTTP attempts include bounded retries, split-secret redaction and strict terminal validation`, async () => {
    let count = 0;
    let malformed = false;
    const secret = "fixture-secret-across-delta-boundaries";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        count++;
        if (count < 3)
          return Response.json(
            { error: { message: "busy", type: "overloaded_error" } },
            { status: 429 },
          );
        if (protocol === "openai")
          return new Response(
            [
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: secret.slice(0, 15) }, finish_reason: null }] })}`,
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: secret.slice(15) + " безопасный ответ" }, finish_reason: malformed ? null : "stop" }] })}`,
              `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } })}`,
              "data: [DONE]",
            ].join("\n\n") + "\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
          );
        const events = [
          {
            type: "message_start",
            message: {
              id: "fixture",
              type: "message",
              role: "assistant",
              model: "fixture-model",
              content: [],
              usage: { input_tokens: 12, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: secret.slice(0, 15) },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: secret.slice(15) + " безопасный ответ",
            },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 2 },
          },
          ...(!malformed ? [{ type: "message_stop" }] : []),
        ];
        return new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      const redactor = new SecretRedactor();
      redactor.add(secret);
      const record = childFixture();
      const abort = new AbortController();
      const adapter =
        protocol === "openai"
          ? new OpenAIProtocolAdapter({
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              apiKey: "fixture",
            })
          : new AnthropicProtocolAdapter({
              baseUrl: `http://127.0.0.1:${server.port}`,
              apiKey: "fixture",
            });
      const provider = boundedChildProvider({
        adapter,
        definition: builtinDefinitions.find((def) => def.id === protocol)!,
        capabilities: { tokenCounting: "local_estimate" },
        budget: new ChildBudget(
          record,
          new DelegationEnvelope(10000),
          abort,
          async () => {},
        ),
        signal: abort.signal,
        deadline: Date.now() + 10000,
        redactor,
        beforeRequest: async () => {},
      });
      const events: StreamEvent[] = [];
      for await (const event of provider.streamChat(request()))
        events.push(event);
      expect(count).toBe(3);
      expect(record.attempts).toHaveLength(3);
      expect(events.some((event) => event.type === "turn_complete")).toBe(true);
      expect(
        events
          .filter((event) => event.type === "text_delta")
          .map((event) => event.text)
          .join(""),
      ).toBe("[секрет скрыт] безопасный ответ");
      expect(JSON.stringify(events)).not.toContain(secret);
      malformed = true;
      const bad: StreamEvent[] = [];
      for await (const event of provider.streamChat(request())) bad.push(event);
      expect(count).toBe(4);
      expect(bad.some((event) => event.type === "turn_complete")).toBe(false);
      expect(bad.some((event) => event.type === "error")).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 15000);
