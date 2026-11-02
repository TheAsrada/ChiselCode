import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  loadGlobalConfig,
  loadProjectConfig,
  saveGlobalConfig,
  updateGlobalConfig,
} from "../../src/config/load.js";
import { canonicalWorkspaceRoot } from "../../src/extensions/host.js";
import {
  effectiveLspMode,
  LspConfigSchema,
  type LspConfiguration,
  lspServerEnabled,
  ProjectLspConfigSchema,
  selectLspServer,
  validateLspLaunch,
} from "../../src/lsp/config.js";
import { LspSettingsStore } from "../../src/lsp/settings.js";
import { installedLsp } from "../fixtures/lsp-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("individual permissions inherit project/global/default while overall Off and strategy remain ceilings", async () => {
  const { root } = await fixture();
  const config: LspConfiguration = {
    global: {
      mode: "auto",
      servers: {},
      serverOverrides: { "auto-python": { enabled: false } },
    },
    ignorePatterns: [],
  };
  expect(lspServerEnabled(config, "auto-python")).toEqual({
    enabled: false,
    source: "global",
  });
  expect((await selectLspServer(root, config, "auto-python")).state).toBe(
    "disabled",
  );
  expect((await selectLspServer(root, config, "auto")).state).toBe("stopped");
  config.project = { serverOverrides: { "auto-python": { enabled: true } } };
  expect((await selectLspServer(root, config, "auto-python")).state).toBe(
    "stopped",
  );
  config.global.enabled = false;
  config.project.enabled = true;
  expect(effectiveLspMode(config)).toBe("off");
  expect((await selectLspServer(root, config, "auto-python")).state).toBe(
    "disabled",
  );
  config.global.enabled = true;
  config.project.mode = "custom";
  expect((await selectLspServer(root, config, "auto-python")).state).toBe(
    "disabled",
  );
  const server = {
    ...(await installedLsp()),
    enabled: false,
    trustedWorkspaces: [root],
  };
  config.global.servers = { manual: server };
  config.project = {
    mode: "custom",
    serverOverrides: { manual: { enabled: true } },
  };
  expect((await selectLspServer(root, config, "manual")).state).toBe("stopped");
  server.trustedWorkspaces = [];
  expect((await selectLspServer(root, config, "manual")).state).toBe(
    "untrusted",
  );
  expect((await selectLspServer(root, config, "missing")).state).toBe(
    "unavailable",
  );
});

test("overrides are bounded strict records and reserved builtin IDs never become executables", async () => {
  for (const value of [
    { "bad ID": { enabled: true } },
    { auto: { enabled: true, command: "/tmp/server" } },
    Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [
        `server-${index}`,
        { enabled: false },
      ]),
    ),
  ]) {
    expect(LspConfigSchema.safeParse({ serverOverrides: value }).success).toBe(
      false,
    );
    expect(
      ProjectLspConfigSchema.safeParse({ serverOverrides: value }).success,
    ).toBe(false);
  }
  expect(
    LspConfigSchema.safeParse({
      servers: { "auto-python": await installedLsp() },
    }).success,
  ).toBe(false);
  expect(
    ProjectLspConfigSchema.parse({
      serverOverrides: { missing: { enabled: false } },
    }).serverOverrides?.missing?.enabled,
  ).toBe(false);
});
test("Auto is the default without paths/trusted roots; legacy custom settings keep exact-root trust", async () => {
  const { root } = await fixture();
  const automatic: LspConfiguration = {
    global: LspConfigSchema.parse({}),
    ignorePatterns: [],
  };
  expect(await selectLspServer(root, automatic)).toMatchObject({
    state: "stopped",
    id: "auto",
    kind: "auto",
  });
  const child = join(root, "nested");
  await mkdir(child);
  expect((await selectLspServer(child, automatic)).kind).toBe("auto");
  expect(
    (await selectLspServer(root, { ...automatic, project: { mode: "off" } }))
      .state,
  ).toBe("disabled");
  expect(
    (
      await selectLspServer(root, {
        ...automatic,
        global: { mode: "off", servers: {} },
        project: { mode: "auto" },
      })
    ).state,
  ).toBe("disabled");
  const custom = { servers: { external: await installedLsp() } };
  expect(effectiveLspMode({ ...automatic, global: custom })).toBe("custom");
  expect(
    (await selectLspServer(root, { ...automatic, global: custom })).state,
  ).toBe("untrusted");
  expect(
    (
      await selectLspServer(root, {
        ...automatic,
        global: custom,
        project: { mode: "auto" },
      })
    ).kind,
  ).toBe("auto");
  expect(
    (
      await selectLspServer(root, {
        ...automatic,
        global: { mode: "custom", servers: {} },
      })
    ).state,
  ).toBe("unavailable");
  expect(
    LspConfigSchema.safeParse({ servers: { auto: await installedLsp() } })
      .success,
  ).toBe(false);
});
async function fixture() {
  const root = await canonicalWorkspaceRoot(
    await mkdtemp(join(tmpdir(), "chisel-lsp-config-")),
  );
  roots.push(root);
  const configPath = join(root, "user.json");
  await saveGlobalConfig(
    {
      schemaVersion: 2,
      profiles: { work: { providerId: "anthropic", defaultModel: "fixture" } },
      permissions: { allowBypassPermissions: false },
      ui: { theme: "paper" },
      future: { keep: true },
    },
    configPath,
  );
  return { root, configPath };
}
test("LSP schemas reject project launch/trust injection and unknown backend", async () => {
  const server = await installedLsp();
  for (const field of [
    "command",
    "args",
    "typescriptPath",
    "trustedWorkspaces",
    "initializationOptions",
    "trusted",
    "env",
  ]) {
    expect(
      ProjectLspConfigSchema.safeParse({
        [field]: field === "args" ? [] : "unsafe",
      }).success,
    ).toBe(false);
  }
  expect(
    LspConfigSchema.safeParse({
      servers: { typescript: { ...server, backend: "unknown" } },
    }).success,
  ).toBe(false);
  const { root } = await fixture();
  await writeFile(
    join(root, ".chiselrc"),
    JSON.stringify({ lsp: { command: server.command } }),
  );
  await expect(loadProjectConfig(root)).rejects.toThrow();
});
test("trust is exact canonical root; aliases reuse identity but descendants are not trusted", async () => {
  const { root } = await fixture();
  const child = join(root, "child");
  await mkdir(child);
  const alias = join(root, "alias");
  await symlink(
    child,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const server = { ...(await installedLsp()), trustedWorkspaces: [alias] };
  const config: LspConfiguration = {
    global: { servers: { typescript: server } },
    ignorePatterns: [],
  };
  expect(
    (await selectLspServer(await canonicalWorkspaceRoot(child), config)).state,
  ).toBe("stopped");
  expect((await selectLspServer(root, config)).state).toBe("untrusted");
  const nested = join(child, "nested");
  await mkdir(nested);
  expect(
    (await selectLspServer(await canonicalWorkspaceRoot(nested), config)).state,
  ).toBe("untrusted");
  server.trustedWorkspaces = [root];
  config.global.servers = {
    ...config.global.servers,
    second: { ...server, trustedWorkspaces: [root] },
  };
  expect((await selectLspServer(root, config)).state).toBe("unavailable");
  expect(
    (
      await selectLspServer(root, {
        ...config,
        project: { serverId: "second" },
      })
    ).id,
  ).toBe("second");
});
test("path check is filesystem-only, validates installed pair, and rejects repository executables", async () => {
  const { root } = await fixture();
  const config = await installedLsp();
  const launch = await validateLspLaunch(root, "typescript", config);
  expect([launch.serverVersion, launch.typescriptVersion]).toEqual([
    "6.0.1",
    "6.0.3",
  ]);
  const alias = join(root, "runtime-alias");
  await symlink(
    dirname(config.command),
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(
    (
      await validateLspLaunch(root, "typescript", {
        ...config,
        command: join(alias, basename(config.command)),
      })
    ).command,
  ).toBe(launch.command);
  // Canonical external aliases work; an actual project executable is refused.
  await writeFile(join(root, "runtime"), "do not execute");
  await expect(
    validateLspLaunch(root, "typescript", {
      ...config,
      command: join(root, "runtime"),
    }),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  await expect(
    validateLspLaunch(root, "typescript", {
      ...config,
      args: ["-e", "unsafe", "--stdio"],
    }),
  ).rejects.toMatchObject({ code: "LSP_UNAVAILABLE" });
});
test("Settings typed save/trust/project patch preserve unrelated fields and reject concurrent/invalid JSON", async () => {
  const { root, configPath } = await fixture();
  let applied = 0;
  let restarted = 0;
  const store = new LspSettingsStore(root, configPath, {
    status: async () => ({
      workspaceRoot: root,
      backend: "typescript",
      state: "stopped",
      generation: 0,
      trackedDocuments: 0,
      requiresRestart: false,
    }),
    apply: async () => {
      ++applied;
    },
    restart: async () => {
      ++restarted;
      return { output: "ready" };
    },
  });
  await store.saveGlobal({ servers: { typescript: await installedLsp() } });
  expect(restarted).toBe(0);
  await store.trust("typescript", true);
  expect(
    (await store.load()).global.servers.typescript?.trustedWorkspaces,
  ).toEqual([root]);
  await writeFile(
    join(root, ".chiselrc"),
    JSON.stringify({
      unknown: { keep: true },
      allowedCommands: ["git status"],
    }),
  );
  const before = await store.load();
  await store.saveProject({ serverId: "typescript" }, before.projectRevision);
  expect(
    JSON.parse(await readFile(join(root, ".chiselrc"), "utf8")),
  ).toMatchObject({
    unknown: { keep: true },
    allowedCommands: ["git status"],
    lsp: { serverId: "typescript" },
  });
  await expect(
    store.saveProject({ enabled: false }, before.projectRevision),
  ).rejects.toThrow("изменён");
  await Promise.all([
    updateGlobalConfig(configPath, (current) => ({
      ...current,
      ui: { ...current.ui, accent: "#123456" },
    })),
    store.trust("typescript", false),
  ]);
  expect(await loadGlobalConfig(configPath)).toMatchObject({
    profiles: { work: { providerId: "anthropic" } },
    ui: { theme: "paper", accent: "#123456" },
    future: { keep: true },
    permissions: { allowBypassPermissions: false },
    lsp: { servers: { typescript: { trustedWorkspaces: [] } } },
  });
  expect(applied).toBeGreaterThan(0);
  await writeFile(configPath, "{invalid");
  await expect(store.saveGlobal({ servers: {} })).rejects.toThrow();
  expect(await readFile(configPath, "utf8")).toBe("{invalid");
});

test("quick patches preserve strategy, argv, trust, other sections and scoped inheritance across reloads", async () => {
  const { root, configPath } = await fixture();
  const runtime = {
    status: async () => ({
      workspaceRoot: root,
      backend: "typescript",
      state: "stopped" as const,
      generation: 0,
      trackedDocuments: 0,
      requiresRestart: false,
    }),
    apply: async () => {},
    restart: async () => ({ output: "unused" }),
  };
  const store = new LspSettingsStore(root, configPath, runtime);
  const server = { ...(await installedLsp()), trustedWorkspaces: [root] };
  let state = await store.saveGlobal({
    mode: "custom",
    servers: { manual: server },
    serverOverrides: { "auto-python": { enabled: false } },
  });
  state = await store.setEnabled("global", false, state);
  expect(state.global).toMatchObject({
    mode: "custom",
    enabled: false,
    servers: { manual: server },
  });
  const reopened = new LspSettingsStore(root, configPath, runtime);
  state = await reopened.setEnabled("global", true, await reopened.load());
  expect(state.global.servers.manual).toEqual(server);
  await writeFile(
    join(root, ".chiselrc"),
    JSON.stringify({
      future: { retained: 42 },
      lsp: {
        mode: "custom",
        serverId: "manual",
        enabled: false,
        serverOverrides: { manual: { enabled: false } },
      },
    }),
  );
  state = await store.setEnabled("project", undefined, await store.load());
  expect(state.project).toEqual({
    mode: "custom",
    serverId: "manual",
    serverOverrides: { manual: { enabled: false } },
  });
  state = await store.setServerEnabled("project", "auto-python", true, state);
  state = await store.setServerEnabled("project", "manual", undefined, state);
  expect(state.project.serverOverrides).toEqual({
    "auto-python": { enabled: true },
  });
  expect(
    JSON.parse(await readFile(join(root, ".chiselrc"), "utf8")).future,
  ).toEqual({ retained: 42 });
  state = await store.setServerEnabled("global", "manual", false, state);
  state = await store.saveGlobal(
    { ...state.global, servers: {} },
    state.globalRevision,
  );
  expect(state.global.serverOverrides).not.toHaveProperty("manual");
  state = await store.setServerEnabled("project", "manual", true, state);
  expect(
    state.management?.project.servers.find((entry) => entry.id === "manual"),
  ).toMatchObject({ origin: "missing", state: "unavailable" });
  expect((await loadGlobalConfig(configPath)).ui?.theme).toBe("paper");
});

test("legacy Off normalizes atomically; project reset changes no unrelated switches", async () => {
  const { root, configPath } = await fixture();
  const store = new LspSettingsStore(root, configPath, {
    status: async () => ({
      workspaceRoot: root,
      backend: "typescript",
      state: "disabled",
      generation: 0,
      trackedDocuments: 0,
      requiresRestart: false,
    }),
    apply: async () => {},
    restart: async () => ({ output: "unused" }),
  });
  let state = await store.saveGlobal({
    mode: "off",
    servers: { manual: await installedLsp() },
  });
  state = await store.setEnabled("global", true, state);
  expect(state.global.mode).toBe("custom");
  state = await store.saveProject(
    {
      mode: "off",
      serverId: "manual",
      serverOverrides: { "auto-python": { enabled: true } },
    },
    state.projectRevision,
  );
  state = await store.setEnabled("project", true, state);
  expect(state.project).toMatchObject({
    enabled: true,
    mode: "custom",
    serverId: "manual",
    serverOverrides: { "auto-python": { enabled: true } },
  });
  state = await store.saveProject(
    { ...state.project, mode: "off" },
    state.projectRevision,
  );
  state = await store.setEnabled("project", undefined, state);
  expect(state.project.mode).toBeUndefined();
  expect(state.project.enabled).toBeUndefined();
  expect(state.project.serverId).toBe("manual");
  expect(state.project.serverOverrides?.["auto-python"]?.enabled).toBe(true);
});

test("concurrent project actions conflict rather than overwriting and saved/apply failures remain distinct", async () => {
  const { root, configPath } = await fixture();
  let failCleanup = false;
  const runtime = {
    status: async () => ({
      workspaceRoot: root,
      backend: "typescript",
      state: "disabled" as const,
      generation: 0,
      trackedDocuments: 0,
      requiresRestart: false,
    }),
    apply: async () => {
      if (failCleanup) throw new Error("cleanup failed");
    },
    restart: async () => ({ output: "unused" }),
  };
  const a = new LspSettingsStore(root, configPath, runtime);
  const b = new LspSettingsStore(root, configPath, runtime);
  const before = await a.load();
  const concurrent = await Promise.allSettled([
    a.setEnabled("project", false, before),
    b.setServerEnabled("project", "auto-python", false, before),
  ]);
  expect(
    concurrent.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    concurrent.filter((result) => result.status === "rejected"),
  ).toHaveLength(1);
  await writeFile(
    join(root, ".chiselrc"),
    JSON.stringify({ external: { keep: true } }),
  );
  await expect(a.setEnabled("project", true, before)).rejects.toThrow(
    "изменён",
  );
  expect(JSON.parse(await readFile(join(root, ".chiselrc"), "utf8"))).toEqual({
    external: { keep: true },
  });
  failCleanup = true;
  const saved = await a.setEnabled("global", false, await a.load());
  expect(saved.global.enabled).toBe(false);
  expect(saved.applicationError).toContain(
    "завершение процесса не подтверждено",
  );
  expect((await loadGlobalConfig(configPath)).lsp?.enabled).toBe(false);
  failCleanup = false;
  expect((await a.retryApply()).applicationError).toBeUndefined();
  const revision = await a.load();
  await updateGlobalConfig(configPath, (current) => ({
    ...current,
    lsp: { servers: {}, enabled: true },
  }));
  await expect(a.setEnabled("global", false, revision)).rejects.toThrow(
    "изменились",
  );
  expect((await loadGlobalConfig(configPath)).lsp?.enabled).toBe(true);
});
