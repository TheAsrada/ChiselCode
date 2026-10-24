import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { execa } from "execa";
import { act } from "react";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const directory = await mkdtemp(join(tmpdir(), "chisel-worktree-manager-"));
const root = join(directory, "Проект");
await mkdir(root);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(directory, "home");
process.env.OPENAI_API_KEY = "fixture-worktree-manager";
delete process.env.CHISEL_NO_ALT_SCREEN;
delete process.env.CHISEL_ALT_SCREEN;
const git = async (...args: string[]) =>
  (
    await execa(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: root },
    )
  ).stdout;
await git("init", "--initial-branch=main");
await git("config", "core.autocrlf", "false");
await writeFile(join(root, "file.txt"), "base\n");
await git("add", ".");
await git("commit", "-m", "base");
let generations = 0;
let failure: unknown;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "fixture-manager",
            context_window: 65536,
            max_output_tokens: 4096,
          },
        ],
      });
    try {
      generations++;
      const body = (await request.json()) as { messages: { role: string }[] };
      const step = body.messages.filter(
        (message) => message.role === "tool",
      ).length;
      const call =
        step === 0
          ? { name: "read_file", input: { path: "file.txt" } }
          : step === 1
            ? {
                name: "write_file",
                input: {
                  path: "file.txt",
                  content: "result from managed task\n",
                },
              }
            : undefined;
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `manager-${step}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                },
              },
            ],
          }
        : { content: "Правка готова, файл сохранён в копии." };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } catch (error) {
      failure = error;
      return Response.json(
        { error: { message: "fixture failed" } },
        { status: 400 },
      );
    }
  },
});
const paper = process.env.CHISEL_TEST_THEME === "paper";
const configPath = join(directory, "config.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    defaultProfileId: "fixture",
    profiles: {
      fixture: {
        providerId: "openai-compatible",
        defaultModel: "fixture-manager",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    web: { enabled: false },
    lsp: { mode: "off" },
    ui: { theme: paper ? "paper" : "obsidian" },
  }),
);
const t = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
const until = async (
  predicate: () => boolean | Promise<boolean>,
  label: string,
) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await act(async () => {
      await Bun.sleep(15);
      await t.renderOnce();
    });
    if (failure) throw failure;
    if (await predicate()) return;
  }
  throw new Error(`${label}\n${t.captureCharFrame()}`);
};
const frame = async () => {
  await act(async () => {
    await t.renderOnce();
    await t.renderOnce();
  });
};
const key = async (name: string, ctrl = false) => {
  await act(async () => {
    t.mockInput.pressKey(name, { ctrl });
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame();
};
const send = async (text: string) => {
  await act(async () => {
    await t.mockInput.pasteBracketedText(text);
    t.mockInput.pressEnter();
  });
  await frame();
};
const click = async (id: string) => {
  await until(() => !!t.renderer.root.findDescendantById(id), `Missing ${id}`);
  const node = t.renderer.root.findDescendantById(id);
  assert.ok(node);
  await act(async () => {
    await t.mockMouse.click(node.x + 1, node.y);
  });
  await frame();
};
const idle = () =>
  until(
    () => !t.captureCharFrame().includes("Выполняется…"),
    "Manager remained busy",
  );
const captures = process.env.CHISEL_WORKTREE_CAPTURE_DIR;
const capture = async (name: string) => {
  if (!captures) return;
  await mkdir(captures, { recursive: true });
  await frame();
  const data = t.captureSpans();
  const filename = join(captures, `${paper ? "paper" : "obsidian"}-${name}`);
  await writeFile(`${filename}.txt`, t.captureCharFrame());
  await writeFile(
    `${filename}.json`,
    JSON.stringify({
      ...data,
      lines: data.lines.map((line) => ({
        spans: line.spans.map((span) => ({
          ...span,
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
        })),
      })),
    }),
  );
};
const records = async () => {
  const home = join(
    directory,
    "home",
    process.platform === "win32" ? "ChiselCode" : "chiselcode",
    "worktrees",
  );
  const repo = (await readdir(home).catch(() => []))[0];
  if (!repo) return [];
  return Object.values(
    JSON.parse(await readFile(join(home, repo, "registry.json"), "utf8"))
      .records,
  ) as { id: string; label: string; path: string; state: string }[];
};
const approve = async () => {
  await until(
    () => !!t.renderer.root.findDescendantById("approval-popup"),
    "Approval missing",
  );
  await capture("approval-120x40");
  await key("y");
};
const openManager = async () => {
  await send("/worktree");
  await until(
    () => !!t.renderer.root.findDescendantById("worktrees-popup"),
    "Worktree manager did not open",
  );
  await until(
    () =>
      t.captureCharFrame().includes("Основной проект") &&
      !t.captureCharFrame().includes("Выполняется…"),
    "List not ready",
  );
};
const create = async (label: string) => {
  await click("worktree-new");
  await until(
    () => !!t.renderer.root.findDescendantById("worktree-label"),
    "Create form missing",
  );
  await act(async () => {
    await t.mockInput.pasteBracketedText(label);
  });
  await frame();
  await click("worktree-create-next");
  await click("worktree-create-confirm");
  await approve();
  await until(
    async () =>
      (await records()).some(
        (record) => record.label === label && record.state === "ready",
      ),
    "Worktree was not created",
  );
  await idle();
  return (await records()).find((record) => record.label === label)!;
};
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath },
      undefined,
      false,
      false,
      undefined,
      async () => t.renderer,
    );
  });
  await until(
    () => !!t.renderer.root.findDescendantById("welcome"),
    "Welcome missing",
  );
  await openManager();
  assert.equal(generations, 0);
  await capture("origin-120x40");
  const task = await create("Новая аналитика");
  assert.equal(await readFile(join(task.path, "file.txt"), "utf8"), "base\n");
  await capture("created-120x40");
  await click("worktree-action-0");
  await until(
    () =>
      !t.renderer.root.findDescendantById("worktrees-popup") &&
      t.captureCharFrame().includes("Рабочая копия: Новая аналитика"),
    "Managed root not opened",
  );
  await send("/permissions acceptEdits");
  await send("Измени file.txt в этой копии");
  await until(
    () => t.captureCharFrame().includes("Правка готова"),
    "Real agent edit did not complete",
  );
  assert.equal(generations, 3);
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "base\n");
  assert.equal(
    await readFile(join(task.path, "file.txt"), "utf8"),
    "result from managed task\n",
  );
  await openManager();
  await click(`worktree-select-${task.id}`);
  await click("worktree-action-1");
  await until(
    () =>
      !!t.renderer.root.findDescendantById("worktree-apply-next") &&
      !t.captureCharFrame().includes("Выполняется…"),
    "Diff not ready",
  );
  await capture("diff-120x40");
  await click("worktree-apply-next");
  await click("worktree-mutation-confirm");
  await until(async () => {
    if (t.renderer.root.findDescendantById("approval-popup")) await key("y");
    return (
      (await readFile(join(root, "file.txt"), "utf8")) ===
      "result from managed task\n"
    );
  }, "Apply failed");
  await idle();
  await capture("applied-120x40");
  await key("ESCAPE");
  await key("ESCAPE");
  await until(
    () => !t.renderer.root.findDescendantById("worktrees-popup"),
    "Manager did not close",
  );
  await openManager();
  await click("worktree-select-origin");
  await click("worktree-action-0");
  await until(
    () =>
      !t.renderer.root.findDescendantById("worktrees-popup") &&
      t.captureCharFrame().includes("Основной проект:"),
    "Origin navigation failed",
  );
  await openManager();
  await click(`worktree-select-${task.id}`);
  await click("worktree-action-2");
  assert.ok(!t.renderer.root.findDescendantById("worktree-mutation-confirm"));
  assert.ok(
    t.captureCharFrame().includes("открыта") ||
      t.captureCharFrame().includes("изменения"),
  );
  await capture("blocked-remove-120x40");
  await click("worktree-action-3");
  await until(
    () => t.captureCharFrame().includes("Закрыть:"),
    "Managed tab action absent",
  );
  const node = t.renderer.root.findDescendantById("worktrees-popup");
  assert.ok(node);
  // The tab is selected by visible text, not an assumed generated tab number.
  const findTab = (current: typeof node): typeof node | undefined => {
    if (current?.id.startsWith("worktree-tab-")) return current;
    for (const child of current?.getChildren() ?? []) {
      const found = findTab(child);
      if (found) return found;
    }
  };
  const tab = findTab(node);
  assert.ok(tab);
  await click(tab.id);
  await key("ESCAPE");
  await idle();
  await key("r");
  await idle();
  const clean = await create("Чистая проверка");
  await click("worktree-action-2");
  await until(
    () => !!t.renderer.root.findDescendantById("worktree-mutation-confirm"),
    "Delete confirmation absent",
  );
  await capture("remove-120x40");
  await click("worktree-mutation-confirm");
  await approve();
  await until(
    async () => !(await stat(clean.path).catch(() => undefined)),
    "Clean copy not removed",
  );
  await idle();
  assert.equal(
    await readFile(join(root, "file.txt"), "utf8"),
    "result from managed task\n",
  );
  assert.equal(
    await readFile(join(task.path, "file.txt"), "utf8"),
    "result from managed task\n",
  );
  assert.equal(generations, 3, "Manager must not generate model requests");
  for (const [width, height] of [
    [80, 24],
    [40, 20],
    [24, 8],
  ]) {
    await act(async () => {
      t.renderer.resize(width as number, height as number);
    });
    await frame();
    const popup = t.renderer.root.findDescendantById("worktrees-popup");
    assert.ok(popup);
    assert.ok(
      popup.x >= 0 &&
        popup.y >= 0 &&
        popup.x + popup.width <= (width as number) &&
        popup.y + popup.height <= (height as number),
    );
    await capture(`list-${width}x${height}`);
  }
  await key("ESCAPE");
  await act(async () => {
    t.renderer.resize(120, 40);
  });
  await frame();
  const store = await projectSessionStore(root);
  for (const entry of await store.list()) {
    const session = await store.load(entry.id);
    assert.equal(
      session.messages.length,
      0,
      "Manager operations must not enter model messages",
    );
    assert.equal(
      session.chatPresentations?.length ?? 0,
      0,
      "List refresh must not append duplicate chat presentations",
    );
  }
  await send("/exit");
  await application;
  process.stdout.write(
    "Worktree manager: actual OpenTUI/approvals, create/open, real isolated edit, preview/apply, origin/close, dirty refusal, clean remove, resize and no model/history pollution passed.\n",
  );
} finally {
  server.stop(true);
  t.renderer.destroy();
  await rm(directory, { recursive: true, force: true });
}
