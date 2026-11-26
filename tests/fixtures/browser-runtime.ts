import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionToolRuntime } from "../../src/app/tool-runtime.js";
import { browserInstallState } from "../../src/browser/install.js";
import { loadGlobalConfig, loadProjectConfig } from "../../src/config/load.js";
import { createBrowserExtension } from "../../src/extensions/builtins/browser.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ExtensionManagementService } from "../../src/extensions/management.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import type { ApprovalResolver } from "../../src/security/approval.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import type {
  JsonObject,
  ToolExecutionResult,
} from "../../src/types/domain.js";

assert.equal(
  await browserInstallState(),
  "ready",
  "Run /browser install in the test data directory first.",
);
const directory = await mkdtemp("/tmp/chisel-qa-");
const root = join(directory, "project");
const otherRoot = join(directory, "other-project");
await Promise.all([mkdir(root), mkdir(otherRoot)]);
const configPath = join(directory, "config.json");
let forbiddenHits = 0;
let slowReached: () => void = () => {};
const outside = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    ++forbiddenHits;
    return new Response("forbidden");
  },
});
const initialCss =
  "body{margin:0;font:16px sans-serif}main{width:560px;background:#e5efff}button{background:#283576;color:white}";
await writeFile(join(root, "style.css"), initialCss);
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/socket" && server.upgrade(request)) return;
    if (path === "/style.css")
      return new Response(Bun.file(join(root, "style.css")), {
        headers: { "content-type": "text/css", "cache-control": "no-cache" },
      });
    if (path === "/bad") return new Response("fixture error", { status: 500 });
    if (path === "/redirect") return Response.redirect(outside.url.href);
    if (path === "/slow") {
      slowReached();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode("<!doctype html><title>Slow"),
            );
          },
        }),
        { headers: { "content-type": "text/html" } },
      );
    }
    return new Response(
      `<!doctype html><title>QA fixture</title>
      <link rel="stylesheet" href="/style.css">
      <main><h1>Order form</h1><form><label>Contact <input placeholder="Contact"></label>
      <button type="submit">Send</button></form><p id="status">Ready</p></main>
      <img src="${outside.url}image"><iframe src="${outside.url}frame" hidden></iframe>
      <script>
        const status = document.querySelector('#status');
        document.forms[0].onsubmit = (event) => { event.preventDefault(); status.textContent = 'Submitted'; };
        fetch('/bad?token=hidden');
        window.open('${outside.url}popup');
        new WebSocket('ws://127.0.0.1:${outside.port}/blocked');
        const socket = new WebSocket('ws://' + location.host + '/socket');
        socket.onmessage = () => { document.body.dataset.socket = 'connected'; console.info('HMR fixture connected'); };
        setTimeout(() => { throw new Error('Fixture exception'); }, 0);
      </script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
  websocket: {
    open(socket) {
      socket.send("connected");
    },
    message() {},
  },
});
const settings = (enabled = true, origins = [app.url.origin]) =>
  writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      profiles: {},
      browser: { enabled, origins },
    }),
  );
await settings();
const host = new ExtensionHost([createBrowserExtension({ configPath })]);
host.configureOwnerAvailability(
  async (_id, workspace) =>
    (await loadGlobalConfig(configPath)).browser?.enabled !== false &&
    (await loadProjectConfig(workspace)).browser?.enabled !== false,
);
const scope = await host.open(root);
const otherScope = await host.open(otherRoot);
const manager = new ExtensionManagementService({
  configPath,
  applyBuiltin: (id) => host.refreshOwner(id),
  builtinRecovery: (id) => scope.ownerCleanupFailed(id),
});
const owner = new AbortController();
const sibling = new AbortController();
const other = new AbortController();
type Runtime = Awaited<ReturnType<typeof createSessionToolRuntime>>;
const runtimes: Runtime[] = [];
async function runtime(
  lifetime: AbortController,
  resolver: ApprovalResolver,
  mode: "plan" | "build" = "build",
  workspace = scope,
) {
  const project = workspace.workspaceRoot;
  const store = await projectSessionStore(project);
  const session = createSession(project, "openai", "fixture");
  await store.save(session);
  const tools = await createSessionToolRuntime({
    root: project,
    config: await loadProjectConfig(project),
    global: await loadGlobalConfig(configPath),
    store,
    session,
    scope: workspace,
    options: {
      configPath,
      interactive: true,
      subagentOwner: {
        conversationId: session.id,
        generation: 1,
        signal: lifetime.signal,
        assertAvailable: () => workspace.assertUsable(),
      },
    },
    mode,
    approvalMode: "default",
    signal: new AbortController().signal,
    resolver,
    events: new RuntimeEventBus(session.id),
  });
  runtimes.push(tools);
  return tools;
}
const approve = { requestApproval: async () => "approved" as const };
const call = (
  tools: Runtime,
  name: string,
  input: JsonObject = {},
  signal?: AbortSignal,
) =>
  tools.executor.execute(
    {
      id: crypto.randomUUID(),
      name: `ext:builtin.browser:${name}`,
      input,
    },
    signal,
  );
function result<T>(value: ToolExecutionResult): T {
  assert.ok(!value.isError && !value.requiresApproval, value.output);
  return JSON.parse(value.output) as T;
}
type Page = {
  id: string;
  snapshot: {
    overflow: number;
    accessibility: string;
    refs: { id: string; label: string }[];
  };
  viewport: { width: number; height: number };
};
type Capture = {
  screenshot: {
    uri: string;
    width: number;
    height: number;
    modelImage: string;
  };
};
type Status = { tabs: { id: string }[] };
function browserChildren() {
  const { stdout } = Bun.spawnSync([
    "/usr/bin/ps",
    "--ppid",
    String(process.pid),
    "-o",
    "pid=,args=",
  ]);
  return stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const pid =
        /^\s*(\d+) \/usr\/bin\/bwrap .*\/tmp\/chisel-browser-[^ ]+\/egress\.sock /.exec(
          line,
        )?.[1];
      return pid ? [Number(pid)] : [];
    });
}

async function checkEventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Timed out waiting for browser event");
    await Bun.sleep(25);
  }
}

try {
  const denied = await runtime(new AbortController(), {
    requestApproval: async () => "denied",
  });
  assert.equal(
    (await call(denied, "open", { url: app.url.href })).errorCode,
    "PERMISSION_DENIED",
  );
  const plan = await runtime(new AbortController(), approve, "plan");
  assert.equal(
    (await call(plan, "open", { url: app.url.href })).errorCode,
    "MODE_RESTRICTION",
  );
  const revoked = await runtime(new AbortController(), {
    requestApproval: async () => {
      await settings(true, []);
      return "approved";
    },
  });
  assert.equal(
    (await call(revoked, "open", { url: app.url.href })).errorCode,
    "BROWSER_ACCESS_DENIED",
  );
  await settings();
  const tools = await runtime(owner, approve);
  const page = result<Page>(await call(tools, "open", { url: app.url.href }));
  assert.equal(page.viewport.width, 1280);
  assert.equal(page.snapshot.overflow, 0);
  const beforeDesktop = result<Capture>(await call(tools, "screenshot"));
  assert.equal(beforeDesktop.screenshot.width, 1280);
  const mobile = result<Page>(
    await call(tools, "navigate", { action: "viewport", preset: "phone" }),
  );
  assert.equal(mobile.snapshot.overflow, 170);
  assert.equal(
    (
      await call(tools, "interact", {
        operation: "click",
        ref: page.snapshot.refs[0]?.id,
      })
    ).errorCode,
    "BROWSER_STALE",
  );
  result(
    await call(tools, "interact", {
      operation: "fill",
      selector: "input",
      value: "fixture private field",
    }),
  );
  const submitted = result<Page>(
    await call(tools, "interact", { operation: "click", selector: "button" }),
  );
  assert.match(submitted.snapshot.accessibility, /Submitted/);
  assert.doesNotMatch(
    submitted.snapshot.accessibility,
    /fixture private field/,
  );
  const phone = result<Capture>(
    await call(tools, "screenshot", { modelImage: true }),
  );
  assert.deepEqual(
    [phone.screenshot.width, phone.screenshot.height],
    [390, 844],
  );
  assert.equal(phone.screenshot.modelImage, "unavailable");
  const artifact = fileURLToPath(phone.screenshot.uri);
  assert.equal((await stat(artifact)).mode & 0o777, 0o600);
  assert.equal((await readFile(artifact)).readUInt32BE(16), 390);
  await checkEventually(async () => {
    const console = result(
      await call(tools, "diagnostics", { kind: "console" }),
    );
    return (
      /Fixture exception/.test(JSON.stringify(console)) &&
      /HMR fixture connected/.test(JSON.stringify(console))
    );
  });
  const network = await call(tools, "diagnostics", { kind: "network" });
  assert.match(network.output, /"status":500/);
  assert.doesNotMatch(network.output, /token=hidden/);
  const css = await tools.executor.execute({
    id: crypto.randomUUID(),
    name: "read_file",
    input: { path: "style.css" },
  });
  assert.ok(!css.isError && css.output.includes("width:560px"));
  const edit = await tools.executor.execute({
    id: crypto.randomUUID(),
    name: "edit_file",
    input: {
      path: "style.css",
      old_str: "width:560px",
      new_str: "width:560px;max-width:100%",
    },
  });
  assert.ok(!edit.isError && !edit.requiresApproval, edit.output);
  assert.match(
    await readFile(join(root, "style.css"), "utf8"),
    /max-width:100%/,
  );
  const fixed = result<Page>(
    await call(tools, "navigate", { action: "reload" }),
  );
  assert.equal(fixed.snapshot.overflow, 0);
  result(
    await call(tools, "interact", {
      operation: "fill",
      selector: "input",
      value: "repeat",
    }),
  );
  assert.match(
    result<Page>(
      await call(tools, "interact", { operation: "click", selector: "button" }),
    ).snapshot.accessibility,
    /Submitted/,
  );
  result(
    await call(tools, "navigate", { action: "viewport", preset: "desktop" }),
  );
  const desktop = result<Capture>(await call(tools, "screenshot"));
  assert.deepEqual(
    [desktop.screenshot.width, desktop.screenshot.height],
    [1280, 800],
  );
  assert.equal(
    (await call(tools, "open", { url: new URL("/redirect", app.url).href }))
      .errorCode,
    "BROWSER_NAVIGATION_FAILED",
  );
  assert.equal(
    forbiddenHits,
    0,
    "Cross-origin redirect, frame, image, popup and socket must never reach the server",
  );
  const sisterTools = await runtime(sibling, approve);
  assert.equal(
    (await call(sisterTools, "status", { tab: page.id })).errorCode,
    "BROWSER_STALE",
  );
  const sisterTab = result<Page>(
    await call(sisterTools, "open", { url: app.url.href }),
  );
  const otherTools = await runtime(other, approve, "build", otherScope);
  assert.equal(
    (await call(otherTools, "status", { tab: sisterTab.id })).errorCode,
    "BROWSER_STALE",
  );
  assert.equal(
    (await call(otherTools, "open", { url: outside.url.href })).errorCode,
    "BROWSER_ACCESS_DENIED",
  );

  const cancellation = new AbortController();
  const reached = Promise.withResolvers<void>();
  slowReached = reached.resolve;
  const cancelled = call(
    tools,
    "open",
    { url: new URL("/slow", app.url).href },
    cancellation.signal,
  );
  await Promise.race([
    reached.promise,
    Bun.sleep(8_000).then(() => {
      throw new Error("No slow request");
    }),
  ]);
  cancellation.abort();
  assert.equal((await cancelled).errorCode, "CANCELLED");
  assert.equal(
    result<Status>(await call(sisterTools, "status")).tabs.length,
    1,
  );
  assert.equal(result<Status>(await call(tools, "status")).tabs.length, 2);
  assert.equal(
    (await call(tools, "open", { url: new URL("/slow", app.url).href }))
      .errorCode,
    "TOOL_TIMEOUT",
  );
  assert.equal(result<Status>(await call(tools, "status")).tabs.length, 2);

  const pending = Promise.withResolvers<void>();
  const awaiting = await runtime(new AbortController(), {
    async requestApproval(_request, signal) {
      pending.resolve();
      return new Promise((resolve) =>
        signal?.addEventListener("abort", () => resolve("denied"), {
          once: true,
        }),
      );
    },
  });
  const awaitingApproval = call(awaiting, "open", { url: app.url.href });
  await Promise.race([
    pending.promise,
    Bun.sleep(8_000).then(() => {
      throw new Error("No approval");
    }),
  ]);
  const inFlight = Promise.withResolvers<void>();
  slowReached = inFlight.resolve;
  const interrupted = call(tools, "open", {
    url: new URL("/slow", app.url).href,
  });
  await Promise.race([
    inFlight.promise,
    Bun.sleep(8_000).then(() => {
      throw new Error("No active request");
    }),
  ]);
  const item = (await manager.list(root)).items.find(
    (row) => row.id === "builtin.browser",
  );
  assert.ok(item?.digest);
  await manager.setEnabled({
    id: item.id,
    enabled: false,
    revision: item.revision,
    digest: item.digest,
    path: root,
  });
  assert.equal((await awaitingApproval).errorCode, "CANCELLED");
  assert.equal((await interrupted).errorCode, "CANCELLED");
  assert.deepEqual(browserChildren(), []);
  assert.equal(
    scope.commands.descriptors().some((row) => row.name === "browser"),
    false,
  );
  assert.equal(await Bun.file(artifact).exists(), false);
  assert.ok((await call(tools, "status")).isError);
  const disabled = (await manager.list(root)).items.find(
    (row) => row.id === item.id,
  );
  assert.ok(disabled?.digest);
  await manager.setEnabled({
    id: disabled.id,
    enabled: true,
    revision: disabled.revision,
    digest: disabled.digest,
    path: root,
  });
  assert.equal(result<Status>(await call(tools, "status")).tabs.length, 0);
  result(await call(tools, "open", { url: app.url.href }));
  const children = browserChildren();
  assert.equal(children.length, 1, "Expected one owned Chromium launcher");
  const pid = children[0];
  assert.ok(pid);
  process.kill(pid, "SIGKILL");
  await checkEventually(
    async () => result<Status>(await call(tools, "status")).tabs.length === 0,
  );
  result(await call(tools, "open", { url: app.url.href }));
  await settings(true, []);
  await checkEventually(async () => browserChildren().length === 0);
  assert.equal(result<Status>(await call(tools, "status")).tabs.length, 0);
  await settings();
  result(await call(tools, "open", { url: app.url.href }));
  assert.equal(forbiddenHits, 0);
  console.log(
    "Browser QA: approvals, viewport 170px → 0px, form, PNG, diagnostics, egress, isolation, cancellation, timeout, disable/enable, crash and revocation.",
  );
} finally {
  owner.abort();
  sibling.abort();
  other.abort();
  await Promise.allSettled(runtimes.map((tools) => tools.dispose()));
  await host.dispose();
  outside.stop(true);
  app.stop(true);
  await rm(directory, { recursive: true, force: true });
}
