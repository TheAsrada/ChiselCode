import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionToolRuntime } from "../../src/app/tool-runtime.js";
import {
  loadGlobalConfig,
  loadProjectConfig,
  saveGlobalConfig,
} from "../../src/config/load.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import {
  canonicalWorkspaceRoot,
  ExtensionHost,
} from "../../src/extensions/host.js";
import { LspService, lspServiceToken } from "../../src/lsp/service.js";
import { LspSettingsStore } from "../../src/lsp/settings.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { WorkspacePolicy } from "../../src/security/workspace-policy.js";
import { attachSessionRecorder } from "../../src/sessions/checkpoints.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { installedLsp } from "../fixtures/lsp-runtime.js";

test("manual generic LSP uses the same service for a new language, exact trust, observations and revocation", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-generic-lsp-")),
  );
  const root = join(directory, "workspace");
  await mkdir(root);
  const peer = join(directory, "peer.mjs");
  await copyFile(join(import.meta.dir, "../fixtures/lsp-server.mjs"), peer);
  await writeFile(join(root, "peer.json"), "{}");
  await writeFile(join(root, "main.notes"), "export const error = 1;\n");
  const configuration = {
    global: {
      mode: "custom" as const,
      servers: {
        notes: {
          backend: "generic" as const,
          enabled: true,
          command: (await installedLsp()).command,
          args: [peer],
          languageIds: ["notes"],
          extensions: [".notes"],
          trustedWorkspaces: [] as string[],
        },
      },
    },
    ignorePatterns: [] as string[],
  };
  const service = new LspService(
    await canonicalWorkspaceRoot(root),
    async () => structuredClone(configuration),
    new AbortController().signal,
  );
  const observations: string[] = [];
  const port = {
    policy: new WorkspacePolicy(root, []),
    observe: async (path: string) => {
      observations.push(path);
    },
  };
  try {
    await expect(service.diagnostics("main.notes", port)).rejects.toMatchObject(
      { code: "PERMISSION_DENIED" },
    );
    expect((await service.status()).generation).toBe(0);
    configuration.global.servers.notes.trustedWorkspaces.push(root);
    const value = await service.diagnostics("main.notes", port);
    expect(value.freshness).toBe("current");
    expect(value.diagnostics[0]?.code).toBe(999);
    expect(observations).toContain(join(root, "main.notes"));
    const events = (await readFile(join(root, "peer.log"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(
      events.find((event) => event.method === "textDocument/didOpen").params
        .textDocument.languageId,
    ).toBe("notes");
    configuration.global.servers.notes.trustedWorkspaces.length = 0;
    await service.refreshConfiguration();
    expect((await service.status()).state).toBe("untrusted");
    expect(await service.collectContext()).toBeUndefined();
    await expect(
      service.documentSymbols("main.notes", port),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real Auto Python and Lua share a workspace through core tools; revisions, source persistence, navigation and cleanup", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-real-multilingual-")),
  );
  const root = join(directory, "workspace");
  await mkdir(root);
  const configPath = join(directory, "config.json");
  await saveGlobalConfig(
    { schemaVersion: 2, profiles: {}, web: { enabled: false } },
    configPath,
  );
  const source =
    'def greet(name: str) -> str:\n    return name\n\nresult: int = "wrong"\nvalue = greet("world")\n';
  await writeFile(join(root, "main.py"), source);
  await writeFile(
    join(root, "main.lua"),
    "local function greet(name)\n return name\nend\ngreet('hi')\n",
  );
  const host = new ExtensionHost(defaultExtensions([], { configPath }));
  let tools: Awaited<ReturnType<typeof createSessionToolRuntime>> | undefined;
  try {
    const scope = await host.open(root);
    const service = scope.services.get(lspServiceToken);
    const settings = new LspSettingsStore(root, configPath, {
      status: () => service.status(),
      apply: () => service.refreshConfiguration(),
      restart: async () => {
        throw new Error("Use executor");
      },
    });
    expect((await settings.load()).global.servers).toEqual({});
    expect((await service.status()).generation).toBe(0);
    const session = createSession(root, "anthropic", "offline-fixture");
    const bus = new RuntimeEventBus(session.id);
    attachSessionRecorder(session, bus);
    const store = await projectSessionStore(root);
    tools = await createSessionToolRuntime({
      root,
      scope,
      session,
      store,
      events: bus,
      config: await loadProjectConfig(root),
      global: await loadGlobalConfig(configPath),
      options: { configPath, interactive: true },
      mode: "build",
      approvalMode: "acceptEdits",
      resolver: { requestApproval: async () => "approved" },
      signal: scope.signal,
    });
    const runtime = tools;
    const call = (name: string, input: Record<string, string | number>) =>
      runtime.scheduler.execute([{ id: randomUUID(), name, input }]);
    const first = (
      await call("ext:builtin.lsp:diagnostics", { path: "main.py" })
    )[0];
    expect(first?.isError).not.toBe(true);
    expect(first?.output).toContain("reportAssignmentType");
    const pythonGeneration = (await service.status()).generation;
    const definition = (
      await call("ext:builtin.lsp:definition", {
        path: "main.py",
        line: 4,
        character: 9,
      })
    )[0];
    expect(definition?.output).toContain('"path": "main.py"');
    const references = (
      await call("ext:builtin.lsp:references", {
        path: "main.py",
        line: 0,
        character: 6,
      })
    )[0];
    expect(references?.output).toContain('"line": 4');
    const lua = (
      await call("ext:builtin.lsp:symbols", { path: "main.lua" })
    )[0];
    expect(lua?.output).toContain("greet");
    expect((await service.status()).servers).toHaveLength(2);
    const edit = (
      await call("edit_file", {
        path: "main.py",
        old_str: 'result: int = "wrong"',
        new_str: "result: int = 1",
      })
    )[0];
    expect(edit?.isError).not.toBe(true);
    const fixed = (
      await call("ext:builtin.lsp:diagnostics", { path: "main.py" })
    )[0];
    expect(fixed?.output).not.toContain("reportAssignmentType");
    expect((await service.status()).generation).toBe(pythonGeneration);
    expect(await service.collectContext()).not.toContain("not assignable");
    const saved = await store.load(session.id);
    expect(saved?.messages).toEqual([]);
    expect(
      Object.values(saved?.runtime?.invocations ?? {}).some(
        (record) =>
          record.toolSource?.type === "extension" &&
          record.toolSource.extensionId === "builtin.lsp",
      ),
    ).toBe(true);
    await settings.saveGlobal({ mode: "off", servers: {} });
    expect((await service.status()).state).toBe("disabled");
    const denied = (
      await call("ext:builtin.lsp:diagnostics", { path: "main.py" })
    )[0];
    expect(denied?.errorCode).toBe("LSP_UNAVAILABLE");
  } finally {
    await tools?.dispose();
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
