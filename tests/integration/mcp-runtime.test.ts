import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContextManager } from "../../src/context/context-manager.js";
import { McpCredentialResolver } from "../../src/mcp/credentials.js";
import { McpConnectionManager } from "../../src/mcp/manager.js";
import { McpRuntimeBinding } from "../../src/mcp/runtime.js";
import { DEFAULT_MCP_PERMISSIONS } from "../../src/mcp/schema.js";
import { McpConfigStore } from "../../src/mcp/storage.js";
import type { AgentMode } from "../../src/runtime/agent-mode.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import {
  type ApprovalDecision,
  ApprovalGate,
  type ApprovalRequest,
} from "../../src/security/approval.js";
import { createSession } from "../../src/sessions/store.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import type { ProviderAdapter, StreamEvent } from "../../src/types/domain.js";

const roots: string[] = [];
const managers: McpConnectionManager[] = [];
const bindings: McpRuntimeBinding[] = [];
afterEach(async () => {
  for (const binding of bindings.splice(0)) binding.dispose();
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup(
  mode: AgentMode = "build",
  answer: ApprovalDecision = "approved",
  secret?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "chisel-mcp-runtime-"));
  roots.push(root);
  const store = new McpConfigStore(root, {
    globalPath: join(root, "config.json"),
  });
  await store.save("github", {
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [resolve("tests/fixtures/mcp-server.ts")],
    },
    permissions: DEFAULT_MCP_PERMISSIONS,
    env: secret ? { API_TOKEN: { secretRef: "mcp/token" } } : {},
  });
  const manager = new McpConnectionManager(store, {
    credentials: secret
      ? new McpCredentialResolver({
          get: async () => secret,
          set: async () => {},
        })
      : undefined,
  });
  managers.push(manager);
  const requests: ApprovalRequest[] = [];
  const gate = new ApprovalGate(
    {
      allowedCommands: [],
      deniedCommands: [],
      ignorePatterns: [],
      autoApprove: false,
    },
    { autoApprove: false, allowedTools: new Set(), nonInteractive: false },
    {
      requestApproval: async (request) => {
        requests.push(request);
        return answer;
      },
    },
  );
  const session = createSession(root, "openai", "model");
  const tools = createLocalToolRuntime(root, [], gate, session, [], {
    mode,
    artifactDirectory: join(root, "artifacts"),
    sanitizeResult: (result) => manager.redactor.value(result),
    sanitizeApproval: (request) => manager.redactor.value(request),
  });
  const binding = new McpRuntimeBinding(manager, tools.catalog);
  bindings.push(binding);
  await binding.refresh();
  return { root, store, manager, tools, binding, requests, session };
}
test("Plan exposes external reads and rejects writes/destructive before approval and execution", async () => {
  const { tools, requests } = await setup("plan");
  const names = tools.catalog.selectForTurn().map((tool) => tool.name);
  expect(names).toContain("github.get_note");
  expect(names).not.toContain("github.create_note");
  expect(names).not.toContain("github.delete_note");
  expect(
    (
      await tools.executor.execute({
        id: "read",
        name: "github.get_note",
        input: { id: "1" },
      })
    ).output,
  ).toBe("note 1");
  for (const name of ["github.create_note", "github.delete_note"])
    expect(
      (await tools.executor.execute({ id: name, name, input: {} })).errorCode,
    ).toBe("MODE_RESTRICTION");
  expect(requests).toHaveLength(0);
});
test("Always allow approval broadens only one MCP tool and the approved call still executes", async () => {
  const { tools, requests, manager } = await setup("build", "approved_always");
  const result = await tools.executor.execute({
    id: "create",
    name: "github.create_note",
    input: { title: "MCP feature" },
  });
  expect(result.isError).not.toBe(true);
  expect(result.output).toBe("created MCP feature");
  expect(requests[0]?.mcp?.fields).toEqual([
    { label: "Заголовок", value: "MCP feature" },
  ]);
  expect(manager.entry("github").permissions.tools).toEqual({
    create_note: "allow",
  });
  expect(manager.entry("github").permissions.categories.write).toBe("ask");
  await tools.executor.execute({
    id: "create2",
    name: "github.create_note",
    input: { title: "another" },
  });
  expect(requests).toHaveLength(1);
});
test("large MCP results use the existing artifact store and retain read_tool_result", async () => {
  const { tools, session } = await setup();
  const result = await tools.executor.execute({
    id: "large",
    name: "github.get_large",
    input: {},
  });
  expect(result.artifact?.uri).toStartWith("tool-result://");
  expect(result.output.length).toBeLessThan(6500);
  expect(result.rawOutput).toBeUndefined();
  const read = await tools.executor.execute({
    id: "artifact",
    name: "read_tool_result",
    input: { uri: result.artifact?.uri, offset: 5998, limit: 2 },
  });
  expect(read.output).toContain("row 5999");
  expect(JSON.stringify(session.runtime?.invocations.large)).not.toContain(
    "row 5999",
  );
});
test("MCP failure becomes a structured error and an AgentRuntime continues with local tools", async () => {
  const { tools, session, binding, root } = await setup();
  await writeFile(join(root, "local.txt"), "local survives");
  let turn = 0;
  const provider: ProviderAdapter = {
    providerId: "test",
    async *streamChat(): AsyncIterable<StreamEvent> {
      const name = turn === 0 ? "github.get_failure" : "read_file";
      const input = turn === 0 ? {} : { path: "local.txt" };
      const content =
        turn++ < 2
          ? [{ type: "tool_use" as const, id: `tool${turn}`, name, input }]
          : [{ type: "text" as const, text: "Completed using local tools" }];
      yield {
        type: "turn_complete",
        message: { role: "assistant", content },
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const runtime = new AgentRuntime(
    provider,
    new ContextManager({}, tools.context.events),
    {
      selectForTurn: async (input) => {
        await binding.refresh();
        return tools.catalog.selectForTurn(input);
      },
      execute: (calls, signal) => tools.scheduler.execute(calls, signal),
    },
    "test",
    tools.context.events,
  );
  const result = await runtime.run(session, "Read remote, then local", {
    maxIterations: 4,
  });
  expect(result.status).toBe("completed");
  expect(session.runtime?.invocations.tool1?.result?.errorCode).toBe(
    "MCP_TOOL_CALL_FAILED",
  );
  expect(session.runtime?.invocations.tool2?.result?.output).toContain(
    "local survives",
  );
});
test("MCP result, events and persisted invocation data do not leak credentials", async () => {
  const secret = "private-mcp-runtime-token";
  const { tools, session, manager } = await setup("build", "approved", secret);
  const events: unknown[] = [];
  tools.context.events.subscribe((event) => {
    events.push(event);
  });
  const result = await tools.executor.execute({
    id: "secret",
    name: "github.get_secret_echo",
    input: {},
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(session)).not.toContain(secret);
  expect(JSON.stringify(manager.logs("github"))).not.toContain(secret);
});
test("known MCP credentials are removed before local tool artifacts and approval previews are stored", async () => {
  const secret = "local-echo-mcp-secret-987654321";
  const { tools, root, requests, session } = await setup(
    "build",
    "approved",
    secret,
  );
  await writeFile(
    join(root, "echo.txt"),
    `${secret} public data\n`.repeat(2000),
  );
  const read = await tools.executor.execute({
    id: "localread",
    name: "read_file",
    input: { path: "echo.txt", limit: 2000 },
  });
  expect(read.artifact?.uri).toStartWith("tool-result://");
  for (const file of await readdir(join(root, "artifacts")))
    expect(await readFile(join(root, "artifacts", file), "utf8")).not.toContain(
      secret,
    );
  const write = await tools.executor.execute({
    id: "localwrite",
    name: "write_file",
    input: { path: "echo.txt", content: "updated without credential\n" },
  });
  expect(write.isError).not.toBe(true);
  expect(JSON.stringify(requests)).not.toContain(secret);
  expect(JSON.stringify(session.runtime?.invocations)).not.toContain(secret);
});
test("different MCP servers with identical original names cannot collide with local tools", async () => {
  const { store, tools, binding } = await setup();
  const first = (await store.load())[0];
  await store.save("second", first?.config);
  await binding.refresh();
  const names = tools.catalog.selectForTurn().map((tool) => tool.name);
  expect(names).toContain("github.get_note");
  expect(names).toContain("second.get_note");
  expect(names).toContain("read_file");
  expect(tools.catalog.get("github.get_note").spec.source).toMatchObject({
    type: "mcp",
    serverId: "github",
    originalName: "get_note",
  });
  expect(
    (
      await tools.executor.execute({
        id: "second",
        name: "second.get_note",
        input: { id: "2" },
      })
    ).output,
  ).toBe("note 2");
});
test("hundreds of MCP schemas are bounded, relevant and have a discovery fallback", async () => {
  const { tools } = await setup();
  for (let index = 0; index < 300; index++)
    tools.catalog.register({
      spec: {
        name: `aws.get_item_${index}`,
        description: `Read cloud item ${index}`,
        inputSchema: {},
        effect: "external_read",
        permission: "mcp",
        parallelSafe: true,
        pinned: index < 40,
        source: {
          type: "mcp",
          serverId: "aws",
          serverTitle: "AWS",
          originalName: `get_item_${index}`,
          category: "read",
          classificationReason: "read",
        },
      },
      parse: (input) => input,
      prepare: async (_context, input) => ({
        data: input,
        resources: [],
        preview: "",
      }),
      execute: async () => ({ output: "test" }),
    });
  const initial = tools.catalog.selectForTurn({ prompt: "local refactor" });
  expect(
    initial.filter((tool) => tool.name.includes(".")).length,
  ).toBeLessThanOrEqual(32);
  expect(initial.some((tool) => tool.name === "discover_mcp_tools")).toBe(true);
  const found = await tools.executor.execute({
    id: "discovery",
    name: "discover_mcp_tools",
    input: { server: "aws", query: "get_item_299" },
  });
  expect(found.output).toContain("aws.get_item_299");
  expect(tools.catalog.selectForTurn().map((tool) => tool.name)).toContain(
    "aws.get_item_299",
  );
});
test("explicit discovery prioritizes a needed schema within the MCP byte budget", async () => {
  const { tools } = await setup();
  const template = tools.catalog.get("github.get_note");
  const largeDescription = "field documentation ".repeat(2600);
  for (let index = 0; index < 3; index++)
    tools.catalog.register({
      ...template,
      spec: {
        ...template.spec,
        name: `github.get_wide_schema_${index}`,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: largeDescription } },
        },
      },
    });
  const before = tools.catalog.selectForTurn();
  expect(before.some((tool) => tool.name === "github.get_wide_schema_2")).toBe(
    false,
  );
  tools.catalog.include(["github.get_wide_schema_2"]);
  const selected = tools.catalog.selectForTurn();
  expect(
    selected.some((tool) => tool.name === "github.get_wide_schema_2"),
  ).toBe(true);
  expect(selected.some((tool) => tool.name === "read_file")).toBe(true);
  const bytes = selected
    .filter((tool) => tool.name.startsWith("github."))
    .reduce(
      (sum, tool) =>
        sum +
        Buffer.byteLength(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }),
        ),
      0,
    );
  expect(bytes).toBeLessThanOrEqual(96 * 1024);
});
test("unsupported oversized MCP schemas are diagnosed while ordinary tools stay usable", async () => {
  const { tools, store, manager, binding } = await setup();
  const entry = manager.entry("github");
  await store.save("github", {
    ...entry.config,
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [resolve("tests/fixtures/mcp-server.ts"), "large-schema"],
    },
  });
  await binding.refresh();
  expect(tools.catalog.selectForTurn().map((tool) => tool.name)).not.toContain(
    "github.get_huge_schema",
  );
  expect(
    manager.logs("github").some((log) => log.message.includes("64 KiB")),
  ).toBe(true);
  expect(
    (
      await tools.executor.execute({
        id: "normal",
        name: "github.get_note",
        input: { id: "ok" },
      })
    ).output,
  ).toBe("note ok");
});
test("request abort propagates through ToolExecutor without disconnecting other MCP users", async () => {
  const { tools, manager, session } = await setup();
  const abort = new AbortController();
  const pending = tools.executor.execute(
    { id: "cancel", name: "github.get_slow", input: {} },
    abort.signal,
  );
  await Bun.sleep(50);
  abort.abort();
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(["MCP_CANCELLED", "CANCELLED"]).toContain(result.errorCode ?? "");
  expect(session.runtime?.invocations.cancel?.state).toBe("cancelled");
  expect(manager.status("github")?.state).toBe("connected");
  expect(
    (
      await tools.executor.execute({
        id: "other",
        name: "github.get_note",
        input: { id: "other tab" },
      })
    ).output,
  ).toBe("note other tab");
});
test("MCP progress is a runtime event and does not append protocol messages to session history", async () => {
  const { tools, store, manager, binding, session } = await setup();
  const entry = manager.entry("github");
  await store.save("github", {
    ...entry.config,
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [resolve("tests/fixtures/mcp-server.ts"), "progress"],
    },
  });
  await binding.refresh();
  const events: unknown[] = [];
  tools.context.events.subscribe((event) => {
    if (event.type === "tool_progress") events.push(event);
  });
  await tools.executor.execute({
    id: "progress",
    name: "github.get_progress",
    input: {},
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool_progress",
      name: "github.get_progress",
      progress: 42,
      total: 100,
      text: "Indexing events",
    }),
  );
  expect(session.messages).toHaveLength(0);
  expect(tools.catalog.get("github.create_note").spec.workspaceAccess).toBe(
    "write",
  );
  expect(tools.catalog.get("github.get_note").spec.workspaceAccess).toBe(
    "read",
  );
});
