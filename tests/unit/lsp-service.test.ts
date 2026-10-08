import { afterEach, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalWorkspaceRoot } from "../../src/extensions/host.js";
import type { LspConfiguration } from "../../src/lsp/config.js";
import {
  documentEnd,
  permittedLocation,
  readLspFile,
  validatePosition,
} from "../../src/lsp/documents.js";
import { LspService } from "../../src/lsp/service.js";
import { WorkspacePolicy } from "../../src/security/workspace-policy.js";
import { installedLsp } from "../fixtures/lsp-runtime.js";

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
  expect(await f.service.collectContext()).not.toContain("fixture error");
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
  expect(await f.service.collectContext()).not.toContain("fixture error");
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
  await symlink(outside, join(f.root, "escape.ts"));
  await expect(readLspFile(f.port, "escape.ts")).rejects.toThrow();
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
  const slow = await fixture({ requestDelay: 80 });
  await slow.service.ensureStarted();
  const pending = slow.service.definition(
    "main.ts",
    { line: 0, character: 0 },
    slow.port,
  );
  await Bun.sleep(35);
  await writeFile(join(slow.root, "main.ts"), "changed\n");
  await expect(pending).rejects.toMatchObject({ code: "STALE_FILE_REVISION" });
}, 15_000);

test("Full sync sends replacement bytes; project changes invalidate previously confirmed context", async () => {
  const f = await fixture({ sync: 1 });
  await f.service.diagnostics("main.ts", f.port);
  expect(await f.service.collectContext()).toContain("fixture error");
  f.configuration.project = { serverId: "peer" };
  expect(await f.service.collectContext()).not.toContain("fixture error");
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
  for (let i = 0; i < 65; i++) {
    const path = `doc${i}.js`;
    await writeFile(join(f.root, path), "const clean = 1;\n");
    await f.service.synchronizeDocument(path, f.port);
  }
  expect((await f.service.status()).trackedDocuments).toBe(64);
  expect(
    (await f.log()).filter((item) => item.method === "textDocument/didClose")
      .length,
  ).toBeGreaterThanOrEqual(2);
  f.configuration.ignorePatterns = ["*.js", "main.ts"];
  expect(await f.service.collectContext()).not.toContain("fixture error");
  expect((await f.service.status()).trackedDocuments).toBe(0);
  await f.service.dispose();
  await expect(f.service.ensureStarted()).rejects.toMatchObject({
    code: "LSP_UNAVAILABLE",
  });
}, 15_000);
