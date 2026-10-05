import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { z } from "zod";
import { McpSdkClient } from "../mcp/sdk-client.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { VERSION } from "../version.js";
import type { SafeWebHttpClient, WebHttpOptions } from "./http-client.js";
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

/** Official anonymous Exa endpoint; SDK owns handshake, framing and cancellation. */
export class ExaSearchBackend implements WebSearchBackend {
  readonly id = "exa";
  readonly hostname = "mcp.exa.ai";
  constructor(private readonly http: SafeWebHttpClient) {}
  async search(
    input: SearchInput,
    options: WebHttpOptions,
  ): Promise<SearchResponse> {
    cancelled(options.signal);
    const lifetime = new AbortController();
    const deadline = setTimeout(
      () => lifetime.abort(),
      this.http.limits.requestTimeoutMs,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, lifetime.signal])
      : lifetime.signal;
    let failure: RuntimeError | undefined;
    const pending = new Set<Promise<Response>>();
    const client = new McpSdkClient(
      { name: "ChiselCode Web Search", version: VERSION },
      {
        capabilities: {},
        jsonSchemaValidator: new AjvJsonSchemaValidator(),
        versionNegotiation: {
          mode: "auto",
          probe: {
            timeoutMs: Math.min(8000, this.http.limits.requestTimeoutMs),
            maxRetries: 0,
          },
        },
        inputRequired: { autoFulfill: false },
        listMaxPages: 2,
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      redirectPolicy: "same-origin",
      requestInit: { redirect: "error" },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: (target, init) => {
        const task = (async () => {
          try {
            const url =
              target instanceof Request ? target.url : target.toString();
            if (url !== ENDPOINT)
              throw new RuntimeError(
                "WEB_PROTOCOL_ERROR",
                "Search backend requested an unexpected endpoint.",
                { retryable: false },
              );
            const request = new Request(target, init);
            const method = request.method;
            if (!["GET", "POST", "DELETE"].includes(method))
              throw new RuntimeError(
                "WEB_PROTOCOL_ERROR",
                "Unsupported search transport request.",
              );
            const response = await this.http.get(url, {
              ...options,
              signal: AbortSignal.any([signal, request.signal]),
              method: method as "GET" | "POST" | "DELETE",
              body:
                method === "POST" && request.body
                  ? await request.text()
                  : undefined,
              headers: Object.fromEntries(request.headers),
              maxRedirects: 0,
              acceptHttpErrors: true,
            });
            const status = response.status ?? 200;
            if (status === 429)
              failure = new RuntimeError(
                "WEB_RATE_LIMITED",
                "Exa anonymous search limit reached. Try later, reuse opened sources, or choose Brave in /settings → Web.",
                { retryable: true, provider: "exa", status },
              );
            else if (status >= 400 && status !== 405)
              failure = new RuntimeError(
                "WEB_HTTP_ERROR",
                `Exa search returned HTTP ${status}.`,
                { retryable: status >= 500, provider: "exa", status },
              );
            return new Response(
              [204, 205, 304].includes(status)
                ? null
                : new Uint8Array(response.bytes),
              { status, headers: response.headers },
            );
          } catch (error) {
            if (error instanceof RuntimeError && error.code !== "CANCELLED")
              failure = error;
            throw error;
          }
        })();
        pending.add(task);
        void task.finally(() => pending.delete(task)).catch(() => {});
        return task;
      },
    });
    // Unsolicited SSE errors must not expose SDK/protocol payloads to the transcript.
    client.onerror = () => {};
    try {
      await client.connect(transport, {
        signal,
        timeout: this.http.limits.requestTimeoutMs,
      });
      const tools = (
        await client.listTools(undefined, { signal, cacheMode: "refresh" })
      ).tools;
      const definition = tools.find((tool) => tool.name === TOOL);
      if (!definition)
        throw new RuntimeError(
          "WEB_PROTOCOL_ERROR",
          "Exa did not expose the expected web search capability.",
          { retryable: false },
        );
      const result = await client.callTool(
        {
          name: TOOL,
          arguments: {
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
        },
        {
          signal,
          timeout: this.http.limits.requestTimeoutMs,
          toolDefinition: definition,
        },
      );
      if (!("content" in result))
        throw new RuntimeError(
          "WEB_PROTOCOL_ERROR",
          "Exa returned an unsupported deferred search result.",
        );
      if (result.isError) {
        const text =
          result.content
            ?.filter((item) => item.type === "text")
            .map((item) => item.text)
            .join(" ") ?? "";
        throw /\b429\b|rate.?limit|quota/i.test(text)
          ? new RuntimeError(
              "WEB_RATE_LIMITED",
              "Exa anonymous search limit reached. Try later or choose Brave in /settings → Web.",
              { retryable: true, provider: "exa" },
            )
          : new RuntimeError(
              "WEB_SEARCH_FAILED",
              "Exa could not complete the search. Known public URLs remain available through web_fetch.",
              { retryable: true, provider: "exa" },
            );
      }
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
          { retryable: false },
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
    } catch (error) {
      cancelled(options.signal);
      if (lifetime.signal.aborted)
        throw new RuntimeError(
          "WEB_TIMEOUT",
          "Web search exceeded its total timeout.",
          { retryable: true },
        );
      if (error instanceof RuntimeError) throw error;
      if (failure) throw failure;
      throw new RuntimeError(
        "WEB_SEARCH_FAILED",
        "Could not connect securely to Exa search. Check proxy/CA settings or retry later.",
        { retryable: true, provider: "exa" },
      );
    } finally {
      clearTimeout(deadline);
      lifetime.abort();
      await client.close().catch(() => {});
      await Promise.allSettled([...pending]);
    }
  }
}
