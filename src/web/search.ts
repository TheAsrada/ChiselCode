import { parseHTML } from "linkedom";
import { z } from "zod";
import { RuntimeError } from "../runtime/errors.js";
import type { CredentialStorage } from "../security/credentials.js";
import { CredentialStore } from "../security/credentials.js";
import { domainMatches } from "../security/network-policy.js";
import type { SecretRedactor } from "../security/redaction.js";
import { referenceText, textLimit } from "./content.js";
import type { SafeWebHttpClient, WebHttpOptions } from "./http-client.js";
import type { SearchInput, WebConfig } from "./schema.js";
import { UrlPolicy, urlHostname } from "./url-policy.js";

export interface WebSearchResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
}
export interface SearchResponse {
  provider: string;
  searchedAt: string;
  results: WebSearchResult[];
  usage: { requests: number };
  routing?: { mode: "auto"; attempted: string[] };
}
/** Search backend boundary: no LLM driver, UI, permission resolver or transcript dependency. */
export interface WebSearchBackend {
  readonly id: string;
  readonly hostname: string;
  readonly destinations?: readonly { id: string; hostname: string }[];
  search(input: SearchInput, options: WebHttpOptions): Promise<SearchResponse>;
}
export type SearchBackendId = Exclude<WebConfig["search"]["provider"], "auto">;
const searchLabels = new Map<string, string>([
  ["auto", "Авто"],
  ["exa", "Exa"],
  ["parallel", "Parallel"],
  ["brave", "Brave"],
]);
export function searchBackendLabel(id: string): string {
  return searchLabels.get(id) ?? id;
}
export function searchBackendCandidates(
  config: WebConfig,
  hasBraveKey: boolean,
): SearchBackendId[] {
  return config.search.provider === "auto"
    ? hasBraveKey
      ? ["brave", "exa", "parallel"]
      : ["exa", "parallel"]
    : [config.search.provider];
}
export function effectiveSearchBackend(
  config: WebConfig,
  hasBraveKey: boolean,
): SearchBackendId {
  return searchBackendCandidates(config, hasBraveKey)[0] ?? "exa";
}
/** Public search operators are hints; normalizeSearchResults enforces the filters. */
export function searchQuery(input: SearchInput): string {
  return [
    input.query,
    input.domains.length
      ? `(${input.domains.map((domain) => `site:${domain}`).join(" OR ")})`
      : "",
    ...input.excludeDomains.map((domain) => `-site:${domain}`),
  ]
    .filter(Boolean)
    .join(" ");
}
const BraveResponseSchema = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string().max(20000),
            url: z.string().max(8192),
            description: z.string().max(30000).optional(),
          }),
        )
        .max(100),
    })
    .optional(),
});
function snippet(text: string, max: number): string {
  const document = parseHTML(
    `<html><body>${textLimit(text, 30000)}</body></html>`,
  ).document;
  for (const node of document.querySelectorAll("script,style")) node.remove();
  return textLimit(
    referenceText(document.body.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );
}
export function normalizeSearchResults(
  results: Array<{ title: string; url: string; description?: string }>,
  input: SearchInput,
  policy = new UrlPolicy(),
): WebSearchResult[] {
  const seen = new Set<string>();
  const filtered: WebSearchResult[] = [];
  for (const result of results) {
    try {
      const url = policy.normalize(result.url);
      const domain = urlHostname(url);
      const matches = (rule: string) =>
        domainMatches(domain, rule) || domainMatches(domain, `*.${rule}`);
      if (
        seen.has(url.toString()) ||
        (input.domains.length && !input.domains.some(matches)) ||
        input.excludeDomains.some(matches)
      )
        continue;
      seen.add(url.toString());
      filtered.push({
        title: snippet(result.title, 240),
        url: url.toString(),
        domain,
        snippet: snippet(result.description ?? "", 600),
      });
      if (filtered.length >= input.limit) break;
    } catch {
      /* Invalid/non-public result links are not advertised to the model. */
    }
  }
  return filtered;
}
export class BraveSearchBackend implements WebSearchBackend {
  readonly id = "brave";
  readonly hostname = "api.search.brave.com";
  constructor(
    private readonly http: SafeWebHttpClient,
    private readonly apiKey: string,
    private readonly redactor: SecretRedactor,
  ) {}
  async search(
    input: SearchInput,
    options: WebHttpOptions,
  ): Promise<SearchResponse> {
    const query = searchQuery(input);
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(input.limit));
    url.searchParams.set("text_decorations", "false");
    url.searchParams.set("safesearch", "moderate");
    try {
      const response = await this.http.get(url.toString(), {
        ...options,
        maxRedirects: 0,
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
        },
      });
      let parsed: z.output<typeof BraveResponseSchema>;
      try {
        parsed = BraveResponseSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(response.bytes),
          ),
        );
      } catch {
        throw new RuntimeError(
          "WEB_PROTOCOL_ERROR",
          "Search provider returned a malformed result payload.",
          { retryable: false, provider: this.id, phase: "results" },
        );
      }
      const results = normalizeSearchResults(
        this.redactor.value(parsed.web?.results ?? []),
        input,
      );
      return {
        provider: this.id,
        searchedAt: new Date().toISOString(),
        results,
        usage: { requests: 1 },
      };
    } catch (error) {
      if (error instanceof RuntimeError) {
        if (
          (error.code === "WEB_HTTP_ERROR" ||
            error.code === "WEB_RATE_LIMITED") &&
          typeof error.details?.status === "number"
        )
          throw new RuntimeError(error.code, error.message, {
            ...error.details,
            provider: this.id,
          });
        throw error;
      }
      throw new RuntimeError(
        "WEB_SEARCH_FAILED",
        "Search provider request failed.",
        { retryable: true },
      );
    }
  }
}
export async function resolveWebCredential(
  config: WebConfig,
  redactor: SecretRedactor,
  storage: CredentialStorage = new CredentialStore(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  let value: string | undefined;
  try {
    const ref = config.search.apiKey;
    value =
      "secretRef" in ref
        ? await storage.get(ref.secretRef)
        : environment[ref.envRef];
  } catch {
    return;
  }
  if (!value) return;
  // Never pass controls to HTTP headers or display a malformed credential in an error.
  if (
    value.length < 8 ||
    value.length > 8192 ||
    value.trim() !== value ||
    [...value].some((ch) => ch.charCodeAt(0) < 33 || ch.charCodeAt(0) > 126)
  )
    return;
  redactor.add(value);
  return value;
}
