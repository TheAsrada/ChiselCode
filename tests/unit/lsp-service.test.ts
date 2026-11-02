import { afterEach, expect, test } from "bun:test";
import { watch } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/load.js";
import { canonicalWorkspaceRoot } from "../../src/extensions/host.js";
import { autoLspLaunch } from "../../src/lsp/backend.js";
import type { LspConfiguration } from "../../src/lsp/config.js";
import {
  documentEnd,
  permittedLocation,
  readLspFile,
  validatePosition,
} from "../../src/lsp/documents.js";
import { LspService } from "../../src/lsp/service.js";
import { LspSettingsStore } from "../../src/lsp/settings.js";
import { LspTransport } from "../../src/lsp/transport.js";
import { WorkspacePolicy } from "../../src/security/workspace-policy.js";
import {
  installedLsp,
  waitForLspProcessExit,
} from "../fixtures/lsp-runtime.js";

const roots: string[] = [];
const services: LspService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(control: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chisel-lsp-state-"));
  roots.push(directory);
  const root = join(directory, "workspace");
  await mkdir(root);
  const canonical = await canonicalWorkspaceRoot(root);
  const installation = join(directory, "peer/lib");
  await mkdir(installation, { recursive: true });
  await writeFile(
    join(directory, "peer/package.json"),
    JSON.stringify({ name: "typescript-language-server", version: "6.0.1" }),
  );
  await copyFile(
    join(import.meta.dir, "../fixtures/lsp-server.mjs"),
    join(installation, "cli.mjs"),
  );
  await writeFile(join(root, "peer.json"), JSON.stringify(control));
  await writeFile(join(root, "main.ts"), "export const error = 1;\n");
  const installed = await installedLsp();
  const configuration: LspConfiguration = {
    global: {
      servers: {
        peer: {
          ...installed,
          args: [join(installation, "cli.mjs"), "--stdio"],
          trustedWorkspaces: [canonical],
        },
      },
    },
    ignorePatterns: [],
  };
  const lifetime = new AbortController();
  const service = new LspService(
    canonical,
    async () => structuredClone(configuration),
    lifetime.signal,
  );
  services.push(service);
  const observations: string[] = [];
  const port = {
    policy: new WorkspacePolicy(canonical, []),
    observe: async (path: string) => {
      observations.push(path);
    },
  };
  const update = (value: Record<string, unknown>) =>
    writeFile(join(root, "peer.json"), JSON.stringify(value));
  const log = async () =>
    (await readFile(join(root, "peer.log"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    root: canonical,
    directory,
    configuration,
    lifetime,
    service,
    port,
    observations,
    update,
    log,
  };
}
async function poll<T>(
  read: () => Promise<T>,
  match: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 4500;
  do {
    const value = await read();
    if (match(value)) return value;
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  throw new Error("LSP state did not settle within its bound.");
}

test("a late configuration snapshot cannot undo revocation or publish a ready server", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let reads = 0;
  const service = new LspService(
    f.root,
    async () => {
      const snapshot = structuredClone(f.configuration);
      if (++reads === 1) {
        entered();
        await delayed;
      }
      return snapshot;
    },
    f.lifetime.signal,
  );
  services.push(service);
  const old = service.status();
  await paused;
  f.configuration.global.mode = "off";
  expect((await service.status()).state).toBe("disabled");
  release();
  expect((await old).state).toBe("disabled");
  await expect(service.ensureStarted()).rejects.toMatchObject({
    code: "LSP_UNAVAILABLE",
  });
  expect(await Bun.file(join(f.root, "peer.log")).exists()).toBe(false);
});

test("revocation while validating a pending start does not replace its cancelled generation", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let reads = 0;
  const service = new LspService(
    f.root,
    async () => {
      const snapshot = structuredClone(f.configuration);
      if (++reads === 2) {
        entered();
        await delayed;
      }
      return snapshot;
    },
    f.lifetime.signal,
  );
  services.push(service);
  const start = service.ensureStarted().catch((error) => error);
  await paused;
  f.configuration.global.mode = "off";
  const revoked = service.refreshConfiguration();
  await Bun.sleep(0); // Deliver the newer snapshot and its lifetime cancellation.
  release();
  expect(await start).toBeInstanceOf(Error);
  await revoked;
  expect((await service.status()).state).toBe("disabled");
  expect(await Bun.file(join(f.root, "peer.log")).exists()).toBe(false);
});
test("versioned diagnostics track bytes, old notifications cannot replace current, and empty current clears errors", async () => {
  const f = await fixture({ encodedUri: true });
  expect((await f.service.status()).generation).toBe(0);
  expect(await f.service.collectContext()).toBeUndefined();
  const first = await f.service.diagnostics("main.ts", f.port);
  expect(first.freshness).toBe("current");
  expect(first.diagnostics[0]?.code).toBe(999);
  expect(await f.service.collectContext()).toContain("fixture error");
  await f.update({ oldVersion: true });
  await writeFile(join(f.root, "main.ts"), "export const other = 1;\n");
  const old = await f.service.diagnostics("main.ts", f.port);
  expect(old.freshness).toBe("unavailable");
  expect(old.diagnostics).toEqual([]);
  expect((await f.service.collectContext()) ?? "").not.toContain(
    "fixture error",
  );
  await f.update({});
  await writeFile(join(f.root, "main.ts"), "export const clean = 1;\n");
  const clean = await f.service.diagnostics("main.ts", f.port);
  expect(clean.freshness).toBe("current");
  expect(clean.diagnostics).toEqual([]);
  expect(clean.revision).not.toBe(first.revision);
  const log = await f.log();
  expect(
    log.filter((item) => item.method === "textDocument/didOpen"),
  ).toHaveLength(1);
  const changes = log.filter(
    (item) => item.method === "textDocument/didChange",
  );
  expect(changes.map((item) => item.params.textDocument.version)).toEqual([
    2, 3,
  ]);
  expect(changes[0].params.contentChanges[0].range.end).toEqual(
    documentEnd("export const error = 1;\n"),
  );
  expect(
    log.filter((item) => item.method === "textDocument/didSave"),
  ).toHaveLength(2);
}, 15_000);
test("advertised pull diagnostics bind to synchronized bytes, clear errors and reject invalid reports", async () => {
  const f = await fixture({ pullDiagnostics: true, noDiagnostics: true });
  const first = await f.service.diagnostics("main.ts", f.port);
  expect(first.freshness).toBe("current");
  expect(first.provenance).toContain("diagnostic request");
  expect(first.diagnostics[0]?.code).toBe(999);
  expect(await f.service.collectContext()).toContain("fixture error");
  await writeFile(join(f.root, "main.ts"), "export const value = 1;\n");
  const clean = await f.service.diagnostics("main.ts", f.port);
  expect(clean.revision).not.toBe(first.revision);
  expect(clean.freshness).toBe("current");
  expect(clean.diagnostics).toEqual([]);
  await f.update({
    pullDiagnostics: true,
    invalidPull: true,
    noDiagnostics: true,
  });
  await expect(f.service.diagnostics("main.ts", f.port)).rejects.toMatchObject({
    code: "LSP_PROTOCOL_ERROR",
  });
  await f.update({ pullDiagnostics: true, noDiagnostics: true, pullDelay: 80 });
  const pending = f.service.diagnostics("main.ts", f.port);
  await poll(
    f.log,
    (events) =>
      events.filter((event) => event.method === "textDocument/diagnostic")
        .length >= 4,
  );
  await writeFile(join(f.root, "main.ts"), "export const changed = 2;\n");
  await expect(pending).rejects.toMatchObject({ code: "STALE_FILE_REVISION" });
});
test("unversioned provisional empty remains observed; external change invalidates context without sync or observations", async () => {
  const f = await fixture({
    unversioned: true,
    provisional: true,
    diagnosticsDelay: 40,
  });
  const first = await f.service.diagnostics("main.ts", f.port);
  expect(first.freshness).toBe("observed");
  expect(first.provenance).toContain("не подтверждена");
  const error = await poll(
    () => f.service.diagnostics("main.ts", f.port),
    (value) => value.diagnostics.length > 0,
  );
  expect(error.freshness).toBe("observed");
  expect((await f.service.collectContext()) ?? "").not.toContain(
    "fixture error",
  );
  const count = f.observations.length;
  await writeFile(join(f.root, "main.ts"), "export const clean = 1;\n");
  await f.service.collectContext();
  expect(f.observations).toHaveLength(count);
  expect(
    (await f.log()).filter((item) => item.method === "textDocument/didChange"),
  ).toHaveLength(0);
  const clean = await f.service.diagnostics("main.ts", f.port);
  expect(clean.freshness).toBe("observed");
  expect(clean.diagnostics).toEqual([]);
});
test("UTF-16/CRLF and escaped file URIs; ignored/outside/binary/oversized documents never reach the server", async () => {
  const f = await fixture();
  const name = "space % #.tsx";
  await writeFile(join(f.root, name), "a😀b\r\nexport const x = 1;\r\n");
  const file = await readLspFile(f.port, name);
  expect(file.languageId).toBe("typescriptreact");
  expect(file.uri).toContain("%25%20%23");
  validatePosition(file.text, { line: 0, character: 3 });
  expect(() => validatePosition(file.text, { line: 0, character: 2 })).toThrow(
    "surrogate",
  );
  expect(() =>
    validatePosition(file.text, { line: 1, character: 1000 }),
  ).toThrow("outside");
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
  expect(
    (await permittedLocation(f.port.policy, { uri: file.uri, range }))?.path,
  ).toBe(name);
  for (const uri of [
    "https://example.com/main.ts",
    "file://remote/share/main.ts",
    pathToFileURL(join(f.directory, "private.ts")).href,
  ])
    expect(
      await permittedLocation(f.port.policy, { uri, range }),
    ).toBeUndefined();
  const outside = join(f.directory, "private.ts");
  await writeFile(outside, "secret");
  await symlink(
    f.directory,
    join(f.root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(readLspFile(f.port, "escape/private.ts")).rejects.toThrow();
  await writeFile(join(f.root, "invalid.ts"), Buffer.from([0xff]));
  await expect(readLspFile(f.port, "invalid.ts")).rejects.toMatchObject({
    code: "INVALID_TOOL_INPUT",
  });
  await writeFile(join(f.root, "large.ts"), "a".repeat(512001));
  await expect(readLspFile(f.port, "large.ts")).rejects.toMatchObject({
    code: "INVALID_TOOL_INPUT",
  });
  const ignored = new WorkspacePolicy(f.root, ["main.ts"]);
  await expect(readLspFile({ policy: ignored }, "main.ts")).rejects.toThrow();
  expect((await f.service.status()).generation).toBe(0);
});
test("shared lazy initialize survives one caller abort; restart fences pending reads, restores docs and applies launch changes", async () => {
  const f = await fixture({ initializeDelay: 80, requestDelay: 120 });
  const abort = new AbortController();
  const first = f.service
    .ensureStarted(abort.signal)
    .catch((error: unknown) => error);
  const second = f.service.ensureStarted();
  abort.abort();
  expect(await first).toMatchObject({ code: "CANCELLED" });
  await second;
  expect(
    (await f.log()).filter((item) => item.method === "initialize"),
  ).toHaveLength(1);
  await f.service.diagnostics("main.ts", f.port);
  const pending = f.service
    .definition("main.ts", { line: 0, character: 0 }, f.port)
    .catch((error: unknown) => error);
  await Bun.sleep(25);
  await f.service.restart(undefined, undefined);
  expect(await pending).toMatchObject({ code: "LSP_UNAVAILABLE" });
  expect((await f.service.status()).generation).toBe(2);
  expect((await f.service.status()).trackedDocuments).toBe(1);
  const server = f.configuration.global.servers.peer;
  if (!server) throw new Error("Fixture missing");
  server.args.push("--log-level", "1");
  await f.service.refreshConfiguration();
  expect((await f.service.status()).requiresRestart).toBe(true);
  await f.service.definition("main.ts", { line: 0, character: 0 }, f.port);
  expect((await f.service.status()).generation).toBe(3);
  server.trustedWorkspaces = [];
  await f.service.refreshConfiguration();
  await expect(
    f.service.definition("main.ts", { line: 0, character: 0 }, f.port),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(await f.service.collectContext()).toBeUndefined();
});
test("unsupported features, wrong encoding, server errors and changed documents are controlled errors", async () => {
  const unsupported = await fixture({ unsupported: true });
  await expect(
    unsupported.service.definition(
      "main.ts",
      { line: 0, character: 0 },
      unsupported.port,
    ),
  ).rejects.toMatchObject({ code: "LSP_UNSUPPORTED" });
  expect(
    (await unsupported.log()).some(
      (item) => item.method === "textDocument/definition",
    ),
  ).toBe(false);
  const encoding = await fixture({ encoding: "utf-8" });
  await expect(encoding.service.ensureStarted()).rejects.toMatchObject({
    code: "LSP_UNSUPPORTED",
  });
  const failed = await fixture({ requestError: true });
  await expect(
    failed.service.definition(
      "main.ts",
      { line: 0, character: 0 },
      failed.port,
    ),
  ).rejects.toMatchObject({ code: "LSP_PROTOCOL_ERROR" });
  const slow = await fixture({ holdRequests: true });
  await slow.service.ensureStarted();
  const pending = slow.service
    .definition("main.ts", { line: 0, character: 0 }, slow.port)
    .catch((error: unknown) => error);
  // Receipt proves the server has the original bytes; hold its response until
  // the write completes so slow filesystem work cannot invert the race.
  await poll(
    () => slow.log(),
    (log) => log.some((item) => item.method === "textDocument/definition"),
  );
  await writeFile(join(slow.root, "main.ts"), "changed\n");
  await writeFile(join(slow.root, "peer-release-requests"), "");
  expect(await pending).toMatchObject({ code: "STALE_FILE_REVISION" });
}, 15_000);

test("Full sync sends replacement bytes; project changes invalidate previously confirmed context", async () => {
  const f = await fixture({ sync: 1 });
  await f.service.diagnostics("main.ts", f.port);
  expect(await f.service.collectContext()).toContain("fixture error");
  f.configuration.project = { serverId: "peer" };
  expect((await f.service.collectContext()) ?? "").not.toContain(
    "fixture error",
  );
  await writeFile(join(f.root, "main.ts"), "export const clean = 1;\r\n");
  await f.service.synchronizeDocument("main.ts", f.port);
  const changes = (await f.log()).filter(
    (item) => item.method === "textDocument/didChange",
  );
  expect(changes).toHaveLength(1);
  expect(changes[0].params.contentChanges).toEqual([
    { text: "export const clean = 1;\r\n" },
  ]);
  expect(changes[0].params.textDocument.version).toBe(2);
});
test("workspace disposal cancels pending initialization and prevents a late ready generation", async () => {
  const f = await fixture({ initializeDelay: 500 });
  const pending = f.service.ensureStarted().catch((error: unknown) => error);
  await poll(
    () => f.log().catch(() => []),
    (log) => log.some((item) => item.method === "initialize"),
  );
  f.lifetime.abort();
  await f.service.dispose();
  expect(await pending).toMatchObject({ code: "CANCELLED" });
  expect((await f.service.status()).state).toBe("disposed");
  await expect(f.service.ensureStarted()).rejects.toMatchObject({
    code: "LSP_UNAVAILABLE",
  });
});

for (const sibling of [false, true])
  test(`individual Off cancels actual bundled preparation; shared sibling=${sibling}`, async () => {
    const f = await fixture();
    const previous = {
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    };
    const isolated = join(f.directory, "isolated-home");
    Object.assign(process.env, {
      LOCALAPPDATA: isolated,
      XDG_DATA_HOME: isolated,
    });
    f.configuration.global = { mode: "auto", servers: {} };
    const launch = await autoLspLaunch(f.root);
    const cacheParent = dirname(
      dirname(dirname(dirname(launch.args[0] ?? ""))),
    );
    await mkdir(cacheParent, { recursive: true });
    let stopped: Promise<void> | undefined;
    const watcher = watch(cacheParent, (_event, filename) => {
      if (!String(filename).endsWith(".tmp") || stopped) return;
      f.configuration.global.serverOverrides = { auto: { enabled: false } };
      stopped = f.service.refreshConfiguration();
    });
    const seen: string[] = [];
    const subscription = f.service.subscribeUi(() =>
      seen.push(f.service.uiStatus().state),
    );
    try {
      let other: LspService | undefined;
      if (sibling) {
        const otherRoot = join(f.directory, "other-workspace");
        await mkdir(otherRoot);
        other = new LspService(
          await canonicalWorkspaceRoot(otherRoot),
          async () => ({
            global: { mode: "auto", servers: {} },
            ignorePatterns: [],
          }),
          new AbortController().signal,
        );
        services.push(other);
      }
      const first = f.service.ensureStarted().catch((error: unknown) => error);
      const second = other?.ensureStarted();
      await poll(async () => !!stopped, Boolean);
      await stopped;
      expect(await first).toBeInstanceOf(Error);
      expect((await f.service.status("auto")).state).toBe("disabled");
      expect((await f.service.status("auto")).generation).toBe(0);
      expect(seen).not.toContain("ready");
      if (other) {
        await second;
        expect((await other.status()).state).toBe("ready");
      }
      await poll(
        () => readdir(cacheParent),
        (names) => names.every((name) => !name.endsWith(".tmp")),
      );
      expect(await f.service.collectContext()).toBeUndefined();
    } finally {
      watcher.close();
      subscription.dispose();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 15000);

for (const phase of ["initialize", "request"] as const)
  test(`individual Off fences ${phase}, late callbacks and diagnostics while another server remains ready`, async () => {
    const f = await fixture({
      initializeDelay: phase === "initialize" ? 250 : 0,
      requestDelay: phase === "request" ? 250 : 0,
    });
    const peer = f.configuration.global.servers.peer;
    if (!peer) throw new Error("Missing peer");
    f.configuration.global.servers.second = structuredClone(peer);
    await f.service.ensureStarted(undefined, "second");
    f.configuration.project = { serverId: "peer" };
    const pending = (
      phase === "initialize"
        ? f.service.ensureStarted(undefined, "peer")
        : f.service.definition("main.ts", { line: 0, character: 0 }, f.port)
    ).catch((error: unknown) => error);
    await poll(f.log, (events) =>
      phase === "initialize"
        ? events.filter((event) => event.method === "initialize").length >= 2
        : events.some((event) => event.method === "textDocument/definition"),
    );
    f.configuration.global.serverOverrides = { peer: { enabled: false } };
    await f.service.refreshConfiguration();
    expect(await pending).toBeInstanceOf(Error);
    expect((await f.service.status("peer")).state).toBe("disabled");
    expect((await f.service.status("second")).state).toBe("ready");
    expect(f.service.uiStatus().state).toBe("ready");
    expect(f.service.uiStatus().staleDocuments).toBe(0);
    expect(
      f.service
        .managementEntries()
        .filter((entry) => entry.serverId === "peer")
        .every((entry) =>
          entry.documents.every((doc) => doc.diagnostics.length === 0),
        ),
    ).toBe(true);
    f.configuration.global.serverOverrides = { peer: { enabled: true } };
    await f.service.refreshConfiguration();
    expect((await f.service.status("peer")).state).toBe("stopped");
    expect((await f.service.status("second")).state).toBe("ready");
  }, 15000);

test("a saved Off fences real processes when cleanup fails and explicit retry completes disposal", async () => {
  const f = await fixture({ children: true });
  await f.service.diagnostics("main.ts", f.port);
  const pids = await poll(
    async () => {
      try {
        return JSON.parse(
          await readFile(join(f.root, "peer-pids.json"), "utf8"),
        ) as number[];
      } catch {
        return [];
      }
    },
    (items) => items.length >= 2,
  );
  const configPath = join(f.directory, "selected.json");
  await saveGlobalConfig(
    { schemaVersion: 2, profiles: {}, lsp: f.configuration.global },
    configPath,
  );
  const settings = new LspSettingsStore(f.root, configPath, {
    status: () => f.service.status(),
    entries: () => f.service.managementEntries(),
    apply: async () => {
      f.configuration.global = (await loadGlobalConfig(configPath)).lsp ?? {
        servers: {},
      };
      await f.service.refreshConfiguration();
    },
    restart: async () => ({ output: "unused" }),
  });
  const before = await settings.load();
  const original = LspTransport.prototype.dispose;
  let failCleanup = true;
  // Inject only the cleanup failure boundary; the server and its child are real.
  LspTransport.prototype.dispose = function () {
    return failCleanup
      ? Promise.reject(new Error("Injected cleanup refusal"))
      : original.call(this);
  };
  try {
    const saved = await settings.setEnabled("global", false, before);
    expect(saved.global.enabled).toBe(false);
    expect(saved.applicationError).toContain(
      "завершение процесса не подтверждено",
    );
    expect(
      saved.management?.project.servers.find((server) => server.id === "peer")
        ?.state,
    ).toBe("disabled");
    for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
    expect((await loadGlobalConfig(configPath)).lsp?.enabled).toBe(false);
    await expect(f.service.ensureStarted()).rejects.toThrow();
    expect(await f.service.collectContext()).toBeUndefined();
    expect(
      f.service
        .managementEntries()[0]
        ?.documents.every((doc) => !doc.diagnostics.length),
    ).toBe(true);
    failCleanup = false;
    const retried = await settings.retryApply();
    expect(retried.applicationError).toBeUndefined();
    expect(retried.management?.project.enabled).toBe(false);
    await waitForLspProcessExit(pids);
  } finally {
    failCleanup = false;
    LspTransport.prototype.dispose = original;
  }
}, 15000);
test("navigation uses live ignore policy and handles links/null and both symbol shapes without target observations", async () => {
  const f = await fixture();
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
  const uri = pathToFileURL(join(f.root, "main.ts")).href;
  const ignored = pathToFileURL(join(f.root, "dependency.ts")).href;
  await writeFile(join(f.root, "dependency.ts"), "export const hidden = 1;\n");
  f.configuration.ignorePatterns = ["dependency.ts"];
  await f.update({
    locations: [
      { targetUri: uri, targetRange: range, targetSelectionRange: range },
      { uri: ignored, range },
      { uri: "file://remote/private.ts", range },
    ],
  });
  const linked = (await f.service.definition(
    "main.ts",
    { line: 0, character: 0 },
    f.port,
  )) as { locations: { path: string }[]; omitted: number };
  expect(linked.locations.map((item) => item.path)).toEqual(["main.ts"]);
  expect(linked.omitted).toBe(2);
  expect(f.observations.every((path) => path.endsWith("main.ts"))).toBe(true);
  await f.update({ locations: null, nullSymbols: true });
  expect(
    await f.service.definition("main.ts", { line: 0, character: 0 }, f.port),
  ).toMatchObject({ locations: [], omitted: 0 });
  expect(await f.service.documentSymbols("main.ts", f.port)).toMatchObject({
    symbols: [],
  });
  await f.update({
    symbols: [
      { name: "flat", kind: 12, location: { uri, range } },
      { name: "hidden", kind: 12, location: { uri: ignored, range } },
    ],
  });
  expect(await f.service.documentSymbols("main.ts", f.port)).toMatchObject({
    symbols: [{ name: "flat", path: "main.ts", parents: [] }],
    omitted: 1,
  });
  await f.update({});
  expect(await f.service.documentSymbols("main.ts", f.port)).toMatchObject({
    symbols: [
      { name: "parent", parents: [] },
      { name: "nested", parents: ["parent"] },
    ],
  });
});
test("bounded cache sends didClose; result caps and policy refresh prevent stale diagnostics disclosure", async () => {
  const f = await fixture({ diagnosticCount: 105 });
  const diagnostics = await f.service.diagnostics("main.ts", f.port);
  expect(diagnostics.diagnostics).toHaveLength(100);
  expect(diagnostics.omitted).toBe(5);
  const context = await f.service.collectContext();
  expect(Buffer.byteLength(context ?? "")).toBeLessThanOrEqual(8192);
  expect(context).toContain("80 diagnostics omitted");
  await f.update({});
  // Populate the real bounded cache in small independent batches. Each request
  // retains its normal policy/byte refresh; serial setup needlessly rereads all
  // previously inserted documents on slow Windows filesystems.
  for (let first = 0; first < 65; first += 4)
    await Promise.all(
      Array.from({ length: Math.min(4, 65 - first) }, async (_, offset) => {
        const path = `doc${first + offset}.js`;
        await writeFile(join(f.root, path), "const clean = 1;\n");
        await f.service.synchronizeDocument(path, f.port);
      }),
    );
  expect((await f.service.status()).trackedDocuments).toBe(64);
  expect(
    (await f.log()).filter((item) => item.method === "textDocument/didClose")
      .length,
  ).toBeGreaterThanOrEqual(2);
  f.configuration.ignorePatterns = ["*.js", "main.ts"];
  expect((await f.service.collectContext()) ?? "").not.toContain(
    "fixture error",
  );
  // Each model-context refresh has the production 250 ms budget. Slow filesystems
  // may need subsequent normal boundaries to finish closing the already tracked files.
  for (
    let boundary = 0;
    boundary < 32 && (await f.service.status()).trackedDocuments;
    ++boundary
  )
    expect((await f.service.collectContext()) ?? "").not.toContain(
      "fixture error",
    );
  expect((await f.service.status()).trackedDocuments).toBe(0);
  await f.service.dispose();
  await expect(f.service.ensureStarted()).rejects.toMatchObject({
    code: "LSP_UNAVAILABLE",
  });
}, 30_000);
