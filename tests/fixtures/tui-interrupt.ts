import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-interrupt-"));
const root = join(storage, "workspace");
await mkdir(root);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = storage;
process.env.OPENAI_API_KEY = "offline-interrupt-fixture";
const prompts: string[] = [];
const chunk = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "interrupt", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models"))
      return Response.json({ data: [{ id: "fixture-model" }] });
    const body = await request.json();
    const prompt = body.messages.findLast(
      (message: { role: string }) => message.role === "user",
    ).content as string;
    prompts.push(prompt);
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          if (prompt.includes("Останови")) {
            // An open stream, rather than a resolved/mock provider request.
            controller.enqueue(
              encoder.encode(chunk(`Частичный ответ ${prompts.length}`)),
            );
          } else {
            controller.enqueue(
              encoder.encode(
                chunk("Можно продолжать", "stop") + "data: [DONE]\n\n",
              ),
            );
            controller.close();
          }
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith(`http://127.0.0.1:${server.port}/`)
      ? nativeFetch(input, init)
      : Promise.resolve(new Response("Offline fixture", { status: 503 }));
  },
  { preconnect: nativeFetch.preconnect },
);
const configPath = join(storage, "config.json");
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
  }),
);
const setup = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await act(async () => {
      await Bun.sleep(10);
      await setup.renderOnce();
    });
    if (await predicate()) return;
  }
  throw new Error(`${label}\n${setup.captureCharFrame()}`);
}
async function send(text: string) {
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
    setup.mockInput.pressEnter();
  });
}
async function capture(name: string) {
  const directory = process.env.CHISEL_INTERRUPT_CAPTURES;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const spans = setup.captureSpans();
  await writeFile(join(directory, `${name}.txt`), setup.captureCharFrame());
  await writeFile(
    join(directory, `${name}.json`),
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
}
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
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
  });
  await until(
    () => !!setup.renderer.root.findDescendantById("welcome"),
    "Welcome missing",
  );
  const store = await projectSessionStore(root);
  for (const [index, sequence] of ["\u0003", "\u001b[1089::99;5u"].entries()) {
    await send(`Останови поток ${index}`);
    await until(
      () => setup.captureCharFrame().includes(`Частичный ответ ${index + 1}`),
      "Stream missing",
    );
    await send("Этот запрос должен исчезнуть из очереди");
    await until(
      () => setup.captureCharFrame().includes("Enter в очередь"),
      "Request not busy",
    );
    await capture(`receiving-${index}`);
    await act(async () => {
      await setup.mockInput.pressKeys([sequence]);
    });
    await until(async () => {
      const summary = (await store.list())[0];
      if (!summary) return false;
      const saved = await store.load(summary.id);
      return (
        saved.requestTimings?.filter((timing) => timing.status === "cancelled")
          .length ===
          index + 1 && !setup.captureCharFrame().includes("Enter в очередь")
      );
    }, "Cancellation did not persist/finish");
    assert.equal(prompts.length, index + 1, "Cancelled queue reached provider");
    await capture(`cancelled-${index}`);
  }
  await send("Продолжи после отмены");
  await until(
    () =>
      setup.captureCharFrame().includes("Можно продолжать") &&
      !setup.captureCharFrame().includes("Enter в очередь"),
    "Next turn failed",
  );
  const summary = (await store.list())[0];
  assert.ok(summary);
  const saved = await store.load(summary.id);
  assert.equal(saved.requestTimings?.at(-1)?.status, "completed");
  assert.ok(setup.captureCharFrame().includes("Частичный ответ"));
  assert.ok(
    !JSON.stringify(saved.messages).includes("Этот запрос должен исчезнуть"),
  );
  assert.equal(prompts.length, 3);
  await send("/exit");
  await application;
  console.log("Terminal interrupt verified");
} finally {
  process.emit("SIGTERM");
  await application;
  setup.renderer.destroy();
  server.stop(true);
  globalThis.fetch = nativeFetch;
  await rm(storage, { recursive: true, force: true });
}
