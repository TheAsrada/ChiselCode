import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { WebHttpOptions } from "./http-client.js";
import type { SearchInput } from "./schema.js";
import type { SearchResponse, WebSearchBackend } from "./search.js";

function canFailOver(error: unknown, backend: WebSearchBackend): boolean {
  if (!(error instanceof RuntimeError)) return false;
  if (error.code === "WEB_PROTOCOL_ERROR")
    return (
      error.details?.provider === backend.id &&
      ["results", "discovery"].includes(String(error.details?.phase))
    );
  if (error.code === "WEB_RATE_LIMITED")
    // A provider quota can fail over; shared process/turn limits must not.
    return error.details?.provider === backend.id;
  if (error.code === "WEB_HTTP_ERROR")
    return (
      [401, 429].includes(Number(error.details?.status)) ||
      Number(error.details?.status) >= 500
    );
  return (
    ["WEB_TIMEOUT", "WEB_SEARCH_FAILED", "WEB_FETCH_FAILED"].includes(
      error.code,
    ) && error.details?.retryable === true
  );
}

/** Predictable bounded routing across explicitly approved public search services. */
export class AutoSearchBackend implements WebSearchBackend {
  readonly id = "auto";
  readonly hostname: string;
  readonly destinations: readonly { id: string; hostname: string }[];
  constructor(
    private readonly backends: readonly WebSearchBackend[],
    private readonly timeoutMs: number,
  ) {
    const first = backends[0];
    if (!first) throw new Error("Auto search requires at least one backend.");
    this.hostname = first.hostname;
    this.destinations = Object.freeze(
      backends.map((backend) =>
        Object.freeze({ id: backend.id, hostname: backend.hostname }),
      ),
    );
  }
  async search(
    input: SearchInput,
    options: WebHttpOptions,
  ): Promise<SearchResponse> {
    cancelled(options.signal);
    const eligible = this.backends.filter(
      (backend) =>
        !options.authorization.destinations ||
        options.authorization.destinations.includes(backend.hostname),
    );
    if (!eligible.length)
      throw new RuntimeError(
        "WEB_NETWORK_DENIED",
        "No search service is authorized.",
        { retryable: false },
      );
    const deadline = performance.now() + this.timeoutMs;
    const attempted: string[] = [];
    for (const [index, backend] of eligible.entries()) {
      cancelled(options.signal);
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new RuntimeError(
          "WEB_TIMEOUT",
          "Automatic search exceeded its total timeout.",
          { retryable: true },
        );
      const attempt = new AbortController();
      // Leave time for another approved service if this one stalls.
      const timer = setTimeout(
        () => attempt.abort(),
        Math.max(1, Math.floor(remaining / (eligible.length - index))),
      );
      attempted.push(backend.id);
      try {
        const result = await backend.search(input, {
          ...options,
          signal: options.signal
            ? AbortSignal.any([options.signal, attempt.signal])
            : attempt.signal,
        });
        cancelled(options.signal);
        if (attempt.signal.aborted)
          throw new RuntimeError(
            "WEB_TIMEOUT",
            "Search service exceeded its allotted timeout.",
            { retryable: true },
          );
        return {
          ...result,
          usage: { requests: attempted.length },
          routing: { mode: "auto", attempted },
        };
      } catch (cause) {
        cancelled(options.signal);
        const error =
          attempt.signal.aborted &&
          cause instanceof RuntimeError &&
          cause.code === "CANCELLED"
            ? new RuntimeError(
                "WEB_TIMEOUT",
                "Search service exceeded its allotted timeout.",
                { retryable: true },
              )
            : cause;
        if (index === eligible.length - 1 || !canFailOver(error, backend))
          throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new RuntimeError(
      "WEB_SEARCH_FAILED",
      "No approved search service completed the request.",
      { retryable: true },
    );
  }
}
