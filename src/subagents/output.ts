import { utf8Prefix } from "../models/context.js";
import type { SubagentDescriptor, SubagentResult } from "./contracts.js";

/** Model projection only; native viewers keep the full descriptor in details. */
export function subagentOutput(action: string, value: unknown): string {
  const brief = (raw: unknown) => {
    const item = raw as SubagentDescriptor | SubagentResult;
    if (action === "result")
      return { ...item, context: undefined, progress: item.progress.slice(-3) };
    const record = item as SubagentDescriptor;
    return {
      id: record.id,
      label: record.label,
      mode: record.mode,
      status: record.status,
      revision: record.revision,
      step: record.step,
      text: utf8Prefix(record.text, 1000),
      resultAction: "ext:builtin.subagents:result",
      artifact: record.artifact,
      spend: record.spend,
      cleanup: record.cleanup,
      error: record.error,
      progress: record.progress.slice(-3),
    };
  };
  return JSON.stringify(Array.isArray(value) ? value.map(brief) : brief(value));
}
