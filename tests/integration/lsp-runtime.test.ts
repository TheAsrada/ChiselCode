import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
import { runExtensionCommand } from "../../src/app/run-command.js";
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
import { lspServiceToken } from "../../src/lsp/service.js";
import { LspSettingsStore } from "../../src/lsp/settings.js";
import {
  type RuntimeEvent,
  RuntimeEventBus,
} from "../../src/runtime/events.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../../src/security/approval.js";
import { attachSessionRecorder } from "../../src/sessions/checkpoints.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import type {
  JsonObject,
  ToolExecutionResult,
} from "../../src/types/domain.js";
import {
  installedLsp,
  lspProcessTree,
  waitForLspProcessExit,
} from "../fixtures/lsp-runtime.js";

let directory: string;
const hosts: ExtensionHost[] = [];
const runtimes: Array<Awaited<ReturnType<typeof createSessionToolRuntime>>> =
  [];
const env = {
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chisel-real-lsp-"));
  process.env.XDG_DATA_HOME = directory;
  process.env.LOCALAPPDATA = directory;
});
afterEach(async () => {
  await Promise.allSettled(
    runtimes.splice(0).map((runtime) => runtime.dispose()),
  );
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});
async function fixture(mode: "auto" | "custom" = "custom") {
  const root = join(directory, "project");
  await mkdir(root);
  const canonical = await canonicalWorkspaceRoot(root);
  const configPath = join(directory, "config.json");
  await saveGlobalConfig(
    { schemaVersion: 2, profiles: {}, web: { enabled: false } },
    configPath,
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
  );
  await writeFile(
    join(root, "library.ts"),
    "export function greet(name: string) { return name; }\n",
  );
  await writeFile(
    join(root, "main.ts"),
    'import { greet } from "./library";\nexport const value: number = greet("world");\n',
  );
  const host = new ExtensionHost(defaultExtensions([], { configPath }));
  hosts.push(host);
  const scope = await host.open(root);
  const service = scope.services.get(lspServiceToken);
  const settings = new LspSettingsStore(root, configPath, {
    status: () => service.status(),
    apply: () => service.refreshConfiguration(),
    restart: async () => {
      throw new Error("Use the core command runtime in acceptance.");
    },
  });
  expect((await settings.load()).status).toMatchObject({
    mode: "auto",
    state: "stopped",
    generation: 0,
  });
  if (mode === "custom") {
    await settings.saveGlobal({
      mode: "custom",
      servers: { typescript: await installedLsp() },
    });
    expect((await settings.load()).status.state).toBe("untrusted");
    await settings.trust("typescript", true);
  }
  expect((await service.status()).generation).toBe(0);
  return { root: canonical, configPath, host, scope, service, settings };
}
async function runtime(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    mode?: "plan" | "build";
    approvalMode?: "default" | "dontAsk" | "acceptEdits";
    decision?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  } = {},
) {
  const session = createSession(f.root, "anthropic", "fixture");
  const events: RuntimeEvent[] = [];
  const bus = new RuntimeEventBus(session.id);
  bus.subscribe((event) => {
    events.push(event);
  });
  attachSessionRecorder(session, bus);
  const store = await projectSessionStore(f.root);
  const tools = await createSessionToolRuntime({
    root: f.root,
    session,
    store,
    scope: f.scope,
    config: await loadProjectConfig(f.root),
    global: await loadGlobalConfig(f.configPath),
    options: { configPath: f.configPath, interactive: true },
    mode: options.mode ?? "build",
    approvalMode: options.approvalMode ?? "default",
    events: bus,
    resolver: { requestApproval: options.decision ?? (async () => "approved") },
    signal: f.scope.signal,
  });
  runtimes.push(tools);
  const call = (
    name: string,
    input: JsonObject = {},
    signal?: AbortSignal,
    id = randomUUID(),
  ) => tools.executor.execute({ id, name, input }, signal);
  return { ...tools, call, session, events, store };
}
function lsp<T>(result: ToolExecutionResult): T {
  if (result.isError) throw new Error(`${result.errorCode}: ${result.output}`);
  return result.details?.lsp as T;
}
async function waitDiagnostics(
  r: Awaited<ReturnType<typeof runtime>>,
  predicate: (items: Array<{ code?: number | string }>) => boolean,
  path = "main.ts",
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = lsp<{
      freshness: string;
      revision: string;
      diagnostics: Array<{ code?: number | string }>;
    }>(await r.call("ext:builtin.lsp:diagnostics", { path }));
    if (predicate(result.diagnostics)) return result;
    await Bun.sleep(100);
  }
  throw new Error(
    "Real TypeScript diagnostics did not reach the expected update.",
  );
}

for (const backend of ["auto", "custom"] as const)
  test(`${backend}: real TypeScript tools initialise lazily, navigate, observe actual bytes, edit, clear errors and persist source`, async () => {
    const f = await fixture(backend);
    const r = await runtime(f);
    expect(f.scope.commands.descriptors().map((item) => item.name)).toContain(
      "lsp-status",
    );
    expect((await f.service.status()).state).toBe("stopped");
    expect((await f.service.status()).generation).toBe(0);
    const diagnostic = await waitDiagnostics(r, (items) =>
      items.some((item) => item.code === 2322),
    );
    expect(diagnostic.freshness).toBe("observed");
    const definition = lsp<{ locations: Array<{ path: string }> }>(
      await r.call("ext:builtin.lsp:definition", {
        path: "main.ts",
        line: 0,
        character: 10,
      }),
    );
    expect(
      definition.locations.some((location) => location.path === "library.ts"),
    ).toBe(true);
    const target = await r.call("edit_file", {
      path: "library.ts",
      old_str: "name: string",
      new_str: "name: number",
    });
    expect(target.errorCode).toBe("STALE_FILE_REVISION"); // A location alone is not a read observation.
    const references = lsp<{ locations: Array<{ path: string }> }>(
      await r.call("ext:builtin.lsp:references", {
        path: "library.ts",
        line: 0,
        character: 17,
      }),
    );
    expect(
      references.locations.some((location) => location.path === "main.ts"),
    ).toBe(true);
    const symbols = lsp<{ symbols: Array<{ name: string }> }>(
      await r.call("ext:builtin.lsp:symbols", { path: "library.ts" }),
    );
    expect(symbols.symbols.some((symbol) => symbol.name === "greet")).toBe(
      true,
    );
    expect(
      (
        await r.call("edit_file", {
          path: "main.ts",
          old_str: "value: number",
          new_str: "value: string",
        })
      ).isError,
    ).not.toBe(true);
    const cleared = await waitDiagnostics(
      r,
      (items) => !items.some((item) => item.code === 2322),
    );
    expect(cleared.revision).not.toBe(diagnostic.revision);
    expect(cleared.freshness).toBe("observed");
    expect(await f.service.collectContext()).not.toContain("2322");
    await writeFile(
      join(f.root, "main.ts"),
      (await readFile(join(f.root, "main.ts"), "utf8")).replace(
        "value: string",
        "value: number",
      ),
    );
    expect(
      (
        await waitDiagnostics(r, (items) =>
          items.some((item) => item.code === 2322),
        )
      ).freshness,
    ).toBe("observed");
    const saved = await r.store.load(r.session.id);
    const record = Object.values(saved.runtime?.invocations ?? {}).find(
      (item) => item.name === "ext:builtin.lsp:diagnostics",
    );
    expect(record?.toolSource).toEqual({
      type: "extension",
      extensionId: "builtin.lsp",
      originalName: "diagnostics",
    });
    expect(saved.messages).toHaveLength(0);
    const id = randomUUID();
    const original = await r.call("ext:builtin.lsp:status", {}, undefined, id);
    expect(await r.call("ext:builtin.lsp:status", {}, undefined, id)).toEqual(
      original,
    );
    await r.dispose();
    expect((await f.service.status()).state).toBe("ready");
    const descendants = await lspProcessTree();
    expect(descendants.length).toBeGreaterThanOrEqual(2);
    await f.host.dispose();
    expect((await f.service.status()).state).toBe("disposed");
    await waitForLspProcessExit(descendants);
  }, 30_000);

test("Plan reads analyse with trust; restart Plan/user deny/Dont Ask preserve the existing generation", async () => {
  const f = await fixture();
  const plan = await runtime(f, { mode: "plan" });
  expect(
    (await plan.call("ext:builtin.lsp:diagnostics", { path: "main.ts" }))
      .isError,
  ).not.toBe(true);
  const generation = (await f.service.status()).generation;
  expect((await plan.call("ext:builtin.lsp:restart")).errorCode).toBe(
    "MODE_RESTRICTION",
  );
  expect(
    plan.events.some(
      (event) =>
        event.type === "tool_started" &&
        event.name === "ext:builtin.lsp:restart",
    ),
  ).toBe(false);
  const deny = await runtime(f, { decision: async () => "denied" });
  expect((await deny.call("ext:builtin.lsp:restart")).errorCode).toBe(
    "PERMISSION_DENIED",
  );
  const dontAsk = await runtime(f, { approvalMode: "dontAsk" });
  expect((await dontAsk.call("ext:builtin.lsp:restart")).errorCode).toBe(
    "PERMISSION_DENIED",
  );
  expect((await f.service.status()).generation).toBe(generation);
  const command = f.scope.commands.get("lsp-restart");
  const outcome = await runExtensionCommand(
    { command, input: command.parse("typescript") },
    f.scope,
    { cwd: f.root, configPath: f.configPath, mode: "build", interactive: true },
    {
      requestApproval: async (request) => {
        expect(request.source).toEqual({
          type: "extension",
          extensionId: "builtin.lsp",
          originalName: "restart",
        });
        return "approved";
      },
    },
  );
  expect(outcome.result.isError).not.toBe(true);
  expect((await f.service.status()).generation).toBe(generation + 1);
  expect((await f.service.status()).trackedDocuments).toBeGreaterThan(0);
}, 30_000);

for (const backend of ["auto", "custom"] as const)
  test(`${backend}: borrowed runs share a generation; one caller cancellation and binding detach do not cancel a sibling`, async () => {
    const f = await fixture(backend);
    const a = await runtime(f);
    const b = await runtime(f);
    const alias = join(directory, "alias");
    await symlink(
      f.root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(await f.host.open(alias)).toBe(f.scope);
    const abort = new AbortController();
    const first = a.call(
      "ext:builtin.lsp:diagnostics",
      { path: "main.ts" },
      abort.signal,
    );
    const second = b.call("ext:builtin.lsp:diagnostics", {
      path: "library.ts",
    });
    abort.abort();
    expect((await first).errorCode).toBe("CANCELLED");
    expect((await second).isError).not.toBe(true);
    expect((await f.service.status()).generation).toBe(1);
    await a.dispose();
    expect(
      (await b.call("ext:builtin.lsp:symbols", { path: "library.ts" })).isError,
    ).not.toBe(true);
    expect((await f.service.status()).state).toBe("ready");
    if (backend === "auto")
      await f.settings.saveGlobal({ mode: "off", servers: {} });
    else await f.settings.trust("typescript", false);
    expect((await f.service.status()).state).toBe(
      backend === "auto" ? "disabled" : "untrusted",
    );
    expect(
      (await b.call("ext:builtin.lsp:diagnostics", { path: "main.ts" }))
        .errorCode,
    ).toBe(backend === "auto" ? "LSP_UNAVAILABLE" : "PERMISSION_DENIED");
    expect(await f.service.collectContext()).toBeUndefined();
  }, 30_000);

test("Auto detects nested TS/JS projects; unsupported files do not start it; global Off/custom trust changes fence the old process", async () => {
  const f = await fixture("auto");
  const r = await runtime(f, { mode: "plan" });
  await writeFile(join(f.root, "unsupported.py"), "x = 1\n");
  expect(
    (await r.call("ext:builtin.lsp:diagnostics", { path: "unsupported.py" }))
      .errorCode,
  ).toBe("LSP_UNSUPPORTED");
  expect((await f.service.status()).generation).toBe(0);
  await writeFile(
    join(f.root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: false }, include: ["*.ts"] }),
  );
  await mkdir(join(f.root, "nested"));
  await writeFile(
    join(f.root, "nested/tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true },
      include: ["*.ts", "*.tsx"],
    }),
  );
  await writeFile(
    join(f.root, "nested/strict.ts"),
    "export function nested(value) { return value; }\n",
  );
  const strict = await waitDiagnostics(
    r,
    (items) => items.some((item) => item.code === 7006),
    "nested/strict.ts",
  );
  expect(strict.diagnostics.some((item) => item.code === 7006)).toBe(true);
  await writeFile(
    join(f.root, "nested/view.tsx"),
    "export function view() { return 1; }\n",
  );
  expect(
    lsp<{ symbols: Array<{ name: string }> }>(
      await r.call("ext:builtin.lsp:symbols", { path: "nested/view.tsx" }),
    ).symbols.some((item) => item.name === "view"),
  ).toBe(true);
  await mkdir(join(f.root, "javascript"));
  await writeFile(
    join(f.root, "javascript/jsconfig.json"),
    JSON.stringify({
      compilerOptions: { checkJs: true, allowJs: true, jsx: "preserve" },
      include: ["*.js", "*.jsx"],
    }),
  );
  for (const extension of ["js", "jsx"]) {
    await writeFile(
      join(f.root, `javascript/example-${extension}.${extension}`),
      '/** @type {number} */\nexport const example = "wrong";\n',
    );
    const result = await waitDiagnostics(
      r,
      (items) => items.some((item) => item.code === 2322),
      `javascript/example-${extension}.${extension}`,
    );
    expect(result.diagnostics.some((item) => item.code === 2322)).toBe(true);
  }
  const pids = await lspProcessTree();
  expect(pids.length).toBeGreaterThanOrEqual(2);
  await f.settings.saveGlobal({
    mode: "custom",
    servers: { typescript: await installedLsp() },
  });
  await waitForLspProcessExit(pids);
  expect((await f.service.status()).state).toBe("untrusted");
  expect(
    (await r.call("ext:builtin.lsp:diagnostics", { path: "main.ts" }))
      .errorCode,
  ).toBe("PERMISSION_DENIED");
  const settings = await f.settings.load();
  await f.settings.saveProject({ mode: "auto" }, settings.projectRevision);
  expect(
    (await r.call("ext:builtin.lsp:symbols", { path: "library.ts" })).isError,
  ).not.toBe(true);
  expect((await f.service.status()).mode).toBe("auto");
  await f.settings.saveGlobal({ mode: "off", servers: {} });
  expect((await f.service.status()).state).toBe("disabled");
  expect(await f.service.collectContext()).toBeUndefined();
}, 30_000);

test("Auto never executes a modified cached backend; restart repairs the pinned payload before launching", async () => {
  const f = await fixture("auto");
  const r = await runtime(f);
  expect(
    (await r.call("ext:builtin.lsp:symbols", { path: "library.ts" })).isError,
  ).not.toBe(true);
  const launch = await f.service.launchPreview();
  const marker = join(f.root, "untrusted-backend-executed");
  const entrypoint = launch.args[0];
  if (!entrypoint)
    throw new Error("Auto launch omitted its backend entrypoint.");
  await writeFile(
    entrypoint,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe'); process.exit(1);`,
  );
  expect((await r.call("ext:builtin.lsp:restart")).isError).not.toBe(true);
  expect((await f.service.status()).state).toBe("ready");
  expect(
    await readFile(marker, "utf8").catch(
      (error) => (error as NodeJS.ErrnoException).code,
    ),
  ).toBe("ENOENT");
  expect(
    (await r.call("ext:builtin.lsp:symbols", { path: "library.ts" })).isError,
  ).not.toBe(true);
}, 30_000);
