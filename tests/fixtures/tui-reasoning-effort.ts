import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { providersRootDir } from "../../src/paths/home.js";
import { reasoningEffortKey } from "../../src/providers/capabilities.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";
import { modelProfiles } from "./menu-navigation.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-effort-")),
);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(directory, "home");
const root = join(directory, "project");
const model = "example-coder";
const provider = "example/effort";
const requests: { path: string; effort?: string; tools: boolean }[] = [];
const first = Promise.withResolvers<void>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/models"))
      return Response.json({ data: [{ id: model, name: "Example Coder" }] });
    assert.ok(path.endsWith("/chat/completions"), path);
    const body = (await request.json()) as {
      model: string;
      reasoning_effort?: string;
      messages: { role: string }[];
    };
    assert.equal(body.model, model);
    requests.push({
      path,
      effort: body.reasoning_effort,
      tools: body.messages.some(({ role }) => role === "tool"),
    });
    const index = requests.length;
    if (index === 1) await first.promise;
    const delta =
      index === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "read-example",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"example.txt"}',
                },
              },
            ],
          }
        : { content: `Ответ ${index}` };
    const finish = index === 1 ? "tool_calls" : "stop";
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
const ui = await createTestRenderer({
  width: 80,
  height: 24,
  exitOnCtrlC: false,
});
const frame = () => ui.captureCharFrame();
const wait = async (ready: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 5000;
  while (!(await ready())) {
    assert.ok(Date.now() < deadline, frame());
    await act(async () => {
      await Bun.sleep(5);
      await ui.renderOnce();
    });
  }
};
const node = (id: string) => ui.renderer.root.findDescendantById(id);
const send = async (value: string) => {
  await wait(() => !!ui.renderer.currentFocusedEditor);
  await act(async () => ui.mockInput.pasteBracketedText(value));
  await act(async () => ui.mockInput.pressEnter());
};
const closeApp = async () => {
  await act(async () => {
    process.emit("SIGTERM");
    await application;
  });
  application = undefined;
};
try {
  await mkdir(root);
  await writeFile(join(root, "example.txt"), "Содержимое fixture\n");
  const manifest = join(providersRootDir(), "effort");
  await mkdir(manifest, { recursive: true });
  await writeFile(
    join(manifest, "provider.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: provider,
      label: "Example Gateway",
      driver: "openai-chat",
      auth: { required: false, envVars: [] },
      endpoint: { required: true, normalization: "openai-v1" },
      defaults: { model },
      capabilities: {
        modelListing: true,
        tokenCounting: "unsupported",
        usageReporting: "stream",
        toolCalling: true,
        thinking: true,
      },
      driverOptions: {
        reasoningEffort: {
          [model]: {
            levels: ["low", "medium", "high"],
            defaultLevel: "medium",
          },
        },
      },
    }),
  );
  const configPath = join(directory, "global.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: "work",
      profiles: Object.fromEntries(
        ["work", "personal"].map((id) => [
          id,
          {
            label: id,
            providerId: provider,
            baseUrl: `http://127.0.0.1:${server.port}/${id}/v1`,
          },
        ]),
      ),
      lsp: { mode: "off", servers: {} },
      web: { enabled: false },
    }),
  );
  const store = await projectSessionStore(root);
  const session = createSession(root, provider, model);
  session.profileId = "work";
  await store.save(session);
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath, externalExtensions: false },
      session,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
  });

  await send("/effort");
  await wait(() => frame().includes("по умолчанию"));
  assert.match(frame(), /Auto +\+ текущий/);
  assert.match(frame(), /Example Coder/);
  const output = process.env.CHISEL_EFFORT_CAPTURES;
  if (output) {
    await mkdir(output, { recursive: true });
    const spans = ui.captureSpans();
    await writeFile(
      join(output, "effort-80x24.json"),
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
  await act(async () => ui.mockInput.pressEscape());
  await wait(
    () =>
      !node("effort-popup") &&
      ui.renderer.currentFocusedEditor?.plainText === "/effort",
  );
  await act(async () => ui.mockInput.pressEnter());
  await wait(() => frame().includes("по умолчанию"));
  await act(async () => ui.mockInput.pressKey("ARROW_DOWN"));
  await act(async () => ui.mockInput.pressEnter());
  const workKey = reasoningEffortKey("work", model);
  await wait(
    async () =>
      (await store.load(session.id)).reasoningEfforts?.[workKey] === "low",
  );

  await send("Первая задача");
  await wait(() => requests.length === 1);
  await send("Вторая задача");
  await wait(() => frame().includes("В очереди: 1"));
  await send("/effort high");
  await wait(() => frame().includes("Глубина рассуждений: high"));
  await act(async () => first.resolve());
  await wait(() => requests.length === 3 && frame().includes("Ответ 3"));
  await wait(
    async () =>
      (await store.load(session.id)).reasoningEfforts?.[workKey] === "high",
  );
  assert.deepEqual(
    requests.map(({ effort }) => effort),
    ["low", "low", "low"],
  );
  assert.equal(requests[1]?.tools, true);

  const switchProfile = async (profile: string) => {
    await send("/model");
    await wait(() => ui.renderer.currentFocusedEditor?.id === "models-search");
    await modelProfiles(ui);
    await wait(() => ui.renderer.currentFocusedEditor?.id === "models-search");
    await act(async () => ui.mockInput.pasteBracketedText(profile));
    await act(async () => ui.mockInput.pressEnter());
    await wait(() => ui.renderer.currentFocusedEditor?.id === "models-search");
    await act(async () => ui.mockInput.pasteBracketedText(model));
    await act(async () => ui.mockInput.pressEnter());
    await wait(() => !node("models-popup"));
  };
  await switchProfile("personal");
  await send("Другой профиль");
  await wait(() => requests.length === 4 && frame().includes("Ответ 4"));
  assert.equal(requests[3]?.path, "/personal/v1/chat/completions");
  assert.equal(requests[3]?.effort, undefined);

  await switchProfile("work");
  await send("Исходный профиль");
  await wait(() => requests.length === 5 && frame().includes("Ответ 5"));
  assert.equal(requests[4]?.path, "/work/v1/chat/completions");
  assert.equal(requests[4]?.effort, "high");
  await send("/effort auto");
  await wait(
    async () =>
      (await store.load(session.id)).reasoningEfforts?.[workKey] === undefined,
  );
  await send("Сброс");
  await wait(() => requests.length === 6 && frame().includes("Ответ 6"));
  assert.equal(requests[5]?.effort, undefined);
  console.log(
    "OpenTUI 80×24: effort, draft, tool rounds, queue, profiles and session storage verified",
  );
} finally {
  first.resolve();
  if (application) await closeApp();
  else ui.renderer.destroy();
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
