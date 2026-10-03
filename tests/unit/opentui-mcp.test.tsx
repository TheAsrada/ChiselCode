/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { OpenTuiMcpActions } from "../../src/mcp/controller.js";
import type { McpServerStatus } from "../../src/mcp/manager.js";
import {
  DEFAULT_MCP_PERMISSIONS,
  McpServerSchema,
} from "../../src/mcp/schema.js";
import { OpenTuiApproval } from "../../src/ui/opentui-approval.js";
import { OpenTuiMcp } from "../../src/ui/opentui-mcp.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

function actions(withServer = true) {
  const servers: McpServerStatus[] = withServer
    ? [
        {
          id: "github",
          label: "GitHub",
          scope: "global",
          enabled: true,
          trusted: true,
          state: "connected",
          transport: "http",
          toolsCount: 24,
          restartAttempts: 0,
          latencyMs: 182,
          info: {
            protocolVersion: "2026-07-28",
            capabilities: {
              tools: true,
              resources: false,
              prompts: false,
              tasks: false,
            },
          },
        },
      ]
    : [];
  const calls: Array<{ kind: string; data: unknown }> = [];
  const entry = {
    id: "github",
    scope: "global" as const,
    projectRoot: "/project",
    fingerprint: "a".repeat(64),
    trusted: true,
    config: McpServerSchema.parse({
      label: "GitHub",
      transport: { type: "http", url: "https://example.com/mcp" },
      permissions: DEFAULT_MCP_PERMISSIONS,
    }),
    permissions: structuredClone(DEFAULT_MCP_PERMISSIONS),
  };
  const api: OpenTuiMcpActions = {
    load: async () => {},
    subscribe: () => () => {},
    servers: () => servers,
    entry: () => entry,
    tools: () => [
      {
        tool: {
          name: "search_code",
          title: "Search code",
          description: "Search code in repositories",
          inputSchema: { type: "object", properties: {} },
        },
        classification: {
          effect: "external_read",
          category: "read",
          reason: "Read-only search",
        },
        fingerprint: "t",
      },
    ],
    logs: () => [
      {
        timestamp: "2026-10-03T12:00:00Z",
        level: "error",
        message: "Connection failed: executable not found",
      },
    ],
    connect: async () => {},
    disconnect: async () => {},
    enable: async () => {},
    remove: async () => {},
    trust: async () => {},
    authenticate: async () => {},
    permissions: async (_id, value) => {
      entry.permissions = value;
      calls.push({ kind: "permissions", data: value });
    },
    doctor: async () => [],
    test: async (draft) => {
      calls.push({ kind: "test", data: draft });
      return {
        server: {
          id: draft.id,
          label: draft.id,
          scope: draft.scope,
          enabled: true,
          trusted: true,
          state: "connected",
          transport: draft.config.transport.type,
          toolsCount: 12,
          restartAttempts: 0,
          latencyMs: 77,
          info: {
            protocolVersion: "2026-07-28",
            capabilities: {
              tools: true,
              resources: false,
              prompts: false,
              tasks: false,
            },
          },
        },
        tools: [],
        logs: [],
      };
    },
    save: async (draft, value) => {
      calls.push({ kind: "save", data: { draft, value } });
      servers.push({
        id: draft.id,
        label: draft.id,
        scope: "global",
        enabled: true,
        trusted: true,
        state: "connected",
        transport: draft.config.transport.type,
        toolsCount: 12,
        restartAttempts: 0,
      });
    },
    discard: async () => {},
  };
  return { api, calls, servers, entry };
}
type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
  });
}
async function press(setup: Setup, key: string) {
  await act(async () => {
    setup.mockInput.pressKey(
      key === "DOWN" ? "ARROW_DOWN" : key === "UP" ? "ARROW_UP" : key,
    );
    if (key === "ESCAPE") await Bun.sleep(120);
  });
  await frame(setup);
}
async function type(setup: Setup, text: string) {
  await act(async () => {
    await setup.mockInput.typeText(text);
  });
  await frame(setup);
}
function destroy(setup: Setup) {
  act(() => setup.renderer.destroy());
}

test("/mcp opens a native popup, preserves the conversation and shows server health", async () => {
  const { api } = actions();
  const workspace = new TuiWorkspace("/project");
  workspace.controller.append("Conversation stays visible", "assistant");
  const submitted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      onExit={() => {}}
      onSubmit={async (input) => {
        submitted.push(input);
      }}
      getMcpActions={() => api}
    />,
    { width: 100, height: 30, exitOnCtrlC: false },
  );
  try {
    await frame(setup);
    await type(setup, "/mcp");
    await press(setup, "RETURN");
    const view = setup.captureCharFrame();
    expect(view).toContain("Центр подключений");
    expect(view).toContain("GitHub");
    expect(view).toContain("Подключён");
    expect(view).toContain("24 tools");
    expect(submitted).toEqual([]);
    expect(workspace.controller.snapshot.overlay).toBe("mcp");
    await press(setup, "ESCAPE");
    expect(workspace.controller.snapshot.overlay).toBeUndefined();
  } finally {
    destroy(setup);
    workspace.dispose();
  }
});
for (const [width, height] of [
  [24, 8],
  [40, 12],
  [60, 16],
])
  test(`MCP popup fits compact ${width}x${height}`, async () => {
    const { api } = actions();
    const setup = await testRender(
      <OpenTuiMcp
        actions={api}
        width={width ?? 40}
        height={height ?? 12}
        onClose={() => {}}
      />,
      { width, height },
    );
    try {
      await frame(setup);
      const view = setup.captureCharFrame();
      expect(view).toContain("MCP");
      expect(view).toContain("GitHub");
      expect(view).toContain("Добавить");
      expect(view.split("\n").length).toBeLessThanOrEqual((height ?? 12) + 1);
    } finally {
      destroy(setup);
    }
  });
test("URL onboarding tests before saving and offers separate category permissions", async () => {
  const { api, calls } = actions(false);
  const setup = await testRender(
    <OpenTuiMcp actions={api} width={100} height={30} onClose={() => {}} />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    await press(setup, "RETURN");
    expect(setup.captureCharFrame()).toContain("Вставить URL");
    await press(setup, "RETURN");
    await press(setup, "RETURN");
    await type(setup, "sentry");
    await press(setup, "RETURN");
    await press(setup, "DOWN");
    await press(setup, "RETURN");
    await type(setup, "https://example.com/mcp");
    await press(setup, "RETURN");
    for (let i = 0; i < 4; i++) await press(setup, "DOWN");
    await press(setup, "RETURN");
    await frame(setup);
    if (!calls.some((call) => call.kind === "test"))
      throw new Error(setup.captureCharFrame());
    expect(calls.filter((call) => call.kind === "test")).toHaveLength(1);
    expect(calls.filter((call) => call.kind === "save")).toHaveLength(0);
    const view = setup.captureCharFrame();
    expect(view).toContain("Подключение проверено");
    expect(view).toContain("12 tools");
    expect(view).toContain("Внешняя запись");
    expect(view).toContain("Спрашивать");
    await act(async () => {
      setup.mockInput.pressKey("s", { ctrl: true });
    });
    await frame(setup);
    expect(calls.filter((call) => call.kind === "save")).toHaveLength(1);
  } finally {
    destroy(setup);
  }
});
test("project trust shows the exact command and requires an explicit confirmation", async () => {
  const { api, servers, entry } = actions();
  const command = "npx -y @playwright/mcp@1.2.3";
  Object.assign(servers[0] ?? {}, {
    id: "playwright",
    label: "Playwright",
    scope: "project",
    trusted: false,
    state: "disconnected",
    toolsCount: 0,
    transport: "stdio",
    info: undefined,
  });
  api.entry = () => ({
    ...entry,
    id: "playwright",
    scope: "project",
    trusted: false,
    config: McpServerSchema.parse({
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@1.2.3"],
      },
      env: { API_TOKEN: { envRef: "CHISEL_MCP_TOKEN" } },
      permissions: DEFAULT_MCP_PERMISSIONS,
    }),
  });
  const calls: Array<{ kind: string; id: string; fingerprint?: string }> = [];
  api.connect = async (id) => {
    calls.push({ kind: "connect", id });
  };
  api.trust = async (id, fingerprint) => {
    calls.push({ kind: "trust", id, fingerprint });
  };
  const setup = await testRender(
    <OpenTuiMcp actions={api} width={100} height={30} onClose={() => {}} />,
    { width: 100, height: 30, exitOnCtrlC: false },
  );
  try {
    await frame(setup);
    await press(setup, "RETURN");
    await press(setup, "RETURN");
    const view = setup.captureCharFrame();
    expect(view).toContain("Доверие к серверу проекта");
    expect(view).toContain(command);
    expect(view).toContain("с вашими правами");
    expect(view).toContain("CHISEL_MCP_TOKEN");
    expect(calls).toEqual([]);
    await act(async () => {
      setup.mockInput.pressKey("c", { ctrl: true });
    });
    await frame(setup);
    expect(calls).toEqual([]);
    expect(setup.captureCharFrame()).toContain(command);
    await press(setup, "RETURN");
    expect(calls).toEqual([
      { kind: "trust", id: "playwright", fingerprint: entry.fingerprint },
      { kind: "connect", id: "playwright" },
    ]);
  } finally {
    destroy(setup);
  }
});
test("server details, tool classification, permission editor and safe error diagnostics", async () => {
  const { api, calls } = actions();
  const setup = await testRender(
    <OpenTuiMcp actions={api} width={100} height={30} onClose={() => {}} />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    await press(setup, "RETURN");
    expect(setup.captureCharFrame()).toContain("182 мс");
    await press(setup, "DOWN");
    await press(setup, "RETURN");
    expect(setup.captureCharFrame()).toContain("Search code");
    await press(setup, "RETURN");
    expect(setup.captureCharFrame()).toContain("external_read");
    await press(setup, "ESCAPE");
    await press(setup, "ESCAPE");
    await press(setup, "DOWN");
    await press(setup, "DOWN");
    await press(setup, "RETURN");
    expect(setup.captureCharFrame()).toContain("Разрушительные действия");
    await press(setup, "RETURN");
    const view = setup.captureCharFrame().split("\n");
    const y = view.findIndex((line) => line.includes("Сохранить"));
    await act(async () => {
      await setup.mockMouse.click((view[y]?.indexOf("Сохранить") ?? 0) + 1, y);
    });
    await frame(setup);
    expect(calls[0]?.kind).toBe("permissions");
    for (let i = 0; i < 4; i++) await press(setup, "DOWN");
    await press(setup, "RETURN");
    expect(setup.captureCharFrame()).toContain("executable not found");
  } finally {
    destroy(setup);
  }
});
test("MCP approval is readable, names the resource and never offers blanket server allow", async () => {
  let once = 0,
    always = 0;
  const setup = await testRender(
    <OpenTuiApproval
      width={100}
      height={28}
      request={{
        tool: "github.create_issue",
        preview: "",
        mcp: {
          serverId: "github",
          serverTitle: "GitHub",
          originalName: "create_issue",
          title: "Create issue",
          category: "write",
          destructive: false,
          fields: [
            { label: "Repository", value: "TheAsrada/ChiselCode" },
            { label: "Title", value: "Improve MCP" },
          ],
          consequence: "Создаёт внешние данные.",
        },
      }}
      onApprove={() => {
        once++;
      }}
      onAlwaysApprove={() => {
        always++;
      }}
    />,
    { width: 100, height: 28 },
  );
  try {
    await frame(setup);
    const view = setup.captureCharFrame();
    expect(view).toContain("GitHub");
    expect(view).toContain("TheAsrada/ChiselCode");
    expect(view).toContain("Всегда этот tool");
    expect(view).not.toContain('"repository"');
    const rows = view.split("\n");
    const y = rows.findIndex((row) => row.includes("Всегда этот tool"));
    await act(async () => {
      await setup.mockMouse.click(
        (rows[y]?.indexOf("Всегда этот tool") ?? 0) + 1,
        y,
      );
    });
    expect(always).toBe(1);
    expect(once).toBe(0);
  } finally {
    destroy(setup);
  }
});
