import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { z } from "zod";
import {
  type ChiselExtension,
  defaultExtensions,
  defineTool,
} from "../../src/extensions/index.js";
import { userSkillsDir } from "../../src/paths/home.js";
import { RuntimeError } from "../../src/runtime/errors.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

// An explicit linked definition and renderer factory, usable unchanged in bundled/compiled builds.
// No production test flag, autoload, module mocks or model key for command execution.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-command-tui-"));
const firstRoot = join(storage, "workspace-a");
const secondRoot = join(storage, "workspace-b");
for (const root of [firstRoot, secondRoot]) await mkdir(root);
process.env.XDG_CONFIG_HOME = storage;
process.env.XDG_DATA_HOME = storage;
process.env.APPDATA = storage;
process.env.LOCALAPPDATA = storage;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CHISEL_ALT_SCREEN;
delete process.env.CHISEL_NO_ALT_SCREEN;
let modelCalls = 0;
let releaseModel = () => {};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "fixture-model",
            context_window: 65536,
            max_output_tokens: 1024,
          },
        ],
      });
    modelCalls++;
    const body = (await request.json()) as {
      messages: { role: string; content?: string }[];
    };
    assert.ok(
      body.messages.every((message) => message.role !== "tool"),
      "No orphan command tool results in model history",
    );
    await new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    return new Response(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Queued prompt completed" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`http://127.0.0.1:${server.port}/`))
      return nativeFetch(input, init);
    if (url.startsWith("https://api.github.com/"))
      return new Response("Offline update fixture", { status: 503 });
    throw new Error(`Unexpected external request: ${url}`);
  },
  { preconnect: nativeFetch.preconnect },
);
await mkdir(join(storage, "chiselcode"));
await writeFile(
  join(storage, "chiselcode", "config.json"),
  JSON.stringify({
    schemaVersion: 2,
    defaultProfileId: "fixture",
    profiles: {
      fixture: {
        providerId: "openai-compatible",
        defaultModel: "fixture-model",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    web: { enabled: false },
    permissions: { allowBypassPermissions: true },
  }),
);
await writeFile(join(firstRoot, "note.txt"), "initial\n");
await writeFile(join(secondRoot, "note.txt"), "other\n");
await writeFile(
  join(firstRoot, ".chiselrc"),
  JSON.stringify({ context: { maxInlineToolResultTokens: 128 } }),
);

let activations = 0;
let cleanups = 0;
let parses = 0;
let changes = 0;
let peeks = 0;
let feedbacks = 0;
let emptyWrites = 0;
let releaseSecond = () => {};
const waits = new Map<
  string,
  { release(): void; signal: AbortSignal; mode: string; sessionId: string }
>();
const executionOrder: string[] = [];
const extension: ChiselExtension = {
  id: "fixture.commands",
  async activate(ctx) {
    activations++;
    ctx.add({
      dispose: () => {
        cleanups++;
      },
    });
    if (ctx.workspaceRoot.endsWith("workspace-b"))
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
    ctx.tools.register(
      defineTool(
        {
          name: "pause",
          description: "Wait cooperatively",
          effect: "read",
          permission: "read",
          workspaceAccess: "none",
          parallelSafe: true,
        },
        z.object({ tag: z.string() }),
        async (_context, input) => ({
          data: input,
          preview: "Wait",
          resources: [],
        }),
        async (context, plan) => {
          const signal = context.signal;
          assert.ok(signal);
          await new Promise<void>((resolve) => {
            const finish = () => {
              signal.removeEventListener("abort", finish);
              resolve();
            };
            signal.addEventListener("abort", finish, { once: true });
            waits.set(plan.data.tag, {
              release: finish,
              signal,
              mode: context.mode ?? "build",
              sessionId: context.session.id,
            });
            if (signal.aborted) finish();
          });
          return { output: `Pause ${plan.data.tag} completed` };
        },
      ),
    );
    ctx.tools.register(
      defineTool(
        {
          name: "empty_write",
          description: "Fixture write with empty preview",
          effect: "workspace_write",
          permission: "write",
          parallelSafe: false,
        },
        z.object({}).strict(),
        async () => ({
          data: undefined,
          preview: "Empty write",
          resources: [],
          diffs: [],
        }),
        async () => {
          emptyWrites++;
          return { output: "Empty write executed" };
        },
      ),
    );
    ctx.tools.register(
      defineTool(
        {
          name: "large",
          description: "Large safe output",
          effect: "read",
          permission: "read",
          parallelSafe: true,
        },
        z.object({}).strict(),
        async () => ({
          data: undefined,
          preview: "Large output",
          resources: [],
        }),
        async () => ({
          output: `Fixture large output\n${"reference line\n".repeat(3000)}`,
          rawOutput: `token=fixture-secret\n${"reference line\n".repeat(3000)}`,
        }),
      ),
    );
    ctx.commands.register({
      name: "peek",
      description: `Read ${basename(ctx.workspaceRoot)}`,
      usage: "/peek",
      parse(args) {
        parses++;
        if (args) throw new Error("bad args token=secret");
        return undefined;
      },
      async execute(context) {
        peeks++;
        executionOrder.push(`peek:${context.mode}`);
        return context.tools.execute("read_file", { path: "note.txt" });
      },
    });
    ctx.commands.register({
      name: "change",
      description: "Change fixture note",
      usage: "/change <text>",
      parse: (args) => args,
      async execute(context, text) {
        changes++;
        await context.tools.execute("read_file", { path: "note.txt" });
        return context.tools.execute("write_file", {
          path: "note.txt",
          content: `${text}\n`,
        });
      },
    });
    ctx.commands.register({
      name: "pause",
      description: "Pause fixture operation",
      parse: (args) => args,
      execute(context, tag) {
        executionOrder.push(`pause:${context.mode}`);
        return context.tools.execute("ext:fixture.commands:pause", { tag });
      },
    });
    ctx.commands.register({
      name: "empty",
      description: "Check empty write permissions",
      parse: (args) => args,
      execute: (context) =>
        context.tools.execute("ext:fixture.commands:empty_write", {}),
    });
    ctx.commands.register({
      name: "large",
      description: "Read artifact",
      parse: (args) => args,
      execute: (context) =>
        context.tools.execute("ext:fixture.commands:large", {}),
    });
    ctx.commands.register({
      name: "recover",
      description: "A failed tool cannot become success",
      parse: (args) => args,
      async execute(context) {
        await context.tools.execute("run_shell", { command: "echo forbidden" });
        return { output: "FALSE_SUCCESS" };
      },
    });
    ctx.commands.register({
      name: "feedback",
      description: "Pure UI feedback",
      parse: (args) => args,
      execute(_context, text) {
        feedbacks++;
        return { output: `Feedback ${text}` };
      },
    });
    ctx.commands.register({
      name: "fail",
      description: "Safe callback errors",
      parse: (args) => args,
      execute() {
        throw new RuntimeError(
          "PERMISSION_DENIED",
          "token=fixture-secret\x1b[31m denied",
        );
      },
    });
  },
};

const setup = await createTestRenderer({
  width: 110,
  height: 36,
  exitOnCtrlC: false,
});
async function frame() {
  await act(async () => {
    await setup.renderOnce();
  });
}
async function until(ready: () => boolean, label: string) {
  for (let i = 0; i < 350; i++) {
    await act(async () => {
      await Bun.sleep(10);
      await setup.renderOnce();
    });
    if (ready()) return;
  }
  throw new Error(`${label}\n${setup.captureCharFrame()}`);
}
async function send(text: string) {
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
    setup.mockInput.pressEnter();
  });
  await frame();
}
async function idle() {
  await until(
    () => !setup.captureCharFrame().includes("Enter в очередь"),
    "Operation did not finish",
  );
}
let application: Promise<void> | undefined;
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: firstRoot },
      undefined,
      false,
      false,
      defaultExtensions([extension]),
      async () => setup.renderer,
    );
    await Bun.sleep(20);
  });
  await until(
    () => !!setup.renderer.root.findDescendantById("welcome"),
    "No welcome screen",
  );
  await until(
    () => activations === 1,
    "Scope did not activate before a prompt",
  );
  await send("/help");
  await until(
    () => setup.captureCharFrame().includes("Неизвестная команда /help"),
    "Removed help command was not rejected",
  );
  assert.ok(!setup.captureCharFrame().includes("быстрые команды"));
  assert.ok(setup.captureCharFrame().includes("Shift+Tab режим"));
  assert.ok(setup.captureCharFrame().includes("F4 разрешения"));
  assert.equal(peeks, 0);
  assert.equal(modelCalls, 0);
  assert.equal(
    setup.renderer.root.findDescendantById("session-tabs"),
    undefined,
  );
  await act(async () => {
    await setup.mockInput.pasteBracketedText("/pe");
  });
  await until(
    () => setup.captureCharFrame().includes("Read workspace-a"),
    "Autocomplete omitted contributions",
  );
  for (const direction of ["ARROW_DOWN", "ARROW_UP", "ARROW_DOWN"]) {
    await act(async () => {
      setup.mockInput.pressKey(direction);
    });
    await frame();
  }
  await act(async () => {
    setup.mockInput.pressTab();
  });
  assert.equal(setup.renderer.currentFocusedEditor?.plainText, "/peek ");
  assert.equal(peeks, 0);
  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await until(() => peeks === 1, "Completion did not submit exactly once");
  await idle();
  assert.equal(parses, 1);
  assert.equal(modelCalls, 0);
  assert.equal(activations, 1);
  assert.equal(cleanups, 0);
  assert.ok(!setup.renderer.root.findDescendantById("welcome"));
  await send("/peek bad");
  await until(
    () => setup.captureCharFrame().includes("неверные аргументы"),
    "Parse diagnostic was not rendered",
  );
  assert.equal(peeks, 1);
  assert.ok(setup.captureCharFrame().includes("неверные аргументы"));
  await send("/Peek");
  assert.equal(peeks, 1);
  assert.equal(modelCalls, 0);
  await send("/change denied");
  await until(
    () => !!setup.renderer.root.findDescendantById("approval-popup"),
    "Command tool did not open the ordinary approval popup",
  );
  await act(async () => {
    setup.mockInput.pressKey("n");
  });
  await idle();
  assert.equal(
    await readFile(join(firstRoot, "note.txt"), "utf8"),
    "initial\n",
  );
  assert.ok(setup.captureCharFrame().includes("PERMISSION_DENIED"));
  assert.equal(modelCalls, 0);
  await send("/permissions acceptEdits");
  await send("/change changed");
  await until(() => changes === 2, "Write command did not dispatch");
  await idle();
  assert.equal(
    await readFile(join(firstRoot, "note.txt"), "utf8"),
    "changed\n",
  );
  assert.equal(modelCalls, 0);
  const store = await projectSessionStore(firstRoot);
  let sessions = await store.list();
  assert.equal(sessions.length, 1, "Home allocated more than one session/tab");
  let persisted = await store.load(sessions[0]?.id ?? "");
  assert.equal(
    persisted.messages.length,
    0,
    "Command output leaked into model history",
  );
  assert.ok(Object.keys(persisted.runtime?.workspaceObservations ?? {}).length);
  assert.ok(
    Object.values(persisted.runtime?.invocations ?? {}).some(
      (record) => record.name === "write_file" && record.state === "succeeded",
    ),
  );
  await send("/plan");
  await send("/change plan-denied");
  await until(() => changes === 3, "Plan command missing");
  await idle();
  assert.equal(
    await readFile(join(firstRoot, "note.txt"), "utf8"),
    "changed\n",
  );
  assert.ok(
    setup.captureCharFrame().includes("MODE_RESTRICTION"),
    setup.captureCharFrame(),
  );
  await send("/build");
  await send("/permissions dontAsk");
  await send("/empty");
  await idle();
  assert.equal(emptyWrites, 0);
  await send("/recover");
  await idle();
  assert.ok(setup.captureCharFrame().includes("PERMISSION_DENIED"));
  assert.ok(!setup.captureCharFrame().includes("FALSE_SUCCESS"));
  await send("/fail");
  await idle();
  assert.ok(!setup.captureCharFrame().includes("fixture-secret"));
  assert.ok(setup.captureCharFrame().includes("fixture.commands"));
  await send("/large");
  await idle();
  persisted = await store.load(sessions[0]?.id ?? "");
  const large = Object.values(persisted.runtime?.invocations ?? {}).find(
    (record) => record.name === "ext:fixture.commands:large",
  );
  assert.equal(large?.state, "succeeded");
  assert.equal(large?.toolSource?.type, "extension");
  assert.equal(
    large?.result?.details?.extension &&
      (large.result.details.extension as { id: string }).id,
    "fixture.commands",
  );
  assert.ok(large?.result?.artifact);
  const home =
    process.platform === "win32"
      ? join(storage, "ChiselCode")
      : join(storage, "chiselcode");
  const artifactDirectory = join(home, "sessions", "artifacts", persisted.id);
  const artifacts = await readdir(artifactDirectory);
  assert.equal(
    artifacts.filter((file) => file.endsWith(".txt")).length,
    1,
    "Command duplicated a normalized tool artifact",
  );
  assert.ok(
    !(
      await readFile(join(artifactDirectory, artifacts[0] ?? ""), "utf8")
    ).includes("fixture-secret"),
  );

  await send("/pause mixed");
  await until(() => waits.has("mixed"), "Command did not become active");
  // Only ordinary prompts need this fixture provider key. All commands above ran without one.
  process.env.OPENAI_API_KEY = "fixture-offline-model-key";
  await send("queued prompt");
  assert.equal(modelCalls, 0);
  await send("/plan");
  await send("/peek");
  const peekBefore = peeks;
  waits.get("mixed")?.release();
  await until(() => modelCalls === 1, "Prompt was not queued behind command");
  assert.equal(peeks, peekBefore, "Command overtook the queued prompt");
  releaseModel();
  await until(
    () => peeks === peekBefore + 1,
    "Queued command did not run behind prompt",
  );
  await idle();
  assert.equal(
    executionOrder.at(-1),
    "peek:plan",
    "Queued command lost submit-time mode",
  );
  persisted = await store.load(persisted.id);
  assert.equal(persisted.messages.length, 2);
  assert.ok(
    persisted.messages.every((message) =>
      message.content.every((block) => block.type === "text"),
    ),
  );

  await send("/pause collision");
  await until(() => waits.has("collision"), "No collision wait");
  await send("/peek");
  const beforeCollision = peeks;
  const skill = join(userSkillsDir(), "peek");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: peek\ndescription: New skill\n---\nInspect project.\n",
  );
  waits.get("collision")?.release();
  await idle();
  assert.equal(
    peeks,
    beforeCollision,
    "Stale command intercepted a newly added skill",
  );
  await until(
    () =>
      setup
        .captureCharFrame()
        .replace(/\s+/g, " ")
        .includes("conflicts with skill /peek"),
    "No skill collision diagnostic",
  );
  await rm(skill, { recursive: true });

  await send("/build");
  await send("/pause first-tab");
  await until(() => waits.has("first-tab"), "First tab is not running");
  await send("/feedback discarded");
  await act(async () => {
    setup.mockInput.pressKey("g", { ctrl: true });
  });
  await frame();
  await send("/pause second-tab");
  await until(() => waits.has("second-tab"), "Second tab is not running");
  assert.notEqual(
    waits.get("first-tab")?.sessionId,
    waits.get("second-tab")?.sessionId,
  );
  assert.equal(activations, 1);
  await act(async () => {
    setup.mockInput.pressKey("ARROW_LEFT", { meta: true });
  });
  await frame();
  await act(async () => {
    setup.mockInput.pressCtrlC();
  });
  await until(
    () => waits.get("first-tab")?.signal.aborted === true,
    "Ctrl+C did not abort command tool",
  );
  await idle();
  assert.equal(waits.get("second-tab")?.signal.aborted, false);
  assert.equal(feedbacks, 0, "Cancelled queue callback replayed");
  assert.equal(cleanups, 0, "Tab cancellation disposed workspace services");
  waits.get("second-tab")?.release();
  await act(async () => {
    setup.mockInput.pressKey("ARROW_RIGHT", { meta: true });
  });
  await frame();
  await idle();
  await send("/feedback ordinary");
  await idle();
  assert.equal(feedbacks, 1);
  assert.equal(modelCalls, 1);

  // A late activation from B must not replace A's welcome projection after /cwd.
  await act(async () => {
    setup.mockInput.pressKey("g", { ctrl: true });
  });
  await frame();
  await send(`/cwd\t${secondRoot}`);
  await until(
    () => activations === 2,
    "Second workspace activation did not start",
  );
  await send("/cwd");
  await until(
    () => setup.captureCharFrame().includes("Чтобы сменить папку: /cwd <путь>"),
    "Built-in project feedback waited for the pending workspace activation",
  );
  await send("/peek");
  await act(async () => {
    setup.mockInput.pressCtrlC();
  });
  await frame();
  await send("/feedback HOME_BACKGROUND_REFERENCE");
  await act(async () => {
    setup.mockInput.pressKey("ARROW_LEFT", { meta: true });
  });
  await frame();
  releaseSecond();
  await until(
    () => feedbacks === 2,
    "A sibling activation waiter was cancelled or lost",
  );
  await frame();
  assert.equal(
    peeks,
    beforeCollision,
    "Cancelled activation wait executed a command later",
  );
  assert.equal(cleanups, 0, "Cancelling a caller disposed a shared activation");
  assert.ok(
    !setup.captureCharFrame().includes("Feedback HOME_BACKGROUND_REFERENCE"),
    "A late home command stole the selected conversation",
  );
  assert.ok(setup.renderer.root.findDescendantById("session-tab-3"));
  const otherSessions = await (await projectSessionStore(secondRoot)).list();
  assert.equal(otherSessions.length, 1);
  await act(async () => {
    setup.mockInput.pressKey("g", { ctrl: true });
  });
  await frame();
  await send(`/cwd\n${firstRoot}`);
  await send("/pe"); // First Enter accepts the suggestion only.
  assert.equal(peeks, beforeCollision);
  await act(async () => {
    setup.mockInput.pressEscape();
  });
  await frame();
  assert.ok(!setup.captureCharFrame().includes("Read workspace-b"));
  await act(async () => {
    setup.mockInput.pressKey("a", { ctrl: true });
    setup.mockInput.pressKey("k", { ctrl: true });
  });
  await send("/exit");
  await application;
  assert.equal(cleanups, 2);
  sessions = await store.list();
  assert.equal(sessions.length, 2);
  process.stdout.write(
    "Command contributions: TUI dispatch, tools, queue, cancellation, checkpoints and artifacts verified\n",
  );
} finally {
  releaseModel();
  releaseSecond();
  for (const wait of waits.values()) wait.release();
  if (application) {
    process.emit("SIGTERM");
    await application.catch(() => {});
  }
  setup.renderer.destroy();
  server.stop(true);
  await rm(storage, { recursive: true, force: true });
}
