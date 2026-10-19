import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { runPrompt } from "../../src/app/run-prompt.js";
import { autoLspLaunch } from "../../src/lsp/backend.js";
import { chiselHomeDir } from "../../src/paths/home.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-diagnostics-")),
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
const secret = "fixture-diagnostics-secret";
process.env.OPENAI_API_KEY = secret;
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (request.url.endsWith("/models"))
      return Response.json({
        data: [{ id: "fixture-model", context_window: 65536 }],
      });
    requests++;
    return Response.json(
      {
        error: {
          message: `Диагностический отказ: ${secret}`,
          type: "invalid_request_error",
        },
      },
      { status: 400 },
    );
  },
});
const theme = process.env.CHISEL_DIAGNOSTICS_THEME ?? "graphite";
const configPath = join(directory, "global.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    defaultProfileId: "fixture",
    profiles: {
      fixture: {
        providerId: "openai",
        defaultModel: "fixture-model",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    ui: { theme },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
let ui: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
try {
  const outcome = await runPrompt(
    "Проверь соединение",
    {
      cwd: root,
      configPath,
      provider: "openai",
      model: "fixture-model",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    },
    { requestApproval: async () => "unavailable" },
    { onText() {} },
  );
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.errorCode, "bad_request");
  const store = await projectSessionStore(root);
  const session = await store.load(outcome.result.session.id);
  const diagnostic = session.requestTimings?.at(-1)?.error;
  assert.equal(diagnostic?.code, "bad_request");
  assert.match(diagnostic!.message, /Диагностический отказ/);
  assert.ok(!JSON.stringify(session).includes(secret));
  assert.equal(session.messages.length, 1);
  assert.equal(requests, 1);
  const records = await store.list();
  assert.equal(records.length, 1);
  const disk = await readFile(
    join(store.directory, `${session.id}.json`),
    "utf8",
  );
  assert.ok(!disk.includes(secret));

  // The data-inside-workspace guard remains enforced, with an actionable reason.
  const home = await realpath(chiselHomeDir());
  await assert.rejects(autoLspLaunch(home), (error) => {
    assert.match(String(error), /\/cwd <путь>/);
    return true;
  });
  assert.equal((await autoLspLaunch(root)).id, "auto");

  ui = await createTestRenderer({ width: 100, height: 28, exitOnCtrlC: false });
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath },
      session,
      false,
      false,
      undefined,
      async () => ui!.renderer,
    );
  });
  const deadline = Date.now() + 10000;
  while (!ui.captureCharFrame().includes("Диагностический отказ")) {
    if (Date.now() > deadline) throw new Error(ui.captureCharFrame());
    await act(async () => {
      await Bun.sleep(10);
      await ui!.renderOnce();
    });
  }
  assert.match(ui.captureCharFrame(), /Завершено с ошибкой/);
  assert.equal(
    requests,
    1,
    "Viewing restored history must not call the provider",
  );
  const captures = process.env.CHISEL_DIAGNOSTICS_CAPTURES;
  if (captures) {
    await mkdir(captures, { recursive: true });
    await writeFile(
      join(captures, `${theme}-restored-error.txt`),
      ui.captureCharFrame(),
    );
    const spans = ui.captureSpans();
    await writeFile(
      join(captures, `${theme}-restored-error.json`),
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
  console.log(
    "Conversation diagnostics: production HTTP failure, redacted durable reason, native restored error and LSP workspace guard verified",
  );
} finally {
  if (application) {
    await act(async () => {
      process.emit("SIGTERM");
      await application;
    });
  }
  await act(async () => ui?.renderer.destroy());
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
