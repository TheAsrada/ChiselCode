import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClipboardService, ImageRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { responsesInput } from "../../src/extensions/builtins/chatgpt/adapter.js";
import { AnthropicProtocolAdapter } from "../../src/providers/drivers/anthropic-messages.js";
import { loadImageInputs } from "../../src/providers/image-input.js";
import { ProviderToolNames } from "../../src/providers/tool-names.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-photos-"));
const root = join(storage, "project");
await mkdir(root);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = storage;
process.env.OPENAI_API_KEY = "fixture-offline-photo";
for (const key of [
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
  "CHISEL_ALT_SCREEN",
  "CHISEL_NO_ALT_SCREEN",
])
  delete process.env[key];

const png = await readFile(
  new URL(
    "../../docs/assets/opentui-graphics/paper-settings-120x36.png",
    import.meta.url,
  ),
);
const encoded = png.toString("base64");
const filename = "Снимок окна.png";
await writeFile(join(root, filename), png);
const requests: Array<{
  model: string;
  messages: Array<{ role: string; content: unknown }>;
}> = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "fixture-vision",
            input_modalities: ["text", "image"],
            context_window: 32768,
            max_output_tokens: 2048,
          },
          {
            id: "fixture-text",
            input_modalities: ["text"],
            context_window: 32768,
            max_output_tokens: 2048,
          },
        ],
      });
    requests.push((await request.json()) as (typeof requests)[number]);
    return new Response(
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Фото получено"},"finish_reason":"stop"}]}\n\n' +
        'data: {"usage":{"prompt_tokens":100,"completion_tokens":10},"choices":[]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith(`http://127.0.0.1:${server.port}/`)
      ? realFetch(input, init)
      : new Response("Offline photo fixture", { status: 503 });
  },
  { preconnect: realFetch.preconnect },
);

const configPath = join(storage, "config.json");
const theme = process.env.CHISEL_PHOTO_THEME ?? "obsidian";
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    defaultProfileId: "fixture",
    profiles: {
      fixture: {
        providerId: "openai-compatible",
        defaultModel: "fixture-vision",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
    ui: { theme, motion: "reduced", startupIntroSeen: true },
  }),
);

const clipboard: ClipboardService = {
  async read({ preferredTypes }) {
    assert.equal(preferredTypes[0], "image/png");
    return {
      status: "read",
      representation: { mimeType: "image/png", bytes: png },
    };
  },
  async writeText() {
    return {
      host: { status: "not-attempted" },
      terminal: { status: "not-attempted", capability: "unknown" },
    };
  },
  async clear() {
    return {
      host: { status: "not-attempted" },
      terminal: { status: "not-attempted", capability: "unknown" },
    };
  },
  async dispose() {},
};

let ui!: Awaited<ReturnType<typeof createTestRenderer>>;
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
const frame = () =>
  act(async () => {
    await ui.renderOnce();
  });
const until = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`${message}\n${ui.captureCharFrame()}`);
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
  }
  await frame();
};
const key = async (name: string, ctrl = false) => {
  await act(async () => {
    ui.mockInput.pressKey(name, { ctrl });
  });
  await frame();
};
const paste = async (text: string) => {
  await act(async () => {
    await ui.mockInput.pasteBracketedText(text);
  });
  await frame();
};
const capture = async (name: string) => {
  const directory = process.env.CHISEL_PHOTO_CAPTURES;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const spans = ui.captureSpans();
  await writeFile(
    join(directory, `${theme}-${name}.json`),
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
const start = async (
  resume?: string,
  model?: string,
  graphics?: "live" | "split",
) => {
  if (graphics === "split") process.env.CHISEL_ALT_SCREEN = "0";
  else delete process.env.CHISEL_ALT_SCREEN;
  ui = await createTestRenderer({
    width: 120,
    height: 36,
    exitOnCtrlC: false,
    exitSignals: [],
    screenMode: graphics === "split" ? "split-footer" : "alternate-screen",
    externalOutputMode: graphics === "split" ? "capture-stdout" : "passthrough",
  });
  if (graphics) {
    await ui.renderer.setupTerminal();
    ui.renderer.stdin.emit("data", Buffer.from("\x1b_Gi=31337;OK\x1b\\"));
    await until(
      () => ui.renderer.capabilities?.kitty_graphics === true,
      "Нет Kitty Graphics",
    );
  }
  const initial = resume
    ? await (await projectSessionStore(root)).load(resume)
    : undefined;
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath, resume, model },
      initial,
      false,
      false,
      undefined,
      async () => ui.renderer,
      clipboard,
    );
  });
  await until(
    () => ui.renderer.currentFocusedEditor?.id === "prompt-editor",
    "Нет фокуса в редакторе",
  );
};
const stop = async () => {
  if (!application) return;
  await act(async () => {
    process.emit("SIGTERM");
    await application;
  });
  application = undefined;
};

try {
  await start();
  await key("v", true);
  await until(
    () => ui.captureCharFrame().includes("1 прикреплено"),
    "Фото из буфера не добавлено",
  );
  assert.equal(ui.renderer.currentFocusedEditor?.plainText, "");
  await key("F10");
  await until(
    () => ui.renderer.currentFocusedEditor?.id === "photo-path",
    "Не открылось окно фото",
  );
  await paste(filename);
  await key("RETURN");
  await until(
    () => ui.captureCharFrame().includes("2 прикреплено"),
    "Файл не добавлен",
  );
  await paste("Что видно на этих снимках?");
  await capture("draft");
  await key("RETURN");
  await until(
    () => ui.captureCharFrame().includes("Фото получено"),
    "Нет ответа модели",
  );
  assert.deepEqual(
    requests
      .at(-1)
      ?.messages.filter(({ role }) => role === "user")
      .at(-1)?.content,
    [
      { type: "text", text: "Что видно на этих снимках?" },
      ...Array.from({ length: 2 }, () => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${encoded}` },
      })),
    ],
  );
  await capture("chat");
  await key("TAB");
  await key("RETURN");
  await until(
    () => ui.captureCharFrame().includes("Фото 1/2"),
    "Не открылся предпросмотр из ленты",
  );
  await key("ARROW_RIGHT");
  await until(
    () => ui.captureCharFrame().includes("Фото 2/2"),
    "Стрелка не выбрала следующее фото",
  );
  await key("ESCAPE");
  await until(
    () => !ui.renderer.root.findDescendantById("photos-popup"),
    "Esc не закрыл предпросмотр",
  );
  const store = await projectSessionStore(root);
  const [saved] = await store.list();
  assert.ok(saved);
  const session = await store.load(saved.id);
  assert.equal(
    session.messages[0]?.content.filter((block) => block.type === "image")
      .length,
    2,
  );
  await key("v", true);
  await until(
    () => ui.captureCharFrame().includes("1 прикреплено"),
    "Фото без подписи не добавлено",
  );
  await stop();

  await rm(join(root, filename));
  await start(saved.id);
  await until(
    () =>
      ui.captureCharFrame().includes(filename) &&
      ui.captureCharFrame().includes("1 прикреплено"),
    "История или черновик не восстановились",
  );
  await key("RETURN");
  await until(() => requests.length === 2, "Фото без текста не отправлено");
  assert.deepEqual(
    requests
      .at(-1)
      ?.messages.filter(({ role }) => role === "user")
      .at(-1)?.content,
    [
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${encoded}` },
      },
    ],
  );
  await until(
    () => ui.captureCharFrame().includes("Фото получено"),
    "Нет ответа на фото без текста",
  );
  await act(async () => {
    ui.resize(42, 15);
  });
  await frame();
  await capture("compact-chat");
  await stop();

  await start(undefined, "fixture-text");
  await key("v", true);
  await until(
    () => ui.captureCharFrame().includes("1 прикреплено"),
    "Фото для текстовой модели не добавлено",
  );
  await key("RETURN");
  await until(
    () => ui.captureCharFrame().includes("Модель не подтвердила"),
    "Текстовая модель не отклонила фото",
  );
  assert.equal(requests.length, 2);
  assert.ok(ui.captureCharFrame().includes("1 прикреплено"));
  await stop();

  const photo = session.messages[0]?.content.find(
    (block) => block.type === "image",
  );
  assert.ok(photo);
  const imageRequest = {
    model: "fixture-vision",
    system: "",
    tools: [],
    maxTokens: 24,
    messages: [{ role: "user" as const, content: [photo] }],
  };
  const names = new ProviderToolNames([], imageRequest.messages);
  assert.deepEqual(
    responsesInput(
      imageRequest,
      names,
      await loadImageInputs(imageRequest.messages),
    ),
    [
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${encoded}`,
          },
        ],
      },
    ],
  );
  let anthropicMessages: unknown;
  const anthropic = new AnthropicProtocolAdapter({
    apiKey: "fixture-key",
    baseUrl: "https://anthropic.test",
    maxRetries: 0,
    fetch: async (_input, init) => {
      anthropicMessages = JSON.parse(String(init?.body)).messages;
      return new Response("Fixture does not stream", { status: 400 });
    },
  });
  for await (const _event of anthropic.streamChat(imageRequest)) {
    // The protocol assertion below concerns the request body.
  }
  assert.deepEqual(anthropicMessages, [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: encoded },
        },
      ],
    },
  ]);

  await start(saved.id, "fixture-vision", "live");
  await until(() => {
    const preview = ui.renderer.root.findDescendantById(
      `photo-preview-${photo.image.id}`,
    );
    return preview instanceof ImageRenderable && !!preview.image;
  }, "Превью не загрузилось при подтверждённом Kitty Graphics");
  await stop();

  await start(saved.id, "fixture-vision", "split");
  await until(
    () =>
      ui.externalOutput
        .take()
        .some(
          ({ rows }) =>
            rows.some((row) => row.includes(filename)) && rows.length >= 5,
        ),
    "Split-footer не записал изображение и подписи одним блоком",
  );
  console.log("Ввод, отправка и восстановление фото проверены в OpenTUI");
} finally {
  await stop();
  globalThis.fetch = realFetch;
  await server.stop(true);
  await rm(storage, { recursive: true, force: true });
}
