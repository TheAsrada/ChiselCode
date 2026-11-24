import type { ToolCall, ToolExecutionResult } from "../types/domain.js";
import { isReadEffect } from "./effects.js";
import type { ToolExecutor } from "./executor.js";
export class ToolScheduler {
  constructor(
    readonly executor: ToolExecutor,
    readonly maxParallelReads = 4,
  ) {}
  async execute(
    calls: ToolCall[],
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = new Array(calls.length);
    const handlers = calls.map((call) => {
      try {
        return this.executor.catalog.get(call.name);
      } catch {
        return undefined;
      }
    });
    const readOnly = handlers.every(
      (handler) =>
        handler &&
        isReadEffect(handler.spec.effect) &&
        handler.spec.parallelSafe,
    );
    let next = 0;
    let paused = false;
    const worker = async () => {
      while (next < calls.length && !paused) {
        const index = next++;
        const call = calls[index];
        if (!call) continue;
        const lifetime = handlers[index]?.lifetimeSignal;
        const invocation =
          lifetime && signal
            ? AbortSignal.any([lifetime, signal])
            : (lifetime ?? signal);
        results[index] = await this.executor.execute(call, invocation);
        if (results[index]?.requiresApproval) paused = true;
      }
    };
    await Promise.all(
      Array.from(
        {
          length: readOnly
            ? Math.min(Math.max(1, this.maxParallelReads), calls.length)
            : 1,
        },
        worker,
      ),
    );
    return results;
  }
}
