import { RuntimeError } from "../runtime/errors.js";
import type { WebPermissions } from "../web/schema.js";

export interface NetworkRequest {
  operation: "search" | "fetch";
  hostname: string;
  url?: string;
  query?: string;
  provider?: string;
  /** Fixed search-service endpoints shown before approval, never result-page URLs. */
  searchHosts?: readonly string[];
}
/** Issued by ToolExecutor after approval; tools cannot manufacture a grant. */
export interface NetworkAuthorization {
  /** Approved search destinations, filtered by user policy. Fetch keeps its redirect rules. */
  readonly destinations?: readonly string[];
  assertDestination(hostname: string): void;
}
export interface NetworkSessionGrants {
  search: boolean;
  domains: Set<string>;
}
const sessions = new Map<string, NetworkSessionGrants>();
export function networkSessionGrants(scope: string): NetworkSessionGrants {
  let grants = sessions.get(scope);
  if (!grants) {
    grants = { search: false, domains: new Set() };
    sessions.set(scope, grants);
  }
  // Session-only grants are process memory, never trusted from a saved transcript.
  sessions.delete(scope);
  sessions.set(scope, grants);
  while (sessions.size > 256)
    sessions.delete(sessions.keys().next().value as string);
  return grants;
}
export function clearNetworkSessionGrants(scope: string): void {
  sessions.delete(scope);
}
export function domainMatches(host: string, pattern: string): boolean {
  const hostname = host.toLowerCase().replace(/\.$/, "");
  const rule = pattern.toLowerCase().replace(/\.$/, "");
  return rule.startsWith("*.")
    ? hostname !== rule.slice(2) && hostname.endsWith(rule.slice(1))
    : hostname === rule;
}
export function networkDecision(
  request: NetworkRequest,
  options: { enabled: boolean; permissions: WebPermissions },
  grants?: NetworkSessionGrants,
): "allow" | "ask" | "deny" {
  const rules = options.permissions;
  if (
    !options.enabled ||
    rules[request.operation] === "deny" ||
    (request.operation === "search" && request.searchHosts?.length
      ? request.searchHosts
      : [request.hostname]
    ).every((hostname) =>
      rules.denyDomains.some((rule) => domainMatches(hostname, rule)),
    )
  )
    return "deny";
  if (rules[request.operation] === "allow") return "allow";
  if (request.operation === "search") return grants?.search ? "allow" : "ask";
  return grants?.domains.has(request.hostname) ||
    rules.allowDomains.some((rule) => domainMatches(request.hostname, rule))
    ? "allow"
    : "ask";
}
export function networkDenied(
  message = "Internet access denied by network policy.",
): never {
  throw new RuntimeError("WEB_NETWORK_DENIED", message, { retryable: false });
}
