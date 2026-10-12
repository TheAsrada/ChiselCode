import type { UiCoreTarget } from "./ui-types.js";

const targets = new WeakMap<object, "background" | "agents">();
function attest(kind: "background" | "agents"): UiCoreTarget {
  const reference = Object.freeze({}) as UiCoreTarget;
  targets.set(reference, kind);
  return reference;
}
/** Internal composition only; deliberately absent from extensions/index.ts. */
export const backgroundUiTarget = attest("background");
export const agentsUiTarget = attest("agents");
export function coreUiTarget(reference: UiCoreTarget) {
  return targets.get(reference);
}
