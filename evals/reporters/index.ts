import type { TrialReport } from "../trial.js";
export function markdown(reports: TrialReport[]): string {
  return [
    "# ChiselCode evaluation",
    "",
    "| Task | Trial | Outcome | Turns | Tools | Tokens in/out | Time ms |",
    "|---|---:|---|---:|---:|---|---:|",
    ...reports.map(
      (r) =>
        `| ${r.task} | ${r.trial} | ${r.status} | ${r.metrics.turn_count} | ${r.metrics.tool_call_count} | ${r.metrics.input_tokens}/${r.metrics.output_tokens} | ${Math.round(r.metrics.wall_time)} |`,
    ),
  ].join("\n");
}
export function compare(baseline: TrialReport[], candidate: TrialReport[]) {
  return candidate.map((trial) => {
    const old = baseline.find(
      (item) => item.task === trial.task && item.trial === trial.trial,
    );
    const comparable =
      old?.model === trial.model &&
      old.provider === trial.provider &&
      old.environment.fixture_hash === trial.environment.fixture_hash;
    return {
      task: trial.task,
      trial: trial.trial,
      comparable,
      baseline: old?.status,
      candidate: trial.status,
      regression: comparable && old?.task_success && !trial.task_success,
      token_delta: comparable
        ? trial.metrics.input_tokens - old.metrics.input_tokens
        : undefined,
    };
  });
}
