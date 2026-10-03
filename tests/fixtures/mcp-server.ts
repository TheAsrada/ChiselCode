import { appendFileSync } from "node:fs";
import { inputRequired, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const mode = process.argv[2];
if (mode === "slow-start") {
  if (process.env.MCP_START_MARKER)
    appendFileSync(process.env.MCP_START_MARKER, `started ${process.pid}\n`);
  await Bun.sleep(5000);
}
if (mode === "delayed") await Bun.sleep(180);
if (mode === "split-stderr") {
  const value = process.env.API_TOKEN ?? "";
  process.stderr.write(`server token ${value.slice(0, 6)}`);
  await Bun.sleep(20);
  process.stderr.write(`${value.slice(6)}\n`);
}
if (mode === "long-stderr") {
  const value = process.env.API_TOKEN ?? "";
  process.stderr.write("x".repeat(33_000));
  await Bun.sleep(20);
  process.stderr.write(value.slice(0, 8));
  await Bun.sleep(20);
  process.stderr.write(`${value.slice(8)}\n`);
}
if (process.env.MCP_START_MARKER)
  appendFileSync(process.env.MCP_START_MARKER, `started ${process.pid}\n`);
if (mode === "fail") {
  process.stderr.write(`startup failed ${process.env.API_TOKEN ?? ""}\n`);
  process.exit(1);
}
if (mode === "malformed") {
  process.stdout.write("not json\n");
  setTimeout(() => process.exit(1), 50);
} else
  serveStdio(() => {
    const server = new McpServer({
      name: "Chisel MCP integration fixture",
      version: "1.0.0",
    });
    if (mode === "large-schema")
      server.registerTool(
        "get_huge_schema",
        {
          description: "Read a record with an oversized schema",
          annotations: { readOnlyHint: true },
          inputSchema: z.object({
            value: z.string().describe("x".repeat(70 * 1024)),
          }),
        },
        async () => ({ content: [{ type: "text", text: "read" }] }),
      );
    if (mode === "input-required")
      server.registerTool(
        "get_input",
        { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async (_input, context) => {
          process.stderr.write(
            `Input-required fixture dispatched; modern envelope: ${Boolean(context.mcpReq.envelope)}\n`,
          );
          return inputRequired({ requestState: "pending" });
        },
      );
    server.registerTool(
      "get_note",
      {
        description:
          mode === "classification" ? "Delete remote records" : "Read a note",
        annotations: { readOnlyHint: true },
        inputSchema: z.object({ id: z.string() }),
      },
      async ({ id }) => ({ content: [{ type: "text", text: `note ${id}` }] }),
    );
    if (mode === "progress")
      server.registerTool(
        "get_progress",
        {
          description: "Read progress",
          inputSchema: z.object({}),
          annotations: { readOnlyHint: true },
        },
        async (_input, context) => {
          const token = context.mcpReq._meta?.progressToken;
          if (token !== undefined)
            await context.mcpReq.notify({
              method: "notifications/progress",
              params: {
                progressToken: token,
                progress: 42,
                total: 100,
                message: "Indexing events",
              },
            });
          return { content: [{ type: "text", text: "indexed" }] };
        },
      );
    server.registerTool(
      "create_note",
      {
        description: "Create a note",
        annotations: { readOnlyHint: false },
        inputSchema: z.object({ title: z.string() }),
      },
      async ({ title }) => ({
        content: [{ type: "text", text: `created ${title}` }],
      }),
    );
    server.registerTool(
      "delete_note",
      {
        description: "Delete a note",
        annotations: { readOnlyHint: true },
        inputSchema: z.object({ id: z.string() }),
      },
      async () => ({ content: [{ type: "text", text: "deleted" }] }),
    );
    server.registerTool(
      "get_large",
      {
        description: "Read a large result",
        annotations: { readOnlyHint: true },
        inputSchema: z.object({}),
      },
      async () => ({
        content: [
          {
            type: "text",
            text: Array.from(
              { length: 6000 },
              (_, i) => `row ${i}: payload for artifact storage`,
            ).join("\n"),
          },
        ],
      }),
    );
    server.registerTool(
      "get_secret_echo",
      {
        description: "Read an echo for credential leak tests",
        annotations: { readOnlyHint: true },
        inputSchema: z.object({}),
      },
      async () => ({
        content: [
          { type: "text", text: `echo ${process.env.API_TOKEN ?? "unset"}` },
        ],
        structuredContent: { authorization: process.env.API_TOKEN ?? "unset" },
      }),
    );
    server.registerTool(
      "get_slow",
      {
        description: "Read slowly",
        annotations: { readOnlyHint: true },
        inputSchema: z.object({}),
      },
      async (_args, context) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10_000);
          context.mcpReq.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              if (process.env.MCP_ABORT_MARKER)
                appendFileSync(process.env.MCP_ABORT_MARKER, "cancelled\n");
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
        return { content: [{ type: "text", text: "completed" }] };
      },
    );
    server.registerTool(
      "get_failure",
      {
        description: "Read failing data",
        annotations: { readOnlyHint: true },
        inputSchema: z.object({}),
      },
      async () => ({
        isError: true,
        content: [{ type: "text", text: "upstream failed" }],
      }),
    );
    server.registerTool(
      "crash",
      { description: "Terminate the fixture", inputSchema: z.object({}) },
      async () => {
        setTimeout(() => process.exit(7), 10);
        return { content: [{ type: "text", text: "exiting" }] };
      },
    );
    return server;
  });
