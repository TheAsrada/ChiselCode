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
import { userSkillsDir } from "../../src/paths/home.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

// Scripted provider; production UI, executor, managed library and checkpoints.
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-creator-")),
);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(directory, "home");
process.env.OPENAI_API_KEY = "fixture-creator-key";
const root = join(directory, "workspace");
await mkdir(root);
const automatic =
  "Создай пользовательский навык russian-notes для заметок ревью на русском языке.";
const manual =
  "Create the user skill english-notes for review notes in English.";
const russian =
  "---\nname: russian-notes\ndescription: Составляй заметки, когда пользователь просит ревью.\n---\n# Заметки ревью\n\nОпиши найденные ошибки и способы исправления.\n";
const english =
  "---\nname: english-notes\ndescription: Write review notes when the user asks for a review.\n---\n# Review notes\n\nDescribe issues and suggested fixes.\n";
let calls = 0;
let failure: unknown;
const call = (id: string, name: string, input: object) => ({
  index: 0,
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(input) },
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "creator-model",
            context_window: 65536,
            max_output_tokens: 4096,
          },
        ],
      });
    try {
      const body = (await request.json()) as {
        messages: { role: string; content?: string }[];
      };
      const all = JSON.stringify(body.messages);
      const user =
        body.messages.filter((message) => message.role === "user").at(-1)
          ?.content ?? "";
      const tools = body.messages.filter((message) => message.role === "tool");
      const step = ++calls;
      let delta: object;
      if (step === 1) {
        assert.ok(
          all.includes("<name>skill-creator</name>"),
          "Creator is advertised to the model",
        );
        assert.equal(user, automatic);
        delta = {
          tool_calls: [
            call("creator-auto", "load_skill", { name: "skill-creator" }),
          ],
        };
      } else if (step === 2) {
        assert.ok(
          tools.at(-1)?.content?.includes("# Skill Creator"),
          "load_skill returned real bundled instructions",
        );
        assert.ok(tools.at(-1)?.content?.includes("user's language"));
        delta = {
          tool_calls: [
            call("create-russian", "create_skill", {
              name: "russian-notes",
              files: { "SKILL.md": russian },
            }),
          ],
        };
      } else if (step === 4) {
        assert.ok(
          user.startsWith("# Skill Creator"),
          "Slash expands instructions before calling the provider",
        );
        assert.ok(
          user.endsWith(manual),
          "Slash arguments are a separate current request",
        );
        assert.ok(!user.includes("$ARGUMENTS"));
        delta = {
          tool_calls: [
            call("create-english", "create_skill", {
              name: "english-notes",
              files: { "SKILL.md": english },
            }),
          ],
        };
      } else {
        assert.ok(step === 3 || step === 5, "No extra model requests");
        assert.ok(tools.at(-1)?.content?.includes("User skill created:"));
        delta = {
          content:
            step === 3 ? "Русский навык создан." : "English skill created.",
        };
      }
      return new Response(
        `data: ${JSON.stringify({ id: "creator", choices: [{ index: 0, delta, finish_reason: step === 3 || step === 5 ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } catch (error) {
      failure = error;
      return Response.json(
        { error: { message: "Creator fixture assertion failed" } },
        { status: 500 },
      );
    }
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
        providerId: "openai-compatible",
        defaultModel: "creator-model",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ui = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
async function until(ready: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
    if (ready()) return;
  }
  throw new Error(`${label}\n${ui.captureCharFrame()}`);
}
async function send(text: string) {
  await until(
    () => !!ui.renderer.currentFocusedEditor,
    "Composer is not ready",
  );
  await act(async () => {
    await ui.mockInput.typeText(text);
    ui.mockInput.pressEnter();
  });
}
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath, allow: "create_skill" },
      undefined,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
    void application.catch((error) => {
      failure = error;
    });
  });
  await send(automatic);
  await until(
    () =>
      calls === 3 &&
      ui.captureCharFrame().includes("Русский навык создан.") &&
      ui.captureCharFrame().includes("Завершено за") &&
      !ui.renderer.root.findDescendantById("request-status"),
    "Automatic creator did not finish",
  );
  assert.equal(
    await readFile(join(userSkillsDir(), "russian-notes/SKILL.md"), "utf8"),
    russian,
  );
  await send(`/skill-creator ${manual}`);
  await until(
    () =>
      calls === 5 &&
      ui.captureCharFrame().includes("English skill created.") &&
      (ui.captureCharFrame().match(/Завершено за/g)?.length ?? 0) === 2 &&
      !ui.renderer.root.findDescendantById("request-status"),
    "Manual creator did not finish",
  );
  assert.equal(
    await readFile(join(userSkillsDir(), "english-notes/SKILL.md"), "utf8"),
    english,
  );
  assert.ok(ui.captureCharFrame().includes("Навыки"));
  assert.ok(ui.captureCharFrame().includes("skill-creator"));
  const store = await projectSessionStore(root);
  const record = (await store.list())[0];
  assert.ok(record);
  const saved = await store.load(record.id);
  assert.equal(saved.runtime?.invocations["creator-auto"]?.state, "succeeded");
  assert.equal(
    saved.runtime?.invocations["create-russian"]?.state,
    "succeeded",
  );
  assert.equal(
    saved.runtime?.invocations["create-english"]?.state,
    "succeeded",
  );
  if (process.env.CHISEL_CAPTURE_DIR) {
    const output = process.env.CHISEL_CAPTURE_DIR;
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "skill-creator.txt"), ui.captureCharFrame());
    const spans = ui.captureSpans();
    await writeFile(
      join(output, "skill-creator.json"),
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
    "Skill creator OpenTUI: automatic load, manual slash expansion, RU/EN files and checkpoints verified",
  );
} finally {
  if (application)
    await act(async () => {
      process.emit("SIGTERM");
      await application?.catch(() => {});
    });
  server.stop(true);
  ui.renderer.destroy();
  await rm(directory, { recursive: true, force: true });
}
