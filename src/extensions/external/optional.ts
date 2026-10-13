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
    state: "active" | "activation_failed" | "cleanup_failed",
    root: string,
  ) => void
>();
export function markOptional(
  definition: ChiselExtension,
  outcome: (
    state: "active" | "activation_failed" | "cleanup_failed",
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
  const outcome = optional.get(from);
  if (outcome) optional.set(to, outcome);
  const read = diagnostics.get(from);
  if (read) diagnostics.set(to, read);
}
