import type {
  AgentModelRequest,
  AgentModelResponse,
} from "../extension-sdk/agent-events.js";
import { RuntimeError } from "../runtime/errors.js";
import type { ProviderRequest, StreamEvent } from "../types/domain.js";
import type { AgentEventPort } from "./agent-events.js";

type Context = { sessionId: string; turnId?: string };
type Terminal = Extract<StreamEvent, { type: "turn_complete" }>;
export async function prepareAgentModelRequest(
  request: ProviderRequest,
  hooks: AgentEventPort | undefined,
  context: Context,
): Promise<{ request: ProviderRequest; synthetic?: Terminal }> {
  if (!hooks?.has("model.request")) return { request };
  const decision = await hooks.run(
    "model.request",
    {
      model: request.model,
      system: request.system,
      messages: request.messages,
      ...(request.maxTokens !== undefined
        ? { maxTokens: request.maxTokens }
        : {}),
    } as AgentModelRequest,
    context,
    request.signal,
  );
  if ("response" in decision)
    return {
      request,
      synthetic: {
        ...decision.response,
        type: "turn_complete",
        usage: { inputTokens: 0, outputTokens: 0 },
        usageObserved: false,
      },
    };
  if (
    request.maxTokens !== undefined &&
    (decision.request.maxTokens === undefined ||
      decision.request.maxTokens > request.maxTokens)
  )
    throw new RuntimeError(
      "EXTENSION_HOOK_FAILED",
      "Расширение превысило бюджет вывода запроса.",
    );
  return { request: { ...request, ...decision.request } };
}
export async function finishAgentModelResponse(
  response: Terminal,
  hooks: AgentEventPort | undefined,
  context: Context,
  signal?: AbortSignal,
): Promise<Terminal> {
  if (!hooks?.has("model.response")) return response;
  const changed = await hooks.run(
    "model.response",
    {
      message: response.message,
      stopReason: response.stopReason,
      usage: response.usage,
    } as AgentModelResponse,
    context,
    signal,
  );
  if (
    ["length", "max_tokens"].includes(changed.stopReason) &&
    !["length", "max_tokens"].includes(response.stopReason)
  )
    throw new RuntimeError(
      "EXTENSION_HOOK_FAILED",
      "Расширение вернуло незавершённый ответ; вызовы инструментов не выполнены.",
    );
  // Observed usage and its provenance always belong to the actual transport.
  return {
    ...response,
    message: changed.message,
    stopReason: ["refusal", "length", "max_tokens"].includes(
      response.stopReason,
    )
      ? response.stopReason
      : changed.stopReason,
  };
}
export async function* syntheticModelEvents(
  response: Terminal,
): AsyncIterable<StreamEvent> {
  for (const block of response.message.content)
    if (block.type === "text") yield { type: "text_delta", text: block.text };
  yield response;
}
