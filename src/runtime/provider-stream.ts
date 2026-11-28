import { setTimeout as delay } from "node:timers/promises";
import { abortable } from "../extensions/lifecycle.js";
import {
  isProviderAccessError,
  normalizeProviderError,
  ProviderError,
  providerErrorEvent,
  providerErrorFromEvent,
} from "../providers/errors.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
  TokenUsage,
} from "../types/domain.js";

import { RuntimeError } from "./errors.js";

export const PROVIDER_IDLE_TIMEOUT_MS = 60_000;

/** Bound the wait between semantic events, including before HTTP headers. */
export async function* readProviderStream(
  provider: ProviderAdapter,
  request: ProviderRequest,
  idleTimeoutMs: number,
): AsyncIterable<StreamEvent> {
  const controller = new AbortController();
  const signal = request.signal
    ? AbortSignal.any([request.signal, controller.signal])
    : controller.signal;
  let iterator: AsyncIterator<StreamEvent> | undefined;
  let received = false;
  let ended = false;
  try {
    const stream = provider
      .streamChat({ ...request, signal })
      [Symbol.asyncIterator]();
    iterator = stream;
    while (true) {
      const timer = setTimeout(() => {
        const seconds = idleTimeoutMs / 1000;
        controller.abort(
          new ProviderError(
            "timeout",
            received
              ? `Поток ответа провайдера остановился на ${seconds} с.`
              : `Провайдер не начал ответ за ${seconds} с.`,
          ),
        );
      }, idleTimeoutMs);
      let next: IteratorResult<StreamEvent>;
      try {
        do {
          next = await abortable(() => stream.next(), signal);
        } while (
          !next.done &&
          (next.value.type === "text_delta" ||
            next.value.type === "thinking_delta") &&
          !next.value.text
        );
      } catch (error) {
        if (
          controller.signal.aborted &&
          signal.reason === controller.signal.reason
        )
          throw controller.signal.reason;
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (next.done) {
        ended = true;
        return;
      }
      received = true;
      yield next.value;
    }
  } finally {
    if (!ended) {
      controller.abort();
      // A non-cooperative adapter may queue return() behind a stalled next().
      void Promise.resolve()
        .then(() => iterator?.return?.())
        .catch(() => {});
    }
  }
}

export const PROVIDER_REQUEST_DEADLINE_MS = 600_000;
const MAX_ATTEMPTS = 3;

type ProviderFailureEvent = Extract<StreamEvent, { type: "error" }>;

export async function* retryProviderStream(
  provider: ProviderAdapter,
  request: ProviderRequest,
  {
    idleTimeoutMs = PROVIDER_IDLE_TIMEOUT_MS,
    deadlineMs = PROVIDER_REQUEST_DEADLINE_MS,
    onRetry,
  }: {
    idleTimeoutMs?: number;
    deadlineMs?: number;
    onRetry?: (
      failure: ProviderFailureEvent,
      waitMs: number,
    ) => void | Promise<void>;
  } = {},
): AsyncIterable<StreamEvent> {
  const deadline = performance.now() + deadlineMs;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), deadlineMs);
  const signal = request.signal
    ? AbortSignal.any([request.signal, timeout.signal])
    : timeout.signal;
  const retryBudget = { remaining: MAX_ATTEMPTS - 1 };
  const deadlineExceeded = (last?: ProviderError) =>
    new ProviderError(
      "timeout",
      "Истёк общий срок запроса к модели или оставшегося времени недостаточно для повтора.",
      last?.status,
      false,
      last?.retryAfterMs,
      last?.upstreamCode,
    );
  const cancel = () =>
    new ProviderError("cancelled", "Запрос к модели отменён.");
  const retryRequest = {
    ...request,
    signal,
    transport: { ...request.transport, maxRetries: 0, retryBudget },
  };
  let last: ProviderError | undefined;
  try {
    for (;;) {
      if (request.signal?.aborted) throw cancel();
      if (signal.aborted || performance.now() >= deadline)
        throw deadlineExceeded(last);
      const pending: StreamEvent[] = [];
      let usage: TokenUsage | undefined;
      let failure: ProviderError | undefined;
      try {
        for await (const event of readProviderStream(
          provider,
          retryRequest,
          idleTimeoutMs,
        )) {
          if (event.type === "error") {
            usage = event.usage ?? usage;
            failure = providerErrorFromEvent(event);
            break;
          }
          if (event.type === "turn_complete") usage = event.usage;
          if (event.type === "thinking_start" || event.type === "tool_delta")
            yield event;
          else {
            // Stage response content so append-only consumers see each answer once.
            pending.push(event);
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          if (error instanceof RuntimeError) throw error;
          failure = normalizeProviderError(error);
        }
      }
      if (request.signal?.aborted) failure = cancel();
      else if (signal.aborted || performance.now() >= deadline)
        failure = deadlineExceeded(
          failure?.code === "cancelled" ? last : (failure ?? last),
        );
      if (!failure) {
        for (const event of pending) yield event;
        return;
      }
      if (
        failure.retryable &&
        failure.code !== "cancelled" &&
        !isProviderAccessError(failure)
      ) {
        if (retryBudget.remaining === 0)
          failure = new ProviderError(
            failure.code,
            `Исчерпаны попытки запроса к модели (${MAX_ATTEMPTS}). ${failure.message}`,
            failure.status,
            false,
            failure.retryAfterMs,
            failure.upstreamCode,
          );
        else {
          const waitMs =
            failure.retryAfterMs ??
            500 * 2 ** (MAX_ATTEMPTS - 1 - retryBudget.remaining);
          if (waitMs < deadline - performance.now()) {
            last = failure;
            await onRetry?.(providerErrorEvent(failure, usage), waitMs);
            try {
              await delay(waitMs, undefined, { signal });
            } catch (error) {
              if (request.signal?.aborted) throw cancel();
              if (signal.aborted) throw deadlineExceeded(last);
              throw error;
            }
            retryBudget.remaining--;
            continue;
          }
          failure = deadlineExceeded(failure);
        }
      }
      yield providerErrorEvent(failure, usage);
      return;
    }
  } finally {
    clearTimeout(timer);
  }
}
