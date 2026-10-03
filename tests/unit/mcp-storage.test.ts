import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalConfig, loadProjectConfig } from "../../src/config/load.js";
import { readMcpConfig } from "../../src/mcp/configuration.js";
import { diagnoseMcp } from "../../src/mcp/doctor.js";
import { McpConnectionManager } from "../../src/mcp/manager.js";
import {
  DEFAULT_MCP_PERMISSIONS,
  McpServerSchema,
} from "../../src/mcp/schema.js";
import { McpConfigStore, type McpServerEntry } from "../../src/mcp/storage.js";
import { CredentialStore } from "../../src/security/credentials.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "chisel-mcp-storage-"));
  roots.push(root);
  const store = new McpConfigStore(root, {
    globalPath: join(root, "config.json"),
  });
  return { root, store };
}
const config = {
  transport: { type: "stdio", command: "node", args: ["server.js"] },
  permissions: DEFAULT_MCP_PERMISSIONS,
};
function requiredEntry(
  entries: McpServerEntry[],
  scope?: "global" | "project",
) {
  const entry = entries.find(
    (item) => item.id === "approval" && (!scope || item.scope === scope),
  );
  if (!entry) throw new Error(`Approval server missing: ${scope ?? "any"}`);
  return entry;
}
test("invalid MCP server is diagnosed without rejecting the valid catalog or local configuration", async () => {
  const { root, store } = await setup();
  const secret = "private-value-in-invalid-config";
  const raw = {
    providers: {},
    mcp: {
      schemaVersion: 1,
      servers: {
        valid: { ...config, enabled: false },
        invalid: { ...config, env: { API_KEY: { literal: secret } } },
      },
    },
  };
  await writeFile(store.globalPath, JSON.stringify(raw));
  const loaded = await loadGlobalConfig(store.globalPath);
  expect(Object.keys(loaded.mcp?.servers ?? {})).toEqual(["valid"]);
  expect(loaded.mcpDiagnostics?.[0]?.id).toBe("invalid");
  expect(JSON.stringify(loaded.mcpDiagnostics)).not.toContain(secret);
  expect(JSON.stringify(loaded)).not.toContain("mcpDiagnostics");
  const manager = new McpConnectionManager(store);
  try {
    await manager.reload();
    expect(manager.list().map((server) => server.state)).toEqual([
      "disabled",
      "error",
    ]);
    const reports = await diagnoseMcp(manager);
    expect(reports.find((report) => report.id === "valid")?.ok).toBe(true);
    expect(reports.find((report) => report.id === "invalid")?.ok).toBe(false);
    expect(JSON.stringify(reports)).not.toContain(secret);
    await expect(store.save("new", config)).rejects.toBeInstanceOf(Error);
    expect(JSON.parse(await readFile(store.globalPath, "utf8"))).toEqual(raw);
  } finally {
    await manager.dispose();
  }
  await writeFile(join(root, ".chiselrc"), JSON.stringify({ mcp: raw.mcp }));
  expect((await loadProjectConfig(root)).allowedCommands).toEqual([]);
  await expect(store.save("new", config, "project")).rejects.toBeInstanceOf(
    Error,
  );
});
test("corrupt project trust fails closed while global MCP configuration remains usable", async () => {
  const { store } = await setup();
  await store.save("global", config);
  await store.save("project", config, "project");
  await writeFile(store.trustPath, "invalid-trust");
  const entries = await store.load();
  expect(entries.find((entry) => entry.id === "global")?.trusted).toBe(true);
  expect(entries.find((entry) => entry.id === "project")?.trusted).toBe(false);
  expect(
    store.diagnostics.some((diagnostic) => diagnostic.id === "project-trust"),
  ).toBe(true);
  const project = entries.find((entry) => entry.id === "project");
  if (!project) throw new Error("Project missing");
  await expect(
    store.trust(project, DEFAULT_MCP_PERMISSIONS),
  ).rejects.toBeInstanceOf(Error);
  expect(await readFile(store.trustPath, "utf8")).toBe("invalid-trust");
});
test("global server cannot be replaced by a project and repository allows do not grant user permissions", async () => {
  const { store } = await setup();
  await store.save("github", config);
  await store.save(
    "github",
    { ...config, transport: { type: "stdio", command: "evil" } },
    "project",
  );
  await store.save(
    "repository",
    {
      ...config,
      permissions: {
        default: "allow",
        categories: { destructive: "deny" },
        tools: { create_issue: "allow", merge_pull_request: "deny" },
      },
    },
    "project",
  );
  const entries = await store.load();
  expect(
    entries.find((entry) => entry.id === "github")?.config.transport,
  ).toMatchObject({ command: "node" });
  const project = entries.find((entry) => entry.id === "repository");
  expect(project?.permissions.tools.create_issue).toBeUndefined();
  expect(project?.permissions.tools.merge_pull_request).toBe("deny");
  expect(project?.permissions.default).toBeUndefined();
  if (!project) throw new Error("Project missing");
  await store.trust(project, DEFAULT_MCP_PERMISSIONS);
  expect(
    (await store.load()).find((entry) => entry.id === "repository")?.permissions
      .categories.destructive,
  ).toBe("deny");
});
test("trust fingerprint is invalidated by cwd, environment references, permissions and HTTP credentials", async () => {
  const { store } = await setup();
  await store.save("project", config, "project");
  const original = (await store.load())[0];
  if (!original) throw new Error("Project missing");
  await store.trust(original, DEFAULT_MCP_PERMISSIONS);
  expect((await store.load())[0]?.trusted).toBe(true);
  for (const update of [
    { transport: { ...config.transport, cwd: "changed" } },
    { env: { API_KEY: { secretRef: "changed" } } },
    { permissions: { default: "allow" } },
    {
      transport: { type: "http", url: "https://example.com/mcp" },
      auth: { token: { envRef: "API_TOKEN" } },
    },
  ]) {
    await store.save("project", { ...config, ...update }, "project");
    expect((await store.load())[0]?.trusted).toBe(false);
    await expect(
      store.trust(original, DEFAULT_MCP_PERMISSIONS),
    ).rejects.toBeInstanceOf(Error);
  }
});
test("credential writes are encrypted, atomic and serialized across store instances", async () => {
  const { root } = await setup();
  const first = new CredentialStore(root),
    second = new CredentialStore(root);
  await Promise.all([
    first.set("mcp/one", "unique-secret-one"),
    second.set("mcp/two", "unique-secret-two"),
    first.set("provider", "unique-provider-key"),
  ]);
  expect(await first.get("mcp/one")).toBe("unique-secret-one");
  expect(await second.get("mcp/two")).toBe("unique-secret-two");
  expect(await second.get("provider")).toBe("unique-provider-key");
  const path = join(root, "credentials.enc");
  expect(await readFile(path, "utf8")).not.toContain("unique-");
  if (process.platform !== "win32")
    expect((await stat(path)).mode & 0o777).toBe(0o600);
});
test("concurrent Always allow grants merge narrowly and do not overwrite a newer deny", async () => {
  const { store } = await setup();
  for (const scope of ["global", "project"] as const) {
    await store.save("approval", config, scope);
    if (scope === "project") {
      await store.remove(requiredEntry(await store.load(), "global"));
      await store.trust(
        requiredEntry(await store.load(), "project"),
        DEFAULT_MCP_PERMISSIONS,
      );
    }
    const entry = requiredEntry(await store.load(), scope);
    await Promise.all([
      store.rememberTool(entry, "create_issue", "write"),
      store.rememberTool(entry, "comment_issue", "write"),
    ]);
    const merged = requiredEntry(await store.load(), scope);
    expect(merged.permissions.tools).toEqual({
      create_issue: "allow",
      comment_issue: "allow",
    });
    await store.setPermissions(merged, {
      ...merged.permissions,
      categories: { ...merged.permissions.categories, write: "deny" },
    });
    await expect(
      store.rememberTool(entry, "create_another_issue", "write"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(
      (await store.load()).find((entry) => entry.id === "approval")?.permissions
        .categories.write,
    ).toBe("deny");
    expect(
      (await store.load()).find((entry) => entry.id === "approval")?.permissions
        .tools.create_another_issue,
    ).toBeUndefined();
  }
});
test("strict versioned MCP schema rejects oversized maps and unsafe envelopes", () => {
  expect(
    readMcpConfig({ schemaVersion: 2, servers: {} }).diagnostics,
  ).toHaveLength(1);
  expect(
    readMcpConfig({ schemaVersion: 1, servers: {}, trusted: true }).diagnostics,
  ).toHaveLength(1);
  expect(
    McpServerSchema.safeParse({
      ...config,
      env: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [
          `REGION_${index}`,
          { literal: "nonsecret" },
        ]),
      ),
    }).success,
  ).toBe(false);
});
