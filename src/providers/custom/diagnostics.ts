export type { ProviderDiagnostic } from "../contracts.js";

import type { ProviderDiagnostic } from "../contracts.js";
export function formatProviderDiagnostic(d: ProviderDiagnostic): string {
  return `${d.severity} ${d.code}${d.path ? ` (${d.path})` : ""}: ${d.message}`;
}
