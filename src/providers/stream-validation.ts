import { z } from "zod";
import { normalizeProviderError, ProviderError } from "./errors.js";

// SDK types describe the official API, but SSE JSON from a gateway is unknown.
// Validate fields we consume; additional provider metadata remains compatible.
const counter = z.number().int().nonnegative();
const openAIUsage = z.looseObject({
  prompt_tokens: counter.nullish(),
  completion_tokens: counter.nullish(),
  prompt_tokens_details: z
    .looseObject({ cached_tokens: counter.nullish() })
    .nullish(),
});
export type OpenAIStreamUsage = z.infer<typeof openAIUsage>;

const openAIDelta = z.looseObject({
  role: z.literal("assistant").nullish(),
  content: z.string().nullish(),
  refusal: z.string().nullish(),
  tool_calls: z
    .array(
      z.looseObject({
        index: counter,
        id: z.string().nullish(),
        type: z.literal("function").nullish(),
        function: z
          .looseObject({
            name: z.string().nullish(),
            arguments: z.string().nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});
const openAIChoice = z
  .looseObject({
    index: counter.optional(),
    delta: openAIDelta.nullish(),
    finish_reason: z.string().nullish(),
  })
  .transform((choice, context) => {
    if (!choice.delta && !choice.finish_reason) {
      context.addIssue({
        code: "custom",
        path: ["delta"],
        message: "Missing delta",
      });
      return z.NEVER;
    }
    // Some compatible servers omit delta on a finish-only event.
    return { ...choice, delta: choice.delta ?? {} };
  });
const openAIChunk = z
  .looseObject({
    choices: z.array(openAIChoice).nullish(),
    usage: openAIUsage.nullish(),
  })
  .superRefine((chunk, context) => {
    if (chunk.choices == null && chunk.usage == null)
      context.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Missing choices or usage",
      });
  });
const heartbeat = z.strictObject({ type: z.enum(["ping", "heartbeat"]) });

export function parseOpenAIStreamChunk(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value.type === "ping" || value.type === "heartbeat")
  ) {
    parseEvent(heartbeat, value, "OpenAI Chat Completions");
    return { choices: [], usage: undefined };
  }
  return parseEvent(openAIChunk, value, "OpenAI Chat Completions");
}

const anthropicUsage = z.looseObject({
  input_tokens: counter.nullish(),
  output_tokens: counter.nullish(),
  cache_read_input_tokens: counter.nullish(),
  cache_creation_input_tokens: counter.nullish(),
});
export type AnthropicStreamUsage = z.infer<typeof anthropicUsage>;
function ignoredType(known: string[]) {
  return z
    .looseObject({
      type: z
        .string()
        .min(1)
        .refine((type) => !known.includes(type)),
    })
    .transform(({ type }) => ({
      type: "ignored" as const,
      providerType: type,
    }));
}
const block = z.union([
  z.looseObject({ type: z.literal("text"), text: z.string() }),
  z.looseObject({
    type: z.literal("tool_use"),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }),
  z.looseObject({ type: z.literal("thinking") }),
  z.looseObject({ type: z.literal("redacted_thinking") }),
  ignoredType(["text", "tool_use", "thinking", "redacted_thinking"]),
]);
export type AnthropicStreamBlock = z.infer<typeof block>;
const anthropicEvent = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("message_start"),
    message: z.looseObject({
      role: z.literal("assistant"),
      usage: anthropicUsage.extend({
        input_tokens: counter,
        output_tokens: counter,
      }),
    }),
  }),
  z.looseObject({
    type: z.literal("message_delta"),
    delta: z.looseObject({ stop_reason: z.string().nullish() }),
    usage: anthropicUsage.nullish(),
  }),
  z.looseObject({ type: z.literal("message_stop") }),
  z.looseObject({
    type: z.literal("content_block_start"),
    index: counter,
    content_block: block,
  }),
  z.looseObject({
    type: z.literal("content_block_delta"),
    index: counter,
    delta: z.union([
      z.looseObject({ type: z.literal("text_delta"), text: z.string() }),
      z.looseObject({
        type: z.literal("input_json_delta"),
        partial_json: z.string(),
      }),
      z.looseObject({
        type: z.literal("thinking_delta"),
        thinking: z.string(),
      }),
      z.looseObject({ type: z.enum(["signature_delta", "citations_delta"]) }),
      ignoredType([
        "text_delta",
        "input_json_delta",
        "thinking_delta",
        "signature_delta",
        "citations_delta",
      ]),
    ]),
  }),
  z.looseObject({ type: z.literal("content_block_stop"), index: counter }),
]);

export function parseAnthropicStreamEvent(value: unknown) {
  return parseEvent(anthropicEvent, value, "Anthropic Messages");
}

export function normalizeStreamError(error: unknown, signal?: AbortSignal) {
  if (error instanceof SyntaxError && !signal?.aborted)
    return new ProviderError(
      "transport",
      "Провайдер прислал некорректный JSON в потоке ответа.",
    );
  return normalizeProviderError(error, signal);
}

function parseEvent<T>(
  schema: z.ZodType<T>,
  value: unknown,
  protocol: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const path = result.error.issues[0]?.path.map(String).join(".") || "event";
  // Do not put raw response values, prompts or credentials into diagnostics.
  throw new ProviderError(
    "transport",
    `Некорректное событие ${protocol}: поле «${path}». Проверьте совместимость API выбранного профиля.`,
  );
}
