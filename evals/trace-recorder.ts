import { estimateTokens } from "../src/context/tokenizer.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import type { TrialReport } from "./trial.js";

/** UI, audit and eval consumers observe the same execution stream. */
export function traceRecorder(report: TrialReport) {
  const metrics = report.metrics;
  return (event: RuntimeEvent) => {
    report.trace.push(event);
    if (event.type === "provider_request_started")
      metrics.provider_request_count++;
    if (event.type === "provider_turn_completed") metrics.turn_count++;
    if (
      event.type === "provider_turn_completed" ||
      event.type === "provider_failed"
    )
      metrics.provider_latency += event.durationMs ?? 0;
    if (event.type === "context_compaction_completed")
      metrics.compaction_count++;
    if (event.type === "overflow_recovery") metrics.overflow_recovery_count++;
    if (event.type === "tool_queued") {
      metrics.tool_call_count++;
      if (event.name === "read_file")
        metrics.files_read.push(String(event.input?.path));
      if (event.name === "apply_patch") metrics.patch_attempts++;
    }
    if (event.type === "tool_completed" || event.type === "tool_failed") {
      metrics.tool_time += event.durationMs ?? 0;
      metrics.tool_output_tokens += estimateTokens(event.result?.output ?? "");
      metrics.tool_output_offloaded_tokens +=
        event.result?.artifact?.tokens ?? 0;
      if (event.result?.isError) metrics.tool_error_count++;
      if (event.result?.isError && event.name === "apply_patch")
        metrics.patch_failures++;
      if (event.result?.errorCode === "STALE_FILE_REVISION")
        metrics.stale_revision_failures++;
      if (event.result?.errorCode === "REPEATED_CALL_DETECTED")
        metrics.repeated_tool_calls++;
    }
  };
}
