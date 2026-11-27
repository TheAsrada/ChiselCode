import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { userSkillsDir } from "../../src/paths/home.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-skill-catalog-")),
);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(storage, "home");
process.env.OPENAI_API_KEY = "fixture-skill-key";
const root = join(storage, "workspace");
await mkdir(root);

async function writeSkill(name: string, text: string) {
  const dir = join(userSkillsDir(), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), text);
  return dir;
}
for (let index = 0; index < 103; index++)
  await writeSkill(
    `a-${String(index).padStart(3, "0")}`,
    `---\ndescription: ${"Проверка ".repeat(90)}\n---\nSample filler workflow`,
  );
const manual = await writeSkill(
  "zzz-manual",
  "---\ndescription: Запускай только по команде.\ndisable-model-invocation: true # manual only\n---\nManual workflow for $ARGUMENTS. Read references/guide.md.",
);
await mkdir(join(manual, "references"));
await writeFile(
  join(manual, "references", "guide.md"),
  "Verified manual guide.",
);
await writeFile(
  join(userSkillsDir(), "outside.md"),
  "Outside library sentinel.",
);
const other = await writeSkill(
  "zzz-other",
  "---\ndisable-model-invocation: true\n---\nAnother manual workflow.",
);
await writeFile(join(other, "guide.md"), "Other manual sentinel.");
await writeSkill(
  "zzz-invalid",
  "---\ndisable-model-invocation: [true]\n---\nInvalid invocation flag.",
);
await writeSkill(
  "zzz-searchable",
  `---\ndescription: ${"Проверка ".repeat(85)} редкий протокол\n---\nWorkflow discoverable only by search.`,
);

const reference = { name: "zzz-manual", path: "references/guide.md" };
const firstCalls = [
  { id: "guide", name: "load_skill", input: reference },
  {
    id: "other",
    name: "load_skill",
    input: { name: "zzz-other", path: "guide.md" },
  },
  { id: "body", name: "load_skill", input: { name: "zzz-manual" } },
  {
    id: "traversal",
    name: "load_skill",
    input: { name: "zzz-manual", path: "../outside.md" },
  },
  { id: "find", name: "search_skills", input: { query: "РЕДКИЙ ПРОТОКОЛ" } },
];
let requests = 0;
let failure: unknown;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models"))
      return Response.json({
        data: [{ id: "fixture-skill-model", context_window: 65536 }],
      });
    try {
      const body = (await request.json()) as {
        messages: { role: string; content?: string; tool_call_id?: string }[];
        tools: { function: { name: string } }[];
      };
      const system =
        body.messages.find(({ role }) => role === "system")?.content ?? "";
      const user = body.messages
        .filter(({ role }) => role === "user")
        .at(-1)?.content;
      const result = (id: string) =>
        body.messages.find(
          (message) => message.role === "tool" && message.tool_call_id === id,
        )?.content ?? "";
      let outgoing: typeof firstCalls = [];
      let content = "";
      switch (++requests) {
        case 1: {
          const catalog =
            system.match(
              /<available_skills>[\s\S]*?<\/available_skills>/,
            )?.[0] ?? "";
          assert.ok(catalog.includes("search_skills"));
          assert.ok(Buffer.byteLength(catalog) <= 8192);
          assert.doesNotMatch(
            catalog,
            /zzz-manual|zzz-invalid|zzz-searchable|zzz-other/,
          );
          assert.match(system, /user invoked \/zzz-manual/);
          assert.match(user ?? "", /Manual workflow for задача 42/);
          assert.ok(
            body.tools.some(
              ({ function: tool }) => tool.name === "search_skills",
            ),
          );
          outgoing = firstCalls;
          break;
        }
        case 2: {
          assert.match(result("guide"), /Verified manual guide/);
          assert.match(result("other"), /not available for this request/);
          assert.match(result("body"), /not available for this request/);
          assert.ok(result("traversal"));
          assert.doesNotMatch(result("traversal"), /Outside library sentinel/);
          assert.deepEqual(
            JSON.parse(result("find")).skills.map(
              ({ name }: { name: string }) => name,
            ),
            ["zzz-searchable"],
          );
          outgoing = [
            {
              id: "discovered",
              name: "load_skill",
              input: { name: "zzz-searchable" },
            },
          ];
          break;
        }
        case 3:
          assert.match(
            result("discovered"),
            /Workflow discoverable only by search/,
          );
          content = "Справочник прочитан";
          break;
        case 4:
          assert.equal(user, "Повтори чтение справочника");
          assert.doesNotMatch(system, /user invoked \/zzz-manual/);
          outgoing = [{ id: "expired", name: "load_skill", input: reference }];
          break;
        case 5:
          assert.match(result("expired"), /not available for this request/);
          content = "Доступ завершён";
          break;
        default:
          throw new Error("Unexpected model request.");
      }
      const delta = outgoing.length
        ? {
            tool_calls: outgoing.map(({ id, name, input }, index) => ({
              index,
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(input) },
            })),
          }
        : { content };
      const frame = {
        id: "skill-catalog",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta,
            finish_reason: outgoing.length ? "tool_calls" : "stop",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`,
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    } catch (error) {
      failure = error;
      return Response.json(
        { error: { message: "Skill catalog fixture assertion" } },
        { status: 500 },
      );
    }
  },
});
const configPath = join(storage, "config.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    defaultProfileId: "fixture",
    profiles: {
      fixture: {
        providerId: "openai-compatible",
        defaultModel: "fixture-skill-model",
        baseUrl: `${server.url}v1`,
      },
    },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);

const ui = await createTestRenderer({
  width: 120,
  height: 36,
  exitOnCtrlC: false,
});
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
async function until(ready: () => boolean, reason: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
    if (ready()) return;
  }
  throw new Error(`${reason}\n${ui.captureCharFrame()}`);
}
async function paste(text: string, enter = false) {
  await act(async () => {
    await ui.mockInput.pasteBracketedText(text);
    if (enter) ui.mockInput.pressEnter();
  });
}
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath, mode: "plan" },
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
  await until(() => !!ui.renderer.currentFocusedEditor, "Composer not ready");
  await paste("/skills", true);
  await until(
    () => !!ui.renderer.root.findDescendantById("skills-popup"),
    "Skills popup did not open",
  );
  const search = ui.renderer.root.findDescendantById("skills-search");
  assert.ok(search);
  await act(async () => ui.mockMouse.click(search.x + 1, search.y));
  await until(
    () => ui.renderer.currentFocusedEditor?.id === "skills-search",
    "Skill search is not focused",
  );
  await paste("zzz-manual");
  await until(
    () =>
      ui.captureCharFrame().includes("/zzz-manual") &&
      ui.captureCharFrame().includes("Вручную"),
    "Tail of the library is missing",
  );
  const output = process.env.CHISEL_SKILL_CATALOG_CAPTURES;
  if (output) {
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, "local-skill-catalog.txt"),
      ui.captureCharFrame(),
    );
    const spans = ui.captureSpans();
    await writeFile(
      join(output, "local-skill-catalog.json"),
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
  await act(async () => ui.mockInput.pressEnter());
  await until(
    () => ui.renderer.currentFocusedEditor?.plainText === "/zzz-manual ",
    "Skill was not selected",
  );
  await paste("задача 42", true);
  await until(
    () =>
      requests === 3 &&
      !ui.renderer.root.findDescendantById("request-status") &&
      ui.captureCharFrame().includes("Справочник прочитан"),
    "Manual skill request did not finish",
  );
  await paste("Повтори чтение справочника", true);
  await until(
    () => requests === 5 && ui.captureCharFrame().includes("Доступ завершён"),
    "Follow-up request did not prove expiration",
  );
  console.log(
    "Skill catalog OpenTUI: full library, explicit references, bounded search and follow-up verified",
  );
} finally {
  if (application)
    await act(async () => {
      process.emit("SIGTERM");
      await application?.catch(() => {});
    });
  server.stop(true);
  ui.renderer.destroy();
  await rm(storage, { recursive: true, force: true });
}
