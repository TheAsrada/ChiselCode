import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-btw-tui-"));
const root = join(storage, "workspace");
await mkdir(root);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = storage;
process.env.OPENAI_API_KEY = "fixture-offline-btw-key";
delete process.env.CHISEL_ALT_SCREEN;
delete process.env.CHISEL_NO_ALT_SCREEN;
let releaseMain!: () => void;
const mainBarrier = new Promise<void>((resolve) => {
  releaseMain = resolve;
});
let releaseSide!: () => void;
const sideBarrier = new Promise<void>((resolve) => {
  releaseSide = resolve;
});
let mainCalls = 0;
let sideCalls = 0;
const requests: Record<string, unknown>[] = [];
const chunk = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
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
            max_output_tokens: 4096,
          },
        ],
      });
    const body = (await request.json()) as Record<string, unknown>;
    requests.push(body);
    if ((body.tools as unknown[] | undefined)?.length) {
      mainCalls++;
      if (mainCalls === 1) {
        await mainBarrier;
        return new Response(
          `data: ${JSON.stringify({ id: "main", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "new.txt", content: "denied" }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(
        `${chunk("Основная задача завершена", "stop")}data: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    sideCalls++;
    assert.ok(
      JSON.stringify(body).includes("основную задачу"),
      "Submit-time accepted prompt absent from snapshot",
    );
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              chunk(
                "Побочный ответ: " +
                  "Контекст зафиксирован на момент отправки. ".repeat(12) +
                  "\n```ts\nconst answer = 42;\n",
              ),
            ),
          );
          await sideBarrier;
          controller.enqueue(
            new TextEncoder().encode(
              chunk(
                "```\nОтвет завершён независимо от основной задачи.",
                "stop",
              ) +
                `data: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 25, completion_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
            ),
          );
          controller.close();
        },
      }),
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
    return new Response("Offline fixture", { status: 503 });
  },
  { preconnect: nativeFetch.preconnect },
);
const configPath = join(storage, "selected-config.json");
await writeFile(
  configPath,
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
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
    ui: { unicodeDecorations: true },
  }),
);
const setup = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
async function frame() {
  await act(async () => {
    await setup.renderOnce();
  });
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
) {
  for (let index = 0; index < 500; index++) {
    await act(async () => {
      await Bun.sleep(10);
      await setup.renderOnce();
    });
    if (await predicate()) return;
  }
  throw new Error(`${label}\n${setup.captureCharFrame()}`);
}
async function key(name: string, ctrl = false) {
  await act(async () => {
    setup.mockInput.pressKey(name, { ctrl });
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame();
}
async function send(text: string) {
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
    setup.mockInput.pressEnter();
  });
  await frame();
}
const captures = process.env.CHISEL_CAPTURE_DIR;
async function capture(name: string) {
  if (!captures) return;
  await mkdir(captures, { recursive: true });
  await frame();
  await writeFile(join(captures, `${name}.txt`), setup.captureCharFrame());
  await writeFile(
    join(captures, `${name}.json`),
    JSON.stringify({
      ...setup.captureSpans(),
      lines: setup.captureSpans().lines.map((line) => ({
        spans: line.spans.map((span) => ({
          ...span,
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
        })),
      })),
    }),
  );
}
let application: Promise<void> | undefined;
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath },
      undefined,
      false,
      false,
      undefined,
      async () => setup.renderer,
    );
    await Bun.sleep(20);
  });
  await until(
    () => !!setup.renderer.root.findDescendantById("welcome"),
    "Welcome missing",
  );
  await send("Выполни основную задачу");
  await until(
    () => mainCalls === 1,
    "Foreground did not reach endpoint barrier",
  );
  await send(
    "/btw Почему это безопасно, если основной запрос ещё выполняется?",
  );
  await until(
    () =>
      sideCalls === 1 && setup.captureCharFrame().includes("Побочный ответ"),
    "Side request blocked behind foreground",
  );
  assert.ok(setup.renderer.root.findDescendantById("side-query-popup"));
  assert.equal(mainCalls, 1);
  await capture("receiving-120x40");
  const mainEditor = setup.renderer.root.findDescendantById("prompt-editor");
  await key("TAB");
  await key("y");
  assert.equal(mainCalls, 1);
  await key("ESCAPE");
  assert.equal(
    setup.renderer.root.findDescendantById("side-query-popup"),
    undefined,
  );
  await capture("hidden-running-120x40");
  await key("F6");
  await until(
    () => !!setup.renderer.root.findDescendantById("side-query-popup"),
    "F6 did not reopen",
  );
  assert.equal(sideCalls, 1);
  await act(async () => {
    releaseMain();
  });
  await until(
    () => !!setup.renderer.root.findDescendantById("approval-popup"),
    "Foreground approval missing",
  );
  assert.equal(
    setup.renderer.root.findDescendantById("side-query-popup"),
    undefined,
    "Approval must preempt side view",
  );
  await capture("approval-preempts-120x40");
  await act(async () => {
    releaseSide();
  });
  const store = await projectSessionStore(root);
  await until(async () => {
    const sessions = await store.list();
    return (
      !!sessions[0] &&
      (await store.load(sessions[0].id)).sideQueries?.[0]?.status ===
        "completed"
    );
  }, "Side did not complete while approval stayed open");
  assert.ok(setup.renderer.root.findDescendantById("approval-popup"));
  await key("n");
  await until(
    () =>
      mainCalls === 2 &&
      !!setup.renderer.root.findDescendantById("side-query-popup"),
    "Approval did not return side view",
  );
  await capture("completed-120x40");
  for (const [width, height] of [
    [100, 30],
    [80, 24],
    [60, 20],
    [40, 12],
    [24, 8],
  ]) {
    await act(async () => {
      assert.ok(width !== undefined && height !== undefined);
      setup.renderer.resize(width, height);
    });
    await frame();
    await capture(`completed-${width}x${height}`);
    assert.ok(setup.renderer.root.findDescendantById("side-hide"));
  }
  await key("TAB");
  await key("TAB");
  await key("TAB");
  await key("TAB");
  await frame();
  await capture("focused-action-24x8");
  await key("ESCAPE");
  assert.ok(
    setup.renderer.root.findDescendantById("prompt-editor") === mainEditor,
    "Hide replaced foreground composer",
  );
  await act(async () => {
    setup.renderer.resize(120, 40);
  });
  await key("F6");
  await frame();
  const newButton = setup.renderer.root.findDescendantById("side-new");
  assert.ok(newButton);
  await act(async () => {
    await setup.mockMouse.click(newButton.x + 1, newButton.y);
  });
  await frame();
  await act(async () => {
    await setup.mockInput.pasteBracketedText(
      "Новый вопрос с отдельным черновиком",
    );
  });
  await capture("new-question-draft-120x40");
  assert.equal(sideCalls, 1, "Presentation started another request");
  await key("ESCAPE");
  await until(
    () => !setup.captureCharFrame().includes("Enter в очередь"),
    "Foreground did not finish",
  );
  const sessions = await store.list();
  assert.equal(sessions.length, 1, "Competing session allocations");
  const summary = sessions[0];
  assert.ok(summary);
  const saved = await store.load(summary.id);
  assert.equal(saved.sideQueries?.length, 1);
  assert.equal(saved.sideQueries?.[0]?.usage?.inputTokens, 25);
  assert.equal(saved.totalTokens.inputTokens, 25);
  assert.ok(!JSON.stringify(saved.messages).includes("Побочный ответ"));
  assert.ok(!JSON.stringify(saved.messages).includes("Почему это безопасно"));
  assert.equal((requests[1]?.tools as unknown[] | undefined)?.length ?? 0, 0);
  await key("w", true);
  await until(
    () => !!setup.renderer.root.findDescendantById("welcome"),
    "Idle conversation did not close",
  );
  await send(`/resume ${saved.id}`);
  await until(
    () => setup.captureCharFrame().includes("Побочный вопрос"),
    "Resume lost side record",
  );
  assert.equal(
    setup.renderer.root.findDescendantById("side-query-popup"),
    undefined,
  );
  await key("F6");
  await frame();
  const returnToAnswer = setup.renderer.root.findDescendantById("side-answer");
  if (returnToAnswer) {
    assert.ok(
      setup.captureCharFrame().includes("Новый вопрос с отдельным"),
      "Reopen lost side draft",
    );
    await act(async () => {
      await setup.mockMouse.click(returnToAnswer.x + 1, returnToAnswer.y);
    });
  }
  await until(
    () => setup.captureCharFrame().includes("Ответ завершён"),
    "Persisted answer could not reopen",
  );
  assert.equal(sideCalls, 1);
  await key("ESCAPE");
  await send("/exit");
  await application;
  process.stdout.write(
    "Side query: real TUI, parallel model requests, approval priority, hide/reopen, resize, isolated history/accounting and resume verified\n",
  );
} finally {
  releaseMain();
  releaseSide();
  server.stop(true);
  globalThis.fetch = nativeFetch;
  setup.renderer.destroy();
  await rm(storage, { recursive: true, force: true });
}
