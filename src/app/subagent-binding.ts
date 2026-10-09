import type { SubagentPort } from "../subagents/contracts.js";

/** Application-only owner controls; no model/tool execution or mutable Session. */
export interface SubagentControls {
  readonly port: Omit<SubagentPort, "submit">;
  busy(): boolean;
  cancel(): Promise<void>;
  close(): Promise<void>;
  wait(): Promise<void>;
  inspect(
    id: string,
    view: "history" | "changes",
  ): Promise<{ text: string; diffs?: import("../types/domain.js").FileDiff[] }>;
}
