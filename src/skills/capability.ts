import type { ToolHandler } from "../tools/types.js";

const nativeSources = new WeakSet<ToolHandler>();
export function markNativeSkillSource(handler: ToolHandler): ToolHandler {
  nativeSources.add(handler);
  return handler;
}
export function isNativeSkillSource(handler: ToolHandler): boolean {
  return nativeSources.has(handler);
}
