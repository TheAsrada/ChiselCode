import type { ChiselExtension } from "../contracts.js";
import type { ExtensionDiagnostic } from "./loader.js";

const diagnostics = new WeakMap<
  ChiselExtension,
  (root: string) => ExtensionDiagnostic | undefined
>();
export function setOptionalDiagnostic(
  definition: ChiselExtension,
  read: (root: string) => ExtensionDiagnostic | undefined,
): void {
  diagnostics.set(definition, read);
}
export function optionalDiagnostic(
  definition: ChiselExtension,
  root: string,
): ExtensionDiagnostic | undefined {
  return diagnostics.get(definition)?.(root);
}

/** Private provenance, never a field accepted from an extension definition. */
const optional = new WeakMap<
  ChiselExtension,
  (
    state: "active" | "activation_failed" | "cleanup_failed" | "disposed",
    root: string,
  ) => void
>();
export function markOptional(
  definition: ChiselExtension,
  outcome: (
    state: "active" | "activation_failed" | "cleanup_failed" | "disposed",
    root: string,
  ) => void,
): ChiselExtension {
  optional.set(definition, outcome);
  return definition;
}
export function optionalOutcome(definition: ChiselExtension) {
  return optional.get(definition);
}
export function inheritOptional(
  from: ChiselExtension,
  to: ChiselExtension,
): void {
  const transition = transitions.get(from);
  if (transition) transitions.set(to, transition);
  const claim = claims.get(from);
  if (claim) claims.set(to, claim);
  const outcome = optional.get(from);
  if (outcome) optional.set(to, outcome);
  const read = diagnostics.get(from);
  if (read) diagnostics.set(to, read);
}

// Kept separate from diagnostic callbacks so publishing/retry can await durable CAS.
type Transition = (
  root: string,
  success: boolean,
  signal: AbortSignal,
) => Promise<boolean>;
const transitions = new WeakMap<ChiselExtension, Transition>();
export function setOptionalTransition(
  definition: ChiselExtension,
  transition: Transition,
) {
  transitions.set(definition, transition);
}
export function optionalTransition(definition: ChiselExtension) {
  return transitions.get(definition);
}
type Claim = <T>(
  root: string,
  claim: () => Promise<T>,
) => Promise<T | undefined>;
const claims = new WeakMap<ChiselExtension, Claim>();
export function setOptionalClaim(definition: ChiselExtension, claim: Claim) {
  claims.set(definition, claim);
}
export function optionalClaim(definition: ChiselExtension) {
  return claims.get(definition);
}
