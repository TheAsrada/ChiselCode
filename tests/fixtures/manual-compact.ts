import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { runPrompt } from "../../src/app/run-prompt.js";
import { emptySummary } from "../../src/context/summary.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-manual-compact-")),
);
const root = join(directory, "project");
await mkdir(root);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(directory, "home");
process.env.OPENAI_API_KEY = "fixture-key";
let generations = 0;
let summaryRequests = 0;
let ordinaryRequests = 0;
let followupHistory = "";
const model = "deepseek-v4.1-flash-1017";
const handoff = {
  ...emptySummary(),
  goal: "Finish the site",
  userConstraints: ["Keep the current request"],
  nextAction: "Inspect the next file",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.url.endsWith("/models"))
      return Response.json({
        // The gateway in the report lists this exact ID without token limits.
        data: [{ id: model }],
      });
    generations++;
    const body = (await request.json()) as {
      messages?: { content?: string }[];
      tools?: unknown[];
    };
    const summary = JSON.stringify(body).includes("compact, factual handoff");
    if (summary) {
      assert.equal(body.tools, undefined);
      summaryRequests++;
    } else {
      ordinaryRequests++;
      followupHistory = JSON.stringify(body.messages);
    }
    const text = summary
      ? JSON.stringify(handoff)
      : `Обычный ответ ${ordinaryRequests}`;
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: summary ? 200 : 30_000, completion_tokens: 80 } })}\n\n` +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
let ui: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
try {
  const configPath = join(directory, "global.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: "fixture",
      profiles: {
        fixture: {
          providerId: "openai-compatible",
          defaultModel: model,
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
        },
      },
      lsp: { mode: "off", servers: {} },
      web: { enabled: false },
    }),
  );
  const store = await projectSessionStore(root);
  const session = createSession(root, "openai-compatible", model);
  session.profileId = "fixture";
  session.messages = [
    { role: "user", content: [{ type: "text", text: "Finish the site" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read-old",
          name: "read_file",
          input: { path: "old.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "read-old",
          content: "old output ".repeat(6000),
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Continue" }] },
    {
      role: "user",
      content: [{ type: "text", text: "Keep the current request" }],
    },
  ];
  await store.save(session);
  const originalMessages = JSON.stringify(session.messages);
  const events: string[] = [];
  const options = {
    cwd: root,
    configPath,
    resume: session.id,
    compactOnly: true,
    interactive: true,
  };
  const first = await runPrompt(
    "",
    options,
    { requestApproval: async () => "unavailable" },
    {
      onText() {},
      onEvent(event) {
        events.push(event.type);
      },
    },
  );
  assert.equal(first.result.status, "completed");
  assert.equal(first.result.session.contextSnapshot?.contextWindow, 1_000_000);
  assert.equal(first.result.session.contextSnapshot?.windowSource, "catalog");
  const saved = await store.load(session.id);
  assert.equal(saved.context?.compactions?.at(-1)?.reason, "manual");
  assert.equal(JSON.stringify(saved.messages), originalMessages);
  assert.equal(generations, 1);
  assert.equal(summaryRequests, 1);
  assert.ok(events.includes("context_compaction_completed"));
  const again = await runPrompt(
    "",
    options,
    { requestApproval: async () => "unavailable" },
    { onText() {} },
  );
  assert.equal(again.result.status, "completed");
  assert.match(again.result.text, /нет старой истории/);
  assert.equal(generations, 1);
  assert.equal((await store.load(session.id)).context?.compactions?.length, 1);
  const more = await store.load(session.id);
  more.messages.push(
    {
      role: "assistant",
      content: [{ type: "text", text: "New observations ".repeat(3000) }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Continue with the next file" }],
    },
  );
  await store.save(more);
  ui = await createTestRenderer({ width: 128, height: 38, exitOnCtrlC: false });
  const testUi = ui;
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath },
      more,
      false,
      false,
      undefined,
      async () => testUi.renderer,
    );
  });
  const wait = async (ready: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await ready())) {
      if (Date.now() > deadline) throw new Error(testUi.captureCharFrame());
      await act(async () => {
        await Bun.sleep(10);
        await testUi.renderOnce();
      });
    }
  };
  const send = async (text: string) => {
    await wait(() => Boolean(testUi.renderer.currentFocusedEditor));
    await act(async () => {
      await testUi.mockInput.typeText(text);
      testUi.mockInput.pressEnter();
    });
  };
  await wait(() => Boolean(testUi.renderer.currentFocusedEditor));
  if (!testUi.renderer.root.findDescendantById("context-sidebar"))
    await act(async () => {
      testUi.mockInput.pressKey("b", { ctrl: true });
    });
  await wait(() =>
    testUi
      .captureCharFrame()
      .replaceAll("\u00a0", " ")
      .includes("Окно: 1 000 000"),
  );
  assert.ok(testUi.captureCharFrame().includes("каталог"));
  // A normal foreground turn binds the conversation owner before /compact.
  await send("Продолжи исследование");
  await wait(() => testUi.captureCharFrame().includes("Обычный ответ 1"));
  await wait(async () => (await store.load(session.id)).messages.length === 9);
  const beforeCompact = JSON.stringify((await store.load(session.id)).messages);
  await send("/compact");
  await wait(() =>
    testUi.captureCharFrame().includes("Контекст сжат по команде"),
  );
  assert.equal(generations, 3);
  assert.equal(summaryRequests, 2);
  await wait(
    async () =>
      (await store.load(session.id)).context?.compactions?.length === 2,
  );
  assert.equal(
    JSON.stringify((await store.load(session.id)).messages),
    beforeCompact,
  );
  await wait(() => testUi.captureCharFrame().includes("Enter отправить"));
  if (process.env.CHISEL_COMPACT_CAPTURES) {
    const output = process.env.CHISEL_COMPACT_CAPTURES;
    await mkdir(output, { recursive: true });
    await act(async () => {
      await testUi.renderOnce();
    });
    const spans = testUi.captureSpans();
    await writeFile(
      join(output, "manual-compact.json"),
      JSON.stringify({
        ...spans,
        lines: spans.lines.map((line) => ({
          spans: line.spans.map((span) => ({
            ...span,
            fg: span.fg.toInts(),
            bg: span.bg.toInts(),
          })),
        })),
      }),
    );
    await writeFile(
      join(output, "manual-compact.txt"),
      testUi.captureCharFrame(),
    );
  }
  await send("/compact");
  await wait(() => testUi.captureCharFrame().includes("нет старой истории"));
  assert.equal(generations, 3);
  await send("Продолжи после сжатия");
  await wait(() => testUi.captureCharFrame().includes("Обычный ответ 2"));
  assert.equal(generations, 4);
  assert.ok(followupHistory.includes("Продолжи после сжатия"));
  assert.ok(followupHistory.includes(handoff.goal));
  assert.ok(!followupHistory.includes("New observations"));
  assert.ok(!testUi.captureCharFrame().includes("старый порт"));
  if (process.env.CHISEL_COMPACT_CAPTURE)
    await writeFile(process.env.CHISEL_COMPACT_CAPTURE, ui.captureCharFrame());
  process.stdout.write(
    "Manual /compact: HTTP summary, durable checkpoint, no tool replay, OpenTUI command verified.\n",
  );
} finally {
  if (application)
    await act(async () => {
      process.emit("SIGTERM");
      await application?.catch(() => {});
    });
  await act(async () => ui?.renderer.destroy());
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
