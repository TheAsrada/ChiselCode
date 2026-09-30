import type { ToolCall, ToolExecutionResult } from "../types/domain.js";
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
    const readOnly = calls.every((call) => {
      try {
        const spec = this.executor.catalog.get(call.name).spec;
        return spec.effect === "read" && spec.parallelSafe;
      } catch {
        return false;
      }
    });
    let next = 0;
    let paused = false;
    const worker = async () => {
      while (next < calls.length && !paused) {
        const index = next++;
        const call = calls[index];
        if (!call) continue;
        results[index] = await this.executor.execute(call, signal);
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
