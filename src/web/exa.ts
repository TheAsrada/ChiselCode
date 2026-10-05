import { z } from "zod";
import { RuntimeError } from "../runtime/errors.js";
import type { SafeWebHttpClient, WebHttpOptions } from "./http-client.js";
import { HostedMcpSearchClient } from "./mcp-search.js";
import type { SearchInput } from "./schema.js";
import {
  normalizeSearchResults,
  type SearchResponse,
  type WebSearchBackend,
} from "./search.js";

const ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa";
const TOOL = "web_search_advanced_exa";
const SearchPayload = z.object({
  results: z
    .array(
      z.object({
        title: z.string().max(20000).nullish(),
        url: z.string().max(8192),
        text: z.string().max(200000).nullish(),
        highlights: z.array(z.string().max(30000)).max(32).nullish(),
      }),
    )
    .max(100),
});

/** Official anonymous Exa endpoint, normalized to ChiselCode's native search result. */
export class ExaSearchBackend implements WebSearchBackend {
  readonly id = "exa";
  readonly hostname = "mcp.exa.ai";
  private readonly client: HostedMcpSearchClient;
  constructor(http: SafeWebHttpClient) {
    this.client = new HostedMcpSearchClient(http, {
      id: this.id,
      title: "Exa",
      endpoint: ENDPOINT,
      tool: TOOL,
    });
  }
  async search(
    input: SearchInput,
    options: WebHttpOptions,
  ): Promise<SearchResponse> {
    const result = await this.client.call(
      {
        query: input.query,
        numResults: input.limit,
        type: "auto",
        ...(input.domains.length ? { includeDomains: input.domains } : {}),
        ...(input.excludeDomains.length
          ? { excludeDomains: input.excludeDomains }
          : {}),
        textMaxCharacters: 600,
        enableHighlights: true,
        highlightsMaxCharacters: 600,
        moderation: true,
      },
      options,
    );
    let payload: z.output<typeof SearchPayload>;
    try {
      const structured = result.structuredContent;
      const text = result.content?.find((item) => item.type === "text");
      const content = text?.type === "text" ? text.text.trim() : "";
      // Exa documents a plain-text sentinel for an empty search response.
      // Recognize only that exact outcome; arbitrary text remains a failure.
      const empty =
        /^No search results found\. Please try a different query(?: or adjust your filters)?\.$/.test(
          content,
        );
      payload = SearchPayload.parse(
        structured ?? (empty ? { results: [] } : JSON.parse(content)),
      );
    } catch {
      throw new RuntimeError(
        "WEB_PROTOCOL_ERROR",
        "Exa returned malformed search results.",
        { retryable: false, provider: this.id, phase: "results" },
      );
    }
    return {
      provider: "exa",
      searchedAt: new Date().toISOString(),
      results: normalizeSearchResults(
        payload.results.map((item) => ({
          title: item.title ?? item.url,
          url: item.url,
          description: item.highlights?.join(" ") || item.text || undefined,
        })),
        input,
      ),
      usage: { requests: 1 },
    };
  }
}
