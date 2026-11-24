import { randomUUID } from "node:crypto";
import { cancelled } from "../runtime/errors.js";
import { abortable, operationSignal } from "./lifecycle.js";

/** Core authority for one activation. The SDK only receives its signal. */
export class ExtensionActivation {
  readonly id = randomUUID();
  private readonly lifetime = new AbortController();
  readonly signal: AbortSignal;
  published = false;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly cleanups = new Set<() => Promise<void>>();
  private cleanupFailed = false;

  constructor(
    readonly extensionId: string,
    readonly workspaceRoot: string,
    workspaceSignal: AbortSignal,
  ) {
    this.signal = operationSignal(this.lifetime.signal, workspaceSignal);
  }

  get available() {
    return this.published && !this.signal.aborted;
  }

  revoke() {
    this.published = false;
    this.lifetime.abort();
  }

  run<T>(start: () => T | Promise<T>): Promise<T> {
    cancelled(this.signal);
    const pending = Promise.resolve().then(() => {
      cancelled(this.signal);
      return start();
    });
    this.operations.add(pending);
    void pending.finally(() => this.operations.delete(pending)).catch(() => {});
    return pending;
  }

  retain(stop: () => Promise<void>): (confirmed: boolean) => void {
    this.cleanups.add(stop);
    if (this.signal.aborted) void stop().catch(() => {});
    return (confirmed) => {
      if (!confirmed) this.cleanupFailed = true;
      this.cleanups.delete(stop);
    };
  }

  async drain() {
    const budget = AbortSignal.timeout(10000);
    // A submission can still be persisting its acceptance while revocation runs.
    while (this.cleanups.size || this.operations.size) {
      await abortable(
        () =>
          Promise.all([
            ...[...this.cleanups].map((stop) => stop()),
            ...[...this.operations].map((pending) => pending.catch(() => {})),
          ]),
        budget,
      );
    }
    if (this.cleanupFailed)
      throw new Error("Завершение фоновой задачи расширения не подтверждено.");
  }
}
