import type { ToolHandler } from "../tools/types.js";

const nativeSources = new WeakSet<ToolHandler>();
const nativeTools = new WeakMap<
  ToolHandler,
  { name: string; guidance?: string }
>();

/** Captures core-authored text; neither a copied handler nor a mutable spec grants trust. */
export function attestNativeSkillTool(handler: ToolHandler): void {
  nativeTools.set(handler, {
    name: handler.spec.name,
    guidance: handler.spec.guidance,
  });
}
export function nativeSkillGuidance(handler: ToolHandler): string | undefined {
  const record = nativeTools.get(handler);
  return handler.spec.source?.type === "skill" &&
    record?.name === handler.spec.name
    ? record.guidance
    : undefined;
}
export function isNativeSkillReader(handler: ToolHandler): boolean {
  return (
    nativeTools.get(handler)?.name === "load_skill" &&
    handler.spec.name === "load_skill" &&
    handler.spec.source?.type === "skill" &&
    handler.spec.effect === "read" &&
    handler.spec.permission === "read"
  );
}
export function markNativeSkillSource(handler: ToolHandler): ToolHandler {
  nativeSources.add(handler);
  return handler;
}
export function isNativeSkillSource(handler: ToolHandler): boolean {
  return nativeSources.has(handler);
}
