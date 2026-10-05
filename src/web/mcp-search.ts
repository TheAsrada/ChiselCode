import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { McpSdkClient } from "../mcp/sdk-client.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { VERSION } from "../version.js";
import type { SafeWebHttpClient, WebHttpOptions } from "./http-client.js";

interface HostedSearchService {
  id: string;
  title: string;
  endpoint: string;
  tool: string;
}
/** A fixed, native search capability. Not arbitrary MCP execution or a second tool runtime. */
export class HostedMcpSearchClient {
  constructor(
    private readonly http: SafeWebHttpClient,
    private readonly service: HostedSearchService,
  ) {}
  async call(input: Record<string, unknown>, options: WebHttpOptions) {
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
    const transport = new StreamableHTTPClientTransport(
      new URL(this.service.endpoint),
      {
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
              if (url !== this.service.endpoint)
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
                  `${this.service.title} anonymous search limit reached. Try later, reuse opened sources, or choose another service in /settings → Web.`,
                  { retryable: true, provider: this.service.id, status },
                );
              else if (status >= 400 && status !== 405)
                failure = new RuntimeError(
                  "WEB_HTTP_ERROR",
                  `${this.service.title} search returned HTTP ${status}.`,
                  {
                    retryable: status >= 500,
                    provider: this.service.id,
                    status,
                  },
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
      },
    );
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
      const definition = tools.find((tool) => tool.name === this.service.tool);
      if (!definition)
        throw new RuntimeError(
          "WEB_PROTOCOL_ERROR",
          `${this.service.title} did not expose the expected web search capability.`,
          { retryable: false, provider: this.service.id, phase: "discovery" },
        );
      const result = await client.callTool(
        {
          name: this.service.tool,
          arguments: input,
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
          `${this.service.title} returned an unsupported deferred search result.`,
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
              `${this.service.title} anonymous search limit reached. Try later or choose another service in /settings → Web.`,
              { retryable: true, provider: this.service.id },
            )
          : new RuntimeError(
              "WEB_SEARCH_FAILED",
              `${this.service.title} could not complete the search. Known public URLs remain available through web_fetch.`,
              { retryable: true, provider: this.service.id },
            );
      }
      return result;
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
        `${this.service.title} search could not connect securely. Check proxy/CA settings or retry later.`,
        { retryable: true, provider: this.service.id },
      );
    } finally {
      clearTimeout(deadline);
      lifetime.abort();
      await client.close().catch(() => {});
      await Promise.allSettled([...pending]);
    }
  }
}
