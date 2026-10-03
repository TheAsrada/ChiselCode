import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Tool, Transport } from "@modelcontextprotocol/client";
import {
  Client,
  isInputRequiredResult,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { z } from "zod";
import { RuntimeError } from "../runtime/errors.js";
import type { JsonObject } from "../types/domain.js";
import { VERSION } from "../version.js";
import { boundedMcpFetch } from "./bounded-fetch.js";
import type {
  McpCallResult,
  McpConnection,
  McpConnectionCallbacks,
  McpConnectionInfo,
  McpProgress,
} from "./connection.js";
import type {
  McpAuthentication,
  McpCredentialResolver,
} from "./credentials.js";
import type { McpRedactor } from "./redaction.js";
import type { McpServerEntry } from "./storage.js";

/** All SDK/protocol/transport choices stay behind this connection boundary. */
class SdkMcpConnection implements McpConnection {
  private discovered = new Map<string, Tool>();
  private stderrDecoder = new StringDecoder("utf8");
  private stderrPending = "";
  private stderrDiscarding = false;
  private readonly client: Client;
  private transport?: Transport;
  constructor(
    private readonly entry: McpServerEntry,
    private readonly credentials: McpCredentialResolver,
    private readonly auth: McpAuthentication,
    private readonly redactor: McpRedactor,
    private readonly callbacks: McpConnectionCallbacks,
  ) {
    this.client = new Client(
      { name: "ChiselCode", version: VERSION },
      {
        capabilities: {},
        jsonSchemaValidator: new AjvJsonSchemaValidator(),
        versionNegotiation: {
          mode: "auto",
          probe: {
            timeoutMs: Math.min(1500, entry.config.startupTimeoutMs),
            maxRetries: 0,
          },
        },
        inputRequired: { autoFulfill: false },
        listMaxPages: 16,
        listChanged: { tools: { onChanged: () => callbacks.toolsChanged() } },
      },
    );
    this.client.onclose = () => {
      this.flushStderr();
      callbacks.closed();
    };
    this.client.onerror = (error) => callbacks.error(error);
  }
  async initialize(signal?: AbortSignal): Promise<McpConnectionInfo> {
    const config = this.entry.config;
    if (config.transport.type === "stdio") {
      const transport = new StdioClientTransport({
        command: config.transport.command,
        args: config.transport.args,
        cwd: await realpath(
          resolve(this.entry.projectRoot, config.transport.cwd ?? "."),
        ),
        env: {
          ...getDefaultEnvironment(),
          ...(await this.credentials.values(config.env, this.redactor)),
        },
        stderr: "pipe",
        maxBufferSize: 10 * 1024 * 1024,
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        this.stderrPending += this.stderrDecoder.write(chunk);
        let newline = this.stderrPending.indexOf("\n");
        while (newline >= 0) {
          if (!this.stderrDiscarding)
            this.callbacks.stderr(
              newline > 32_768
                ? "Слишком длинная строка stderr скрыта."
                : this.stderrPending.slice(0, newline),
            );
          this.stderrDiscarding = false;
          this.stderrPending = this.stderrPending.slice(newline + 1);
          newline = this.stderrPending.indexOf("\n");
        }
        if (this.stderrPending.length > 32_768) {
          this.stderrPending = "";
          if (!this.stderrDiscarding)
            this.callbacks.stderr("Слишком длинная строка stderr скрыта.");
          this.stderrDiscarding = true;
        }
      });
      this.transport = transport;
    } else {
      this.transport = new StreamableHTTPClientTransport(
        new URL(config.transport.url),
        {
          fetch: boundedMcpFetch,
          authProvider: await this.auth.resolve(config, this.redactor),
          requestInit: {
            headers: await this.credentials.values(
              config.transport.headers,
              this.redactor,
            ),
            redirect: "error",
          },
          redirectPolicy: "same-origin",
          // One restart controller owns retry limits. Calls are never replayed.
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 5000,
            reconnectionDelayGrowFactor: 2,
          },
        },
      );
    }
    await this.client.connect(this.transport, {
      signal,
      timeout: config.startupTimeoutMs,
    });
    const capabilities = this.client.getServerCapabilities();
    const server = this.client.getServerVersion();
    return {
      protocolVersion: this.client.getNegotiatedProtocolVersion() ?? "unknown",
      serverName: server?.name,
      serverVersion: server?.version,
      capabilities: {
        tools: Boolean(capabilities?.tools),
        resources: Boolean(capabilities?.resources),
        prompts: Boolean(capabilities?.prompts),
        tasks: Boolean(capabilities?.tasks),
      },
    };
  }
  async listTools(signal?: AbortSignal): Promise<Tool[]> {
    const tools = (
      await this.client.listTools(undefined, {
        signal,
        timeout: this.entry.config.startupTimeoutMs,
        cacheMode: "refresh",
      })
    ).tools;
    this.discovered = new Map(tools.map((tool) => [tool.name, tool]));
    return tools;
  }
  async callTool(
    name: string,
    input: JsonObject,
    signal?: AbortSignal,
    onProgress?: (progress: McpProgress) => void,
  ): Promise<McpCallResult> {
    const definition = this.discovered.get(name);
    if (!definition)
      throw new RuntimeError(
        "MCP_TOOL_NOT_FOUND",
        "Инструмент отсутствует в текущем каталоге MCP.",
        { retryable: false },
      );
    const result = await this.client.callTool(
      { name, arguments: input },
      {
        signal,
        timeout: this.entry.config.callTimeoutMs,
        onprogress: onProgress,
        allowInputRequired: true,
        // An exact discovery snapshot avoids hidden metadata lookups and the
        // SDK's header-mismatch refresh/replay path, including for mutations.
        toolDefinition: definition,
      },
    );
    if (isInputRequiredResult(result))
      throw new RuntimeError(
        "MCP_FEATURE_UNSUPPORTED",
        "Сервер запросил дополнительный ввод. Elicitation пока не поддерживается; операция не завершена.",
        { retryable: false },
      );
    if (
      "task" in result ||
      ("resultType" in result && result.resultType !== "complete")
    )
      throw new RuntimeError(
        "MCP_FEATURE_UNSUPPORTED",
        "Сервер вернул отложенную задачу. MCP tasks пока не поддерживаются; завершение не подтверждено.",
        { retryable: false },
      );
    return z
      .object({
        content: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
              resource: z
                .object({
                  text: z.string().optional(),
                  uri: z.string().optional(),
                })
                .optional(),
              uri: z.string().optional(),
              mimeType: z.string().optional(),
            }),
          )
          .optional(),
        structuredContent: z.json().optional(),
        isError: z.boolean().optional(),
      })
      .parse(result);
  }
  async close(): Promise<void> {
    this.discovered.clear();
    await this.client.close();
  }
  private flushStderr(): void {
    this.stderrPending += this.stderrDecoder.end();
    if (this.stderrPending && !this.stderrDiscarding)
      this.callbacks.stderr(this.stderrPending);
    this.stderrPending = "";
  }
}
export type McpConnectionFactory = (
  entry: McpServerEntry,
  callbacks: McpConnectionCallbacks,
) => McpConnection;
export function sdkMcpConnectionFactory(
  credentials: McpCredentialResolver,
  redactor: McpRedactor,
  authentication: McpAuthentication = credentials,
): McpConnectionFactory {
  return (entry, callbacks) =>
    new SdkMcpConnection(
      entry,
      credentials,
      authentication,
      redactor,
      callbacks,
    );
}
