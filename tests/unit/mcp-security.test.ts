import { describe, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/client";
import { classifyMcpTool } from "../../src/mcp/classification.js";
import { parseMcpCommand } from "../../src/mcp/command.js";
import { McpRedactor } from "../../src/mcp/redaction.js";
import type { McpPermissions } from "../../src/mcp/schema.js";
import {
  DEFAULT_MCP_PERMISSIONS,
  McpServerSchema,
} from "../../src/mcp/schema.js";
import { ProviderToolNames } from "../../src/providers/tool-names.js";
import { allowsToolInMode } from "../../src/runtime/agent-mode.js";
import type { ApprovalRequest } from "../../src/security/approval.js";
import { PermissionPolicy } from "../../src/security/permission-policy.js";

function classify(
  name: string,
  annotations?: Tool["annotations"],
  properties: NonNullable<Tool["inputSchema"]["properties"]> = {},
) {
  return classifyMcpTool({
    name,
    annotations,
    inputSchema: { type: "object", properties },
  });
}
describe("MCP classification and Plan boundaries", () => {
  test("a harmless tool name cannot hide a destructive title or executable nested arguments", () => {
    const destructive = classifyMcpTool({
      name: "get_record",
      title: "Delete remote record",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { type: "object", properties: {} },
    });
    expect(destructive.effect).toBe("external_destructive");
    const nested = classifyMcpTool({
      name: "get_record",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          payload: { type: "object", properties: { sql: { type: "string" } } },
        },
      },
    });
    expect(nested.category).toBe("unknown");
    expect(allowsToolInMode("plan", nested.effect)).toBe(false);
  });
  for (const name of [
    "search_code",
    "get_issue",
    "list_projects",
    "read_document",
  ])
    test(`${name} is external read and Plan permits it`, () => {
      const result = classify(name, { readOnlyHint: true });
      expect(result.effect).toBe("external_read");
      expect(allowsToolInMode("plan", result.effect)).toBe(true);
    });
  for (const name of [
    "create_issue",
    "comment_issue",
    "update_document",
    "send_email",
  ])
    test(`${name} cannot claim read-only`, () => {
      const result = classify(name, {
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(result.effect).toBe("external_write");
      expect(allowsToolInMode("plan", result.effect)).toBe(false);
    });
  for (const name of [
    "merge_pull_request",
    "delete_record",
    "drop_table",
    "revoke_token",
  ])
    test(`${name} is destructive regardless of annotations`, () => {
      expect(
        classify(name, { readOnlyHint: true, destructiveHint: false }).effect,
      ).toBe("external_destructive");
    });
  for (const name of [
    "query",
    "postgres_query",
    "graphql_request",
    "browser_navigate",
    "arbitrary_thing",
  ])
    test(`${name} is ambiguous and never permitted in Plan`, () => {
      const result = classify(name, { readOnlyHint: true });
      expect(result.category).toBe("unknown");
      expect(allowsToolInMode("plan", result.effect)).toBe(false);
    });
  test("search text query is read, arbitrary SQL and execution are not", () => {
    expect(
      classify(
        "search_code",
        { readOnlyHint: true },
        { query: { type: "string" } },
      ).effect,
    ).toBe("external_read");
    expect(
      classify("get_data", { readOnlyHint: true }, { sql: { type: "string" } })
        .category,
    ).toBe("unknown");
    expect(classify("execute_command", { readOnlyHint: true }).effect).toBe(
      "process",
    );
    expect(classify("get_data", { readOnlyHint: false }).category).toBe(
      "unknown",
    );
    expect(classify("get_data", { destructiveHint: true }).effect).toBe(
      "external_destructive",
    );
  });
});
function policy(
  mode: "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" = "default",
  allowed = new Set<string>(),
) {
  return new PermissionPolicy(
    {
      allowedCommands: [],
      deniedCommands: [],
      ignorePatterns: [],
      autoApprove: false,
    },
    {
      approvalMode: mode,
      allowBypassPermissions: mode === "bypassPermissions",
      autoApprove: false,
      allowedTools: allowed,
      nonInteractive: false,
    },
  );
}
function request(
  category: "read" | "write" | "destructive" | "unknown",
  rules: McpPermissions = DEFAULT_MCP_PERMISSIONS,
): ApprovalRequest {
  return {
    tool: "github.action",
    preview: "action",
    mcp: {
      serverId: "github",
      serverTitle: "GitHub",
      originalName: "action",
      title: "Action",
      category,
      fields: [],
      consequence: "external",
      destructive: category === "destructive",
    },
    mcpPermissions: rules,
  };
}
describe("MCP permission precedence", () => {
  test("safe categories, unknown ASK, Accept edits does not broaden external writes", () => {
    expect(policy().decide(request("read"), "external_read")).toBe("allow");
    for (const category of ["write", "destructive", "unknown"] as const)
      expect(
        policy("acceptEdits").decide(request(category), "external_write"),
      ).toBe("ask");
    expect(
      policy().decide(
        request("read", { categories: {}, tools: {} }),
        "external_read",
      ),
    ).toBe("ask");
  });
  test("every deny beats tool allow, --allow and Bypass", () => {
    const denied: McpPermissions[] = [
      {
        default: "deny",
        categories: { write: "allow" },
        tools: { action: "allow" },
      },
      {
        default: "allow",
        categories: { write: "deny" },
        tools: { action: "allow" },
      },
      {
        default: "allow",
        categories: { write: "allow" },
        tools: { action: "deny" },
      },
    ];
    for (const rules of denied)
      expect(
        policy("bypassPermissions", new Set(["github.action"])).decide(
          request("write", rules),
          "external_write",
        ),
      ).toBe("deny");
  });
  test("tool → category → server → ASK; Dont ask only permits authorized rules", () => {
    expect(
      policy().decide(
        request("write", {
          default: "ask",
          categories: { write: "ask" },
          tools: { action: "allow" },
        }),
        "external_write",
      ),
    ).toBe("allow");
    expect(
      policy().decide(
        request("write", {
          default: "allow",
          categories: { write: "ask" },
          tools: {},
        }),
        "external_write",
      ),
    ).toBe("ask");
    expect(
      policy().decide(
        request("write", { default: "allow", categories: {}, tools: {} }),
        "external_write",
      ),
    ).toBe("allow");
    expect(policy("dontAsk").decide(request("write"), "external_write")).toBe(
      "deny",
    );
    expect(policy("dontAsk").decide(request("read"), "external_read")).toBe(
      "allow",
    );
    expect(
      policy("bypassPermissions").decide(request("write"), "external_write"),
    ).toBe("allow");
  });
});
test("config rejects raw credentials and unsafe endpoints, retains explicit versions", () => {
  const base = {
    transport: {
      type: "stdio" as const,
      command: "npx",
      args: ["-y", "@org/mcp@1.2.3"],
    },
  };
  expect(McpServerSchema.parse(base).transport).toEqual(base.transport);
  expect(
    McpServerSchema.safeParse({
      ...base,
      env: { API_TOKEN: { literal: "raw" } },
    }).success,
  ).toBe(false);
  expect(
    McpServerSchema.safeParse({
      ...base,
      env: {
        DATABASE_URL: { secretRef: "mcp/postgres/url" },
        REGION: { literal: "us-east-1" },
      },
    }).success,
  ).toBe(true);
  for (const url of [
    "http://example.com/mcp",
    "https://user:password@example.com/mcp",
    "https://example.com/mcp?api_key=raw",
  ])
    expect(
      McpServerSchema.safeParse({ transport: { type: "http", url } }).success,
    ).toBe(false);
  expect(
    McpServerSchema.safeParse({
      transport: { type: "http", url: "http://localhost:1234/mcp" },
    }).success,
  ).toBe(true);
  expect(
    McpServerSchema.safeParse({
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: { literal: "raw" } },
      },
    }).success,
  ).toBe(false);
  expect(
    McpServerSchema.safeParse({
      transport: { type: "stdio", command: "npx", args: ["--api-key=raw"] },
    }).success,
  ).toBe(false);
});
test("commands are argv, retain quoted Windows paths and reject shell operators", () => {
  expect(
    parseMcpCommand(
      '"C:\\Program Files\\node.exe" "C:\\servers\\mcp.js" --region us',
    ),
  ).toEqual({
    command: "C:\\Program Files\\node.exe",
    args: ["C:\\servers\\mcp.js", "--region", "us"],
  });
  expect(parseMcpCommand("npx -y @org/mcp@1.2.3").args).toEqual([
    "-y",
    "@org/mcp@1.2.3",
  ]);
  expect(() => parseMcpCommand("npx server && curl bad")).toThrow();
  expect(() => parseMcpCommand('npx "unterminated')).toThrow();
});
test("provider wire aliases are stable, bounded, collision-free and do not mutate session names", () => {
  const names = [
    "read_file",
    "github.get_issue",
    "postgres.get_issue",
    `aws.${"long_tool_".repeat(9)}`,
  ];
  const tools = names.map((name) => ({
    name,
    description: name,
    inputSchema: {},
    requiresApproval: true,
  }));
  const mapper = new ProviderToolNames(tools, []);
  expect(new Set(mapper.tools(tools).map((tool) => tool.name)).size).toBe(
    names.length,
  );
  for (const name of names) {
    expect(mapper.wire(name)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(mapper.domain(mapper.wire(name))).toBe(name);
  }
  expect(mapper.wire("read_file")).toBe("read_file");
  expect(tools[1]?.name).toBe("github.get_issue");
});
test("redaction removes secret variants, sensitive keys and terminal control sequences", () => {
  const redactor = new McpRedactor();
  const secret = "private/value-123";
  redactor.add(secret);
  const output = redactor.value({
    text: `${secret} ${encodeURIComponent(secret)} ${Buffer.from(secret).toString("base64")} \u001b[31mraw`,
    authorization: "other-secret",
    url: "https://user:password@example.com/?token=unknown",
  });
  expect(JSON.stringify(output)).not.toContain(secret);
  expect(JSON.stringify(output)).not.toContain("other-secret");
  expect(output.text).not.toContain("\u001b");
  expect(output.url).not.toContain("password");
  expect(
    redactor.value({
      API_TOKEN: "unknown-token",
      token: "other-token",
      url: "https://example.com/?signature=private-signature",
    }),
  ).toEqual({
    API_TOKEN: "[секрет скрыт]",
    token: "[секрет скрыт]",
    url: "https://example.com/?signature=%5B%D1%81%D0%B5%D0%BA%D1%80%D0%B5%D1%82+%D1%81%D0%BA%D1%80%D1%8B%D1%82%5D",
  });
});
test("stdio arguments cannot persist credential URLs or inline secret assignments", () => {
  for (const args of [
    ["postgres://user:password@localhost/database"],
    ["API_KEY=private"],
    ["https://example.com/?key=private"],
    ["Authorization: Bearer private"],
  ])
    expect(
      McpServerSchema.safeParse({
        transport: { type: "stdio", command: "node", args },
      }).success,
    ).toBe(false);
  expect(
    McpServerSchema.safeParse({
      label: "bad\u001b]52;c;clipboard\u0007",
      transport: { type: "stdio", command: "node" },
    }).success,
  ).toBe(false);
});
