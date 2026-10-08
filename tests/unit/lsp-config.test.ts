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
import { join } from "node:path";
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
  await symlink(
    config.command,
    join(root, process.platform === "win32" ? "node.exe" : "node"),
  );
  // An alias to an external trusted file is canonicalized; an actual project file is refused.
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
      ui: { ...current.ui, unicodeDecorations: true },
    })),
    store.trust("typescript", false),
  ]);
  expect(await loadGlobalConfig(configPath)).toMatchObject({
    profiles: { work: { providerId: "anthropic" } },
    ui: { theme: "paper", unicodeDecorations: true },
    future: { keep: true },
    permissions: { allowBypassPermissions: false },
    lsp: { servers: { typescript: { trustedWorkspaces: [] } } },
  });
  expect(applied).toBeGreaterThan(0);
  await writeFile(configPath, "{invalid");
  await expect(store.saveGlobal({ servers: {} })).rejects.toThrow();
  expect(await readFile(configPath, "utf8")).toBe("{invalid");
});
