import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolver,
} from "./approval.js";

interface Waiting {
  request: ApprovalRequest;
  resolver: ApprovalResolver;
  child: boolean;
  signal?: AbortSignal;
  resolve(decision: ApprovalDecision): void;
  removeAbort(): void;
}
/** One application popup owner. A waiting foreground wins, with bounded child fairness. */
export class ApprovalArbiter {
  private queue: Waiting[] = [];
  private active = false;
  private foregroundBurst = 0;
  private disposed = false;
  wrap(resolver: ApprovalResolver, child = false): ApprovalResolver {
    return {
      requestApproval: (request, signal) => {
        if (this.disposed || signal?.aborted)
          return Promise.resolve("unavailable");
        return new Promise<ApprovalDecision>((resolve) => {
          const item: Waiting = {
            request,
            resolver,
            child,
            signal,
            resolve,
            removeAbort: () => {},
          };
          const abort = () => {
            const index = this.queue.indexOf(item);
            if (index < 0) return;
            this.queue.splice(index, 1);
            item.removeAbort();
            resolve("unavailable");
          };
          signal?.addEventListener("abort", abort, { once: true });
          item.removeAbort = () => signal?.removeEventListener("abort", abort);
          this.queue.push(item);
          this.pump();
        });
      },
    };
  }
  private pump(): void {
    if (this.active || !this.queue.length) return;
    let index = this.queue.findIndex((item) => !item.child);
    if (index < 0 || this.foregroundBurst >= 2) index = 0;
    const item = this.queue.splice(index, 1)[0];
    if (!item) return;
    this.active = true;
    item.removeAbort();
    this.foregroundBurst = item.child ? 0 : this.foregroundBurst + 1;
    void Promise.resolve()
      .then(() => item.resolver.requestApproval(item.request, item.signal))
      .then(
        (result) => item.resolve(item.signal?.aborted ? "unavailable" : result),
        () => item.resolve("unavailable"),
      )
      .finally(() => {
        this.active = false;
        this.pump();
      });
  }
  dispose(): void {
    this.disposed = true;
    for (const item of this.queue.splice(0)) {
      item.removeAbort();
      item.resolve("unavailable");
    }
  }
}
