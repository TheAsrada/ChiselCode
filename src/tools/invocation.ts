import type { JsonObject, ToolExecutionResult } from "../types/domain.js";
export type ToolInvocationState =
  | "queued"
  | "prepared"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled";
export interface ToolInvocationRecord {
  id: string;
  name: string;
  input: JsonObject;
  fingerprint: string;
  state: ToolInvocationState;
  createdAt: string;
  updatedAt: string;
  result?: ToolExecutionResult;
  approvalPreview?: string;
}
export function canonicalInput(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalInput(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
