import { afterEach, expect, test } from "bun:test";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  Tool,
  Transport,
} from "@modelcontextprotocol/client";
import { McpSdkClient } from "../../src/mcp/sdk-client.js";

/** Deliver several decoded messages in one stack, like coalesced stdio/SSE. */
class BatchedTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: () => void;
  private calls: JSONRPCRequest[] = [];
  private waiting: Array<(call: JSONRPCRequest) => void> = [];
  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "initialize") {
      this.deliver({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "batched fixture", version: "1.0.0" },
        },
      });
    } else if (message.method === "tools/call") {
      const receive = this.waiting.shift();
      if (receive) receive(message);
      else this.calls.push(message);
    }
  }
  nextCall(): Promise<JSONRPCRequest> {
    const call = this.calls.shift();
    return call
      ? Promise.resolve(call)
      : new Promise((resolve) => this.waiting.push(resolve));
  }
  deliver(...messages: JSONRPCMessage[]): void {
    for (const message of messages) this.onmessage?.(message);
  }
}
const definition: Tool = {
  name: "get_note",
  inputSchema: { type: "object", properties: {} },
};
const clients: McpSdkClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
async function setup() {
  const transport = new BatchedTransport();
  const client = new McpSdkClient(
    { name: "test", version: "1.0.0" },
    { capabilities: {}, versionNegotiation: { mode: "legacy" } },
  );
  clients.push(client);
  const errors: Error[] = [];
  client.onerror = (error) => errors.push(error);
  await client.connect(transport);
  return { client, transport, errors };
}
function progress(call: JSONRPCRequest, value: number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: {
      progressToken: call.params?._meta?.progressToken,
      progress: value,
      total: 100,
      message: "Indexing events",
    },
  };
}
function result(call: JSONRPCRequest): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id: call.id,
    result: { content: [{ type: "text", text: "indexed" }] },
  };
}
test("coalesced progress notifications reach the callback before response cleanup", async () => {
  const { client, transport, errors } = await setup();
  const events: number[] = [];
  const pending = client.callTool(
    { name: definition.name, arguments: {} },
    {
      toolDefinition: definition,
      onprogress: (value) => events.push(value.progress),
    },
  );
  const call = await transport.nextCall();
  transport.deliver(progress(call, 20), progress(call, 42), result(call));
  await expect(pending).resolves.toMatchObject({
    content: [{ type: "text", text: "indexed" }],
  });
  expect(events).toEqual([20, 42]);
  expect(errors).toEqual([]);
});
test("batched progress remains isolated between concurrent MCP calls", async () => {
  const { client, transport, errors } = await setup();
  const events: number[][] = [[], []];
  const pending = events.map((values) =>
    client.callTool(
      { name: definition.name, arguments: {} },
      {
        toolDefinition: definition,
        onprogress: (value) => values.push(value.progress),
      },
    ),
  );
  const first = await transport.nextCall();
  const second = await transport.nextCall();
  transport.deliver(
    progress(first, 42),
    progress(second, 24),
    result(second),
    result(first),
  );
  await Promise.all(pending);
  expect(events).toEqual([[42], [24]]);
  expect(errors).toEqual([]);
});
test("an MCP error response still delivers preceding progress and rejects the call", async () => {
  const { client, transport, errors } = await setup();
  const events: number[] = [];
  const pending = client.callTool(
    { name: definition.name, arguments: {} },
    {
      toolDefinition: definition,
      onprogress: (value) => events.push(value.progress),
    },
  );
  const outcome = pending.then(
    () => ({ error: undefined }),
    (error: Error) => ({ error }),
  );
  const call = await transport.nextCall();
  transport.deliver(progress(call, 42), {
    jsonrpc: "2.0",
    id: call.id,
    error: { code: -32603, message: "fixture failed" },
  });
  expect((await outcome).error?.message).toContain("fixture failed");
  expect(events).toEqual([42]);
  expect(errors).toEqual([]);
});
