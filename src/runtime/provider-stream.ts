import { abortable } from "../extensions/lifecycle.js";
import { ProviderError } from "../providers/errors.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "../types/domain.js";

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
  const iterator = provider
    .streamChat({ ...request, signal })
    [Symbol.asyncIterator]();
  let received = false;
  let ended = false;
  try {
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
          next = await abortable(() => iterator.next(), signal);
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
        .then(() => iterator.return?.())
        .catch(() => {});
    }
  }
}
