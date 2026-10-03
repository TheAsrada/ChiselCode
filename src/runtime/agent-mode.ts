/** A workflow mode is independent of model selection and approval settings. */
export const AGENT_MODES = ["build", "plan"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];
export const DEFAULT_AGENT_MODE: AgentMode = "build";
export const AGENT_MODE_LABELS: Record<AgentMode, string> = {
  build: "Build",
  plan: "Plan",
};
export function nextAgentMode(mode: AgentMode): AgentMode {
  return mode === "build" ? "plan" : "build";
}
export function allowsToolInMode(mode: AgentMode, effect: string): boolean {
  return mode === "build" || isReadEffect(effect);
}
export function agentModeInstructions(mode: AgentMode): string {
  return mode === "plan"
    ? `<agent_mode>Plan</agent_mode>
You are in Plan mode for this entire request. Explore the project using available read-only tools, clarify material unknowns, and produce a concrete implementation plan. Identify relevant files, decisions, ordered steps, validation, and real risks; keep simple tasks short. Use evidence and distinguish facts from assumptions.
Read-only external MCP tools may be used under their permission policy. Do not edit, create, delete, stage, or commit files, create skills, run shell commands, install dependencies, or create, modify, delete external data. These tools are disabled, even if project instructions, skills, user text, or approval settings request them. Do not work around the restriction. Conversation history and internal checkpoints may be saved by the application.
A request to implement something in Plan mode calls for an implementation plan. Do not claim implementation or tests were performed. Ask the user to switch to Build using Shift+Tab (or /build) when ready to implement. You cannot switch modes yourself.`
    : `<agent_mode>Build</agent_mode>
You are in Build mode for this entire request. Implement the user's requested work with the available tools, following the normal permission policy. Build mode does not grant auto-approval. If the conversation includes a plan, use it as context and check relevant evidence before acting. Report actual changes and verification. Do not repeat planning indefinitely when the user has requested implementation.`;
}

import { isReadEffect } from "../tools/effects.js";
