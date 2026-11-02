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
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-resume-")),
);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(directory, "home");
process.env.OPENAI_API_KEY = "fixture-key";
const alpha = join(directory, "Atlas"),
  beta = join(directory, "Orbit"),
  missing = join(directory, "Removed");
for (const path of [alpha, beta, missing]) await mkdir(path);
await writeFile(
  join(beta, "AGENTS.md"),
  "Контекст проекта Orbit для проверки восстановления.",
);
const aStore = await projectSessionStore(alpha),
  bStore = await projectSessionStore(beta),
  mStore = await projectSessionStore(missing);
async function seed(store: typeof aStore, title: string, text: string) {
  const session = store.create("openai", "fixture-model");
  session.profileId = "fixture";
  session.title = title;
  session.messages.push({ role: "user", content: [{ type: "text", text }] });
  session.messages.push({
    role: "assistant",
    content: [
      { type: "text", text: "Сохранённый ответ: продолжаем с этого места." },
    ],
  });
  await store.save(session);
  return session;
}
const a = await seed(
  aStore,
  "Поиск по большому монорепозиторию",
  "Продумай архитектуру индекса исходников.",
);
const b = await seed(
  bStore,
  "Новая навигация приложения",
  "Собери понятную навигацию и сохрани фокус при переходах.",
);
await seed(
  bStore,
  "Оптимизация запросов к API",
  "Сократи число повторных запросов без потери данных.",
);
await seed(aStore, "Проверки разрешений", "Проверь отказ до записи файла.");
const m = await seed(
  mStore,
  "Недоступный проект",
  "История удалённого проекта остаётся читаемой.",
);
await rm(missing, { recursive: true });
const aFile = join(aStore.directory, `${a.id}.json`),
  aBytes = await readFile(aFile, "utf8");
const calls: Record<string, unknown>[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.url.endsWith("/models"))
      return Response.json({
        data: [{ id: "fixture-model", context_window: 65536 }],
      });
    calls.push((await request.json()) as Record<string, unknown>);
    return new Response(
      `data: ${JSON.stringify({ id: "resume", choices: [{ index: 0, delta: { content: "Ответ восстановленной сессии Orbit" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const configPath = join(directory, "config.json");
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
    ui: { motion: "reduced" },
    web: { enabled: false },
    lsp: { mode: "off", servers: {} },
  }),
);
const ui = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
const wait = async (ready: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 10000;
  while (!(await ready())) {
    assert.ok(Date.now() < deadline, `${label}\n${ui.captureCharFrame()}`);
    await act(async () => {
      await Bun.sleep(5);
      await ui.renderOnce();
    });
  }
  await act(async () => {
    await ui.renderOnce();
  });
};
const send = async (text: string) => {
  await wait(
    () => ui.renderer.currentFocusedEditor?.id === "prompt-editor",
    "composer focus",
  );
  await act(async () => {
    await ui.mockInput.pasteBracketedText(text);
  });
  await act(async () => {
    ui.mockInput.pressEnter();
  });
};
const key = async (name: string, ctrl = false) => {
  let received = false;
  const observed = (event: { name: string }) => {
    if (event.name === "escape") received = true;
  };
  if (name === "escape")
    ui.renderer.keyInput.prependListener("keypress", observed);
  try {
    await act(async () => {
      ui.mockInput.pressKey(
        name === "return" ? "RETURN" : name === "escape" ? "ESCAPE" : name,
        { ctrl },
      );
    });
    if (name === "escape") await wait(() => received, "Escape received");
    await act(async () => {
      await ui.renderOnce();
    });
  } finally {
    if (name === "escape") ui.renderer.keyInput.off("keypress", observed);
  }
};
const search = async (text: string) => {
  await wait(
    () => ui.renderer.currentFocusedEditor?.id === "resume-search",
    "search focus",
  );
  await key("a", true);
  await key("k", true);
  await act(async () => {
    await ui.mockInput.pasteBracketedText(text);
  });
  await wait(
    () =>
      ui.renderer.currentFocusedEditor?.plainText === text &&
      ui.captureCharFrame().includes("Сессий: 1"),
    "search result",
  );
};
const capture = async (name: string) => {
  const output = process.env.CHISEL_RESUME_CAPTURES;
  if (!output) return;
  await act(async () => {
    await ui.renderOnce();
  });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, `${name}.txt`), ui.captureCharFrame());
  const spans = ui.captureSpans();
  await writeFile(
    join(output, `${name}.json`),
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
};
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { launcher: true, configPath, externalExtensions: false },
      undefined,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
  });
  await wait(
    () => ui.captureCharFrame().includes("История /resume"),
    "home resume shortcut",
  );
  assert.ok(!ui.captureCharFrame().includes("/sessions"));
  await send("/resume");
  await wait(
    () => ui.captureCharFrame().includes("Сессий: 5"),
    "global projectless history",
  );
  assert.ok(
    ui.renderer.root.findDescendantById("welcome"),
    "real background stays mounted",
  );
  assert.equal(calls.length, 0);
  await capture("resume-120x40");
  for (const [width, height] of [
    [80, 24],
    [60, 15],
    [32, 10],
  ]) {
    await act(async () => {
      ui.resize(width!, height!);
    });
    await wait(
      () => !!ui.renderer.root.findDescendantById("resume-popup"),
      "resized popup",
    );
    const popup = ui.renderer.root.findDescendantById("resume-popup")!;
    assert.ok(
      popup.x >= 0 &&
        popup.y >= 0 &&
        popup.x + popup.width <= width! &&
        popup.y + popup.height <= height!,
    );
    await capture(`resume-${width}x${height}`);
  }
  await act(async () => {
    ui.resize(120, 40);
  });
  await search("Orbit навигация");
  await wait(
    () => ui.captureCharFrame().includes("Собери понятную навигацию"),
    "actual preview",
  );
  await capture("resume-search-120x40");
  await key("return");
  await wait(
    () =>
      !ui.renderer.root.findDescendantById("resume-popup") &&
      ui.captureCharFrame().includes("Сохранённый ответ"),
    "resumed Orbit from no root",
  );
  assert.equal(calls.length, 0);
  await send("Продолжи работу в исходном проекте.");
  await wait(
    () => ui.captureCharFrame().includes("Ответ восстановленной сессии Orbit"),
    "actual model continuation",
  );
  await wait(
    async () =>
      (await bStore.load(b.id)).messages.some((message) =>
        message.content.some(
          (block) =>
            block.type === "text" &&
            block.text.includes("Ответ восстановленной"),
        ),
      ),
    "durable continuation",
  );
  assert.equal(calls.length, 1);
  assert.ok(
    JSON.stringify(calls[0]).includes("Контекст проекта Orbit"),
    "restored runtime uses original project instructions",
  );
  assert.equal(
    await readFile(aFile, "utf8"),
    aBytes,
    "unrelated project unchanged",
  );
  await send("/resume");
  await wait(
    () => ui.captureCharFrame().includes("Сессий: 5"),
    "global history from Orbit",
  );
  await search("Atlas монорепозиторию");
  await key("return");
  await wait(
    () =>
      !ui.renderer.root.findDescendantById("resume-popup") &&
      ui.captureCharFrame().includes("Продумай архитектуру"),
    "cross-project resume",
  );
  await send("/resume");
  await search("Orbit навигация");
  await key("r", true);
  await wait(
    () => ui.captureCharFrame().includes("Новое название:"),
    "rename mode",
  );
  await key("a", true);
  await key("k", true);
  await act(async () => {
    await ui.mockInput.pasteBracketedText("Навигация после проверки");
  });
  await key("return");
  await wait(
    async () => (await bStore.load(b.id)).title === "Навигация после проверки",
    "rename across roots",
  );
  await wait(
    () =>
      !ui.captureCharFrame().includes("Новое название:") &&
      ui.renderer.currentFocusedEditor?.id === "resume-search",
    "rename finished",
  );
  await key("escape"); // clear query
  await search("Removed");
  await key("return");
  await wait(
    () => !!ui.renderer.root.findDescendantById("readonly-history"),
    "missing project falls back to readonly",
  );
  assert.equal(calls.length, 1);
  assert.equal((await mStore.load(m.id)).projectPath, missing);
  await capture("resume-unavailable-120x40");
  await key("escape");
  await key("escape"); // viewer -> list -> clear query
  await search("Orbit Навигация");
  await key("d", true);
  await key("escape");
  assert.ok(await bStore.load(b.id), "delete cancellation preserves history");
  await key("d", true);
  await key("y");
  await wait(
    () =>
      ui.renderer.currentFocusedEditor?.id === "resume-search" &&
      ui.captureCharFrame().includes("Ничего не найдено"),
    "delete finished in UI",
  );
  assert.ok(
    !(await bStore.list()).some((summary) => summary.id === b.id),
    "delete across roots",
  );
  await key("escape");
  await key("escape");
  await send(`/resume ${a.id.slice(0, 12)}`);
  await wait(
    () => ui.captureCharFrame().includes("Продумай архитектуру"),
    "global direct ref reuses open tab",
  );
  assert.equal(calls.length, 1);
  console.log(
    "Resume: global history, original runtime, cross-project navigation/rename/delete, readonly fallback, resize and native captures verified",
  );
} finally {
  if (application)
    await act(async () => {
      process.emit("SIGTERM");
      await application;
    });
  await act(async () => ui.renderer.destroy());
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
