export interface TrialMetrics {
  turn_count: number;
  provider_request_count: number;
  tool_call_count: number;
  tool_error_count: number;
  repeated_tool_calls: number;
  files_read: string[];
  files_changed: string[];
  patch_attempts: number;
  patch_failures: number;
  stale_revision_failures: number;
  compaction_count: number;
  overflow_recovery_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_output_tokens: number;
  tool_output_offloaded_tokens: number;
  provider_latency: number;
  tool_time: number;
  wall_time: number;
  estimated_cost?: number;
}
export interface TrialReport {
  task: string;
  trial: number;
  status: "success" | "failure" | "infra_error";
  task_success: boolean;
  error?: string;
  model: string;
  provider: string;
  environment: {
    fixture_hash: string;
    chisel_commit: string;
    bun: string;
    platform: string;
    network: string;
    timeout: number;
    model_parameters: Record<string, unknown>;
    resources: string;
  };
  tests_before: unknown[];
  tests_after: unknown[];
  metrics: TrialMetrics;
  trace: unknown[];
}
export function emptyMetrics(): TrialMetrics {
  return {
    turn_count: 0,
    provider_request_count: 0,
    tool_call_count: 0,
    tool_error_count: 0,
    repeated_tool_calls: 0,
    files_read: [],
    files_changed: [],
    patch_attempts: 0,
    patch_failures: 0,
    stale_revision_failures: 0,
    compaction_count: 0,
    overflow_recovery_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    tool_output_tokens: 0,
    tool_output_offloaded_tokens: 0,
    provider_latency: 0,
    tool_time: 0,
    wall_time: 0,
    estimated_cost: undefined,
  };
}
