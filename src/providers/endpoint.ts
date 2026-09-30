import type { ProviderDefinition } from "./contracts.js";
import { ProviderError } from "./errors.js";
export function normalizeEndpoint(
  policy: ProviderDefinition["endpoint"]["normalization"],
  value: string,
): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProviderError("invalid_endpoint", "Invalid API baseUrl.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ProviderError(
      "invalid_endpoint",
      "API baseUrl must be HTTP(S), without credentials, query or fragment.",
    );
  if (policy === "openai-v1" && (url.pathname === "/" || url.pathname === ""))
    return `${trimmed}/v1`;
  if (policy === "anthropic-root" && trimmed.toLowerCase().endsWith("/v1"))
    return trimmed.slice(0, -3).replace(/\/+$/, "");
  return trimmed;
}
export function resolveEndpoint(
  definition: ProviderDefinition,
  override?: string,
): string | undefined {
  const raw = override?.trim() || definition.endpoint.defaultBaseUrl;
  if (!raw) {
    if (definition.endpoint.required)
      throw new ProviderError(
        "invalid_endpoint",
        `Provider "${definition.id}" requires baseUrl.`,
      );
    return undefined;
  }
  return normalizeEndpoint(definition.endpoint.normalization, raw);
}
