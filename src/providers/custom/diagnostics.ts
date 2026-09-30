export type { ProviderDiagnostic } from "../contracts.js";

import type { ProviderDiagnostic } from "../contracts.js";
export function formatProviderDiagnostic(d: ProviderDiagnostic): string {
  const safe = (value: string) => value.replace(/\p{Cc}/gu, " ");
  return safe(
    `${d.severity} ${d.code}${d.path ? ` (${d.path})` : ""}: ${d.message}`,
  );
}
