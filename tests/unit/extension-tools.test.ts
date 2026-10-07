import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalWorkspaceRoot } from "../../src/extensions/host.js";
import {
  type ChiselExtension,
  type ExtensionContext,
  ExtensionHost,
} from "../../src/extensions/index.js";
import { attachExtensionTools } from "../../src/extensions/tools.js";
import { ProviderToolNames } from "../../src/providers/tool-names.js";
import { ToolCatalog } from "../../src/tools/catalog.js";
import type { ToolHandler, ToolProvider } from "../../src/tools/types.js";
import { fixtureTool, toolExtension } from "../fixtures/tool-extension.js";

const roots: string[] = [];
const hosts: ExtensionHost[] = [];
afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const path = await canonicalWorkspaceRoot(
    await mkdtemp(join(tmpdir(), "chisel-tool-contributions-")),
  );
  roots.push(path);
  return path;
}
function host(definitions: readonly ChiselExtension[]) {
  const value = new ExtensionHost(definitions);
  hosts.push(value);
  return value;
}

test("staged tools publish only after complete activation; metadata and callable references are stable", async () => {
  const tool = fixtureTool();
  const originalPrepare = tool.prepare;
  let entered!: () => void;
  const start = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let context!: ExtensionContext;
  const h = host([
    {
      id: "vendor/a",
      async activate(ctx) {
        context = ctx;
        ctx.tools.register(tool);
        entered();
        await ready;
      },
    },
  ]);
  const pending = h.open(await root());
  await start;
  tool.spec.name = "changed";
  tool.spec.effect = "workspace_write";
  tool.spec.inputSchema.type = "array";
  tool.prepare = async () => {
    throw new Error("Changed function must never be called");
  };
  finish();
  const scope = await pending;
  const catalog = new ToolCatalog();
  const binding = await attachExtensionTools(scope, catalog);
  const stored = catalog.get("ext:vendor/a:inspect");
  expect(stored.spec.effect).toBe("read");
  expect(stored.spec.inputSchema.type).toBe("object");
  expect(stored.spec.source).toEqual({
    type: "extension",
    extensionId: "vendor/a",
    originalName: "inspect",
  });
  expect(stored.prepare).not.toBe(originalPrepare);
  expect(() => context.tools.register(fixtureTool("late"))).toThrow("vendor/a");
  await Promise.all([binding.dispose(), binding.dispose()]);
  expect(() => catalog.get(stored.spec.name)).toThrow("Unknown tool");
  expect(await scope.tools.listTools()).toHaveLength(1);
  await scope.dispose();
  expect(() => context.tools.register(fixtureTool("later"))).toThrow(
    "vendor/a",
  );
  await expect(attachExtensionTools(scope, catalog)).rejects.toThrow(
    "not available",
  );
});

test("duplicate local names roll back all owners and reopening retries a fresh activation", async () => {
  const cleaned: string[] = [];
  let fail = true;
  const path = await root();
  const h = host([
    {
      id: "A",
      activate(ctx) {
        ctx.add({
          dispose: () => {
            cleaned.push("A");
          },
        });
        ctx.tools.register(fixtureTool());
      },
    },
    {
      id: "B",
      activate(ctx) {
        ctx.add({
          dispose: () => {
            cleaned.push("B");
          },
        });
        ctx.tools.register(fixtureTool());
        if (fail) ctx.tools.register(fixtureTool());
      },
    },
  ]);
  await expect(h.open(path)).rejects.toMatchObject({ extensionId: "B" });
  expect(cleaned).toEqual(["B", "A"]);
  fail = false;
  const scope = await h.open(path);
  expect((await scope.tools.listTools()).map((tool) => tool.name)).toEqual([
    "ext:A:inspect",
    "ext:B:inspect",
  ]);
  const alias = join(await root(), "alias");
  await symlink(path, alias, process.platform === "win32" ? "junction" : "dir");
  expect(await h.open(alias)).toBe(scope);
  expect(await h.open(await root())).not.toBe(scope);
});

for (const corrupt of [
  (tool: ReturnType<typeof fixtureTool>) => {
    tool.spec.name = "read/file";
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    tool.spec.description = " ";
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    Object.assign(tool.spec, { effect: "unknown" });
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    tool.spec.permission = "";
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    Object.assign(tool.spec, { parallelSafe: 1 });
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    tool.spec.workspaceAccess = "write";
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    Object.assign(tool.spec, { workspaceAccess: "other" });
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    tool.spec.timeoutMs = Infinity;
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    tool.spec.outputPolicy = { maxInlineTokens: 0 };
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    tool.spec.inputSchema = { type: "object", bad: () => {} };
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    tool.spec.inputSchema = { type: "array" };
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    tool.spec.inputSchema = {
      type: "object",
      properties: { path: { type: 42 } },
    };
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    Object.assign(tool.spec, { source: { type: "local" } });
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    Object.assign(tool.spec, { guidance: "INJECT_SYSTEM" });
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    Object.assign(tool, { permissions: () => ({ default: "allow" }) });
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    Object.assign(tool, { rememberApproval: () => {} });
  },
  (tool: ReturnType<typeof fixtureTool>) => {
    Object.assign(tool, { execute: 42 });
  },
])
  test(`invalid contribution ${corrupt.toString().slice(0, 110)} is attributed and cannot publish`, async () => {
    const tool = fixtureTool();
    corrupt(tool);
    await expect(
      host([toolExtension("invalid", [tool])]).open(await root()),
    ).rejects.toMatchObject({ extensionId: "invalid" });
  });

test("namespaces preserve owner identity and wire mapping is collision-safe including history", async () => {
  const owners = ["vendor/a", "vendor_a", "vendor.a", "Vendor/A"];
  const scope = await host(
    owners.map((id) => toolExtension(id, [fixtureTool("manifest")])),
  ).open(await root());
  const catalog = new ToolCatalog();
  await attachExtensionTools(scope, catalog);
  const tools = catalog.selectForTurn();
  expect(new Set(tools.map((tool) => tool.name)).size).toBe(4);
  const names = new ProviderToolNames(tools, []);
  for (const tool of tools) {
    expect(names.wire(tool.name)).toMatch(/^ext_[A-Za-z0-9_-]{1,60}$/);
    expect(names.domain(names.wire(tool.name))).toBe(tool.name);
  }
  const history = new ProviderToolNames(
    [],
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "old",
            name: tools[0]?.name ?? "",
            input: {},
          },
        ],
      },
    ],
  );
  expect(history.wire(tools[0]?.name ?? "")).toBe(
    names.wire(tools[0]?.name ?? ""),
  );
  const collision = {
    ...tools[0],
    name: names.wire(tools[0]?.name ?? ""),
  } as (typeof tools)[number];
  expect(() => new ProviderToolNames([...tools, collision], [])).toThrow(
    "collision",
  );
});

test("atomic catalog replacement preserves handlers, explicit selection and retired MCP state on every failure", async () => {
  const catalog = new ToolCatalog();
  const old = {
    ...fixtureTool("old"),
    spec: { ...fixtureTool("old").spec, source: { type: "local" as const } },
  } as ToolHandler;
  const other = { ...old, spec: { ...old.spec, name: "other" } };
  catalog.register(other);
  const provider = (handlers: ToolHandler[]): ToolProvider => ({
    listTools: async () => handlers.map((handler) => handler.spec),
    getHandler: async (name) =>
      handlers.find((handler) => handler.spec.name === name) ?? old,
  });
  await catalog.replaceProvider("fixture", provider([old]));
  catalog.include(["old"]);
  const before = catalog.selectForTurn();
  const bad: ToolProvider[] = [
    provider([old, old]),
    provider([other]),
    {
      listTools: async () => [{ ...old.spec, name: "different" }],
      getHandler: async () => old,
    },
    {
      listTools: async () => {
        throw new Error("listing");
      },
      getHandler: async () => old,
    },
    {
      listTools: async () => [old.spec],
      getHandler: async () => {
        throw new Error("handler");
      },
    },
  ];
  for (const incoming of bad) {
    await expect(
      catalog.replaceProvider("fixture", incoming),
    ).rejects.toThrow();
    expect(catalog.get("old")).toBe(old);
    expect(catalog.get("other")).toBe(other);
    expect(catalog.selectForTurn()).toEqual(before);
  }
  await catalog.replaceProvider("fixture");
  expect(() => catalog.get("old")).toThrow("Unknown tool");
  expect(catalog.get("other")).toBe(other);
});

test("extension attachment collision is atomic and extensions cannot become native guidance", async () => {
  const scope = await host([
    toolExtension("fixture", [fixtureTool("a"), fixtureTool("b")]),
  ]).open(await root());
  const catalog = new ToolCatalog();
  const conflict = {
    ...fixtureTool(),
    spec: { ...fixtureTool().spec, name: "ext:fixture:b" },
  } as ToolHandler;
  catalog.register(conflict);
  await expect(attachExtensionTools(scope, catalog)).rejects.toThrow("fixture");
  expect(catalog.get("ext:fixture:b")).toBe(conflict);
  expect(() => catalog.get("ext:fixture:a")).toThrow();
  catalog.register({
    ...conflict,
    spec: {
      ...conflict.spec,
      name: "ext:other:inject",
      source: {
        type: "extension",
        extensionId: "other",
        originalName: "inject",
      },
      guidance: "INJECT_SYSTEM",
    },
  });
  expect(catalog.instructionsForTurn(catalog.selectForTurn())).toBe("");
});

test("concurrent attachment cannot replace another binding; later provider conflicts leave extension snapshot live", async () => {
  const scope = await host([toolExtension("fixture", [fixtureTool()])]).open(
    await root(),
  );
  const catalog = new ToolCatalog();
  const attempts = await Promise.allSettled([
    attachExtensionTools(scope, catalog),
    attachExtensionTools(scope, catalog),
  ]);
  expect(
    attempts.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const original = catalog.get("ext:fixture:inspect");
  const conflict = {
    ...original,
    spec: {
      ...original.spec,
      source: {
        type: "mcp" as const,
        serverId: "server",
        serverTitle: "Server",
        originalName: "inspect",
        category: "read" as const,
        classificationReason: "fixture",
      },
    },
  };
  await expect(
    catalog.replaceProvider("mcp:server", {
      listTools: async () => [conflict.spec],
      getHandler: async () => conflict,
    }),
  ).rejects.toThrow("Duplicate tool");
  expect(catalog.get(original.spec.name)).toBe(original);
  expect(catalog.hasProvider("mcp:server")).toBe(false);
});
