import { cancelled, RuntimeError } from "../runtime/errors.js";

/** Shared process limiter; waiting is cancellable and never creates unbounded workers. */
export class WebRequestLimiter {
  private active = 0;
  private waiters = new Set<() => void>();
  private lastStarted = 0;
  private counts = new Map<string, number>();
  private timestamps: number[] = [];
  constructor(
    private readonly concurrency = 3,
    private readonly spacingMs = 250,
    private readonly requestsPerMinute = 120,
  ) {}
  async acquire(
    scope: string,
    maxPerTurn: number,
    signal: AbortSignal,
    concurrency = this.concurrency,
  ): Promise<() => void> {
    cancelled(signal);
    const count = this.counts.get(scope) ?? 0;
    if (count >= maxPerTurn)
      throw new RuntimeError(
        "WEB_REQUEST_LIMIT",
        "Web request budget for this turn is exhausted. Continue with collected evidence instead of repeating searches or fetches.",
        { retryable: false },
      );
    this.counts.set(scope, count + 1);
    while (this.counts.size > 512)
      this.counts.delete(this.counts.keys().next().value as string);
    while (true) {
      cancelled(signal);
      const now = Date.now();
      this.timestamps = this.timestamps.filter((time) => time > now - 60000);
      if (this.timestamps.length >= this.requestsPerMinute)
        throw new RuntimeError(
          "WEB_RATE_LIMITED",
          "Process web request rate limit reached.",
          {
            retryable: true,
            retryAfterMs: Math.max(
              1,
              (this.timestamps[0] ?? now) + 60000 - now,
            ),
          },
        );
      const delay = Math.max(0, this.lastStarted + this.spacingMs - now);
      if (this.active < Math.min(8, concurrency) && delay === 0) {
        this.active++;
        this.lastStarted = now;
        this.timestamps.push(now);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active--;
          for (const wake of this.waiters) wake();
        };
      }
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          this.waiters.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(
            new RuntimeError("CANCELLED", "Waiting web request cancelled."),
          );
        };
        this.waiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
        if (delay > 0) timer = setTimeout(wake, delay);
        if (signal.aborted) abort();
      });
    }
  }
}
