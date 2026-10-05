import { z } from "zod";
import { RuntimeError } from "../runtime/errors.js";
import type { SafeWebHttpClient, WebHttpOptions } from "./http-client.js";
import { HostedMcpSearchClient } from "./mcp-search.js";
import type { SearchInput } from "./schema.js";
import {
  normalizeSearchResults,
  type SearchResponse,
  searchQuery,
  type WebSearchBackend,
} from "./search.js";

const SearchPayload = z.object({
  results: z
    .array(
      z.object({
        title: z.string().max(20000).nullish(),
        url: z.string().max(8192),
        excerpts: z.array(z.string().max(30000)).max(100).nullish(),
      }),
    )
    .max(100),
});

/** Anonymous official Search MCP; fetch stays native to preserve Chisel's network policy. */
export class ParallelSearchBackend implements WebSearchBackend {
  readonly id = "parallel";
  readonly hostname = "search.parallel.ai";
  private readonly client: HostedMcpSearchClient;
  constructor(http: SafeWebHttpClient) {
    this.client = new HostedMcpSearchClient(http, {
      id: this.id,
      title: "Parallel",
      endpoint: "https://search.parallel.ai/mcp",
      tool: "web_search",
    });
  }
  async search(
    input: SearchInput,
    options: WebHttpOptions,
  ): Promise<SearchResponse> {
    // Anonymous MCP ignores authenticated source-policy overrides. Operators
    // guide discovery; local filtering below enforces domains/limit regardless.
    // Never forward the conversation, model identity or provider credentials.
    const result = await this.client.call(
      {
        objective: input.query,
        search_queries: [searchQuery(input)],
      },
      options,
    );
    let payload: z.output<typeof SearchPayload>;
    try {
      const text = result.content.find((item) => item.type === "text");
      payload = SearchPayload.parse(
        result.structuredContent ??
          JSON.parse(text?.type === "text" ? text.text : ""),
      );
    } catch {
      throw new RuntimeError(
        "WEB_PROTOCOL_ERROR",
        "Parallel returned malformed search results.",
        {
          retryable: false,
          provider: this.id,
          phase: "results",
        },
      );
    }
    return {
      provider: this.id,
      searchedAt: new Date().toISOString(),
      results: normalizeSearchResults(
        payload.results.map((item) => ({
          title: item.title ?? item.url,
          url: item.url,
          description: item.excerpts?.join(" "),
        })),
        input,
      ),
      usage: { requests: 1 },
    };
  }
}
