import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { execa } from "execa";
import { act } from "react";
import { canonicalWorkspaceRoot } from "../../src/extensions/host.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";
import {
  installedLsp,
  lspProcessTree,
  waitForLspProcessExit,
} from "./lsp-runtime.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const directory = await mkdtemp(join(tmpdir(), "chisel-worktree-tui-"));
const root = join(directory, "Проект");
await mkdir(root);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = directory;
process.env.OPENAI_API_KEY = "fixture-worktree-key";
delete process.env.CHISEL_ALT_SCREEN;
delete process.env.CHISEL_NO_ALT_SCREEN;
const git = async (cwd: string, ...args: string[]) =>
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
      { cwd },
    )
  ).stdout;
await git(root, "init", "--initial-branch=main");
await git(root, "config", "core.autocrlf", "false");
await writeFile(
  join(root, "same.ts"),
  'export const value: number = "wrong";\n',
);
await writeFile(
  join(root, "tsconfig.json"),
  '{"compilerOptions":{"strict":true}}',
);
await writeFile(
  join(root, "package.json"),
  '{"name":"worktree-tui-isolation"}',
);
await git(root, "add", ".");
await git(root, "commit", "-m", "base");
const installation = await installedLsp();
let requests = 0,
  side = 0,
  failure: unknown;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    try {
      if (new URL(request.url).pathname.endsWith("/models"))
        return Response.json({
          data: [
            {
              id: "fixture-worktree",
              context_window: 65536,
              max_output_tokens: 4096,
            },
          ],
        });
      const body = (await request.json()) as {
        tools?: { function: { name: string } }[];
        messages: { role: string; content?: string }[];
      };
      const schemas = body.tools ?? [];
      let delta: object;
      let finish = "stop";
      if (!schemas.length) {
        side++;
        delta = {
          content: "Побочный вопрос продолжает работать в изолированной копии.",
        };
      } else {
        requests++;
        const name = (prefix: string) => {
          const tool = schemas.find((tool) =>
            tool.function.name.startsWith(prefix),
          );
          assert.ok(tool);
          return tool.function.name;
        };
        const question = String(
          [...body.messages]
            .reverse()
            .find((message) => message.role === "user")?.content ?? "",
        );
        const value = question.includes("Первая") ? 1 : 2;
        const step = body.messages.filter(
          (message) => message.role === "tool",
        ).length;
        const calls = [
          { name: "read_file", input: { path: "same.ts" } },
          {
            name: name("ext_ext_builtin_lsp_diagnostics_"),
            input: { path: "same.ts" },
          },
          {
            name: "write_file",
            input: {
              path: "same.ts",
              content: `export const value: number = ${value};\n`,
            },
          },
          { name: name("ext_ext_builtin_project_manifest_"), input: {} },
          { name: "git_status", input: {} },
        ];
        const call = calls[step];
        if (call) {
          finish = "tool_calls";
          delta = {
            tool_calls: [
              {
                index: 0,
                id: `step-${step}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                },
              },
            ],
          };
        } else {
          assert.ok(JSON.stringify(body.messages).includes("observed"));
          delta = {
            content: `Задача ${value}: изменения сохранены в отдельной рабочей копии. Основной проект не изменён.`,
          };
        }
      }
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } catch (error) {
      failure = error;
      return Response.json(
        { error: { message: "Fixture failed" } },
        { status: 400 },
      );
    }
  },
});
const configPath = join(directory, "selected-config.json");
const theme = process.env.CHISEL_TEST_THEME === "paper" ? "paper" : "obsidian";
const unicode = process.env.CHISEL_TEST_UNICODE === "1";
const config = {
  schemaVersion: 2,
  defaultProfileId: "fixture",
  profiles: {
    fixture: {
      providerId: "openai-compatible",
      defaultModel: "fixture-worktree",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    },
  },
  web: { enabled: false },
  lsp: {
    mode: "custom",
    servers: { fixture: { ...installation, trustedWorkspaces: [root] } },
  },
  ui: { theme, unicodeDecorations: unicode, sidebarMode: "auto" },
};
await writeFile(configPath, JSON.stringify(config));
const setup = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
const frame = async () =>
  act(async () => {
    await setup.renderOnce();
  });
const until = async (
  check: () => boolean | Promise<boolean>,
  label: string,
) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    await act(async () => {
      await Bun.sleep(15);
      await setup.renderOnce();
    });
    if (failure) throw failure;
    if (await check()) return;
  }
  throw new Error(`${label}\n${setup.captureCharFrame()}`);
};
const key = async (name: string, ctrl = false, meta = false) => {
  await act(async () => {
    setup.mockInput.pressKey(name, { ctrl, meta });
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame();
};
const send = async (text: string) => {
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
    setup.mockInput.pressEnter();
  });
  await frame();
};
const idle = async () =>
  until(
    () => !setup.captureCharFrame().includes("Enter в очередь"),
    "Operation remained busy",
  );
const captures = process.env.CHISEL_CAPTURE_DIR;
const capture = async (state: string) => {
  if (!captures) return;
  await mkdir(captures, { recursive: true });
  await frame();
  const spans = setup.captureSpans();
  const name = `${theme}-${unicode ? "unicode" : "ascii"}-${state}`;
  await writeFile(join(captures, `${name}.txt`), setup.captureCharFrame());
  await writeFile(
    join(captures, `${name}.json`),
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
const records = async () => {
  const home = join(
    directory,
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
const approve = async (name: string) => {
  await until(
    () => !!setup.renderer.root.findDescendantById("approval-popup"),
    "Approval missing",
  );
  await capture(name);
  if (captures) {
    for (const [width, height] of [
      [100, 30],
      [80, 24],
      [60, 20],
      [40, 12],
      [24, 8],
    ]) {
      await act(async () =>
        setup.renderer.resize(width as number, height as number),
      );
      await frame();
      await capture(name.replace("120x40", `${width}x${height}`));
      const popup = setup.renderer.root.findDescendantById("approval-popup");
      assert.ok(
        popup &&
          popup.x >= 0 &&
          popup.y >= 0 &&
          popup.x + popup.width <= (width as number) &&
          popup.y + popup.height <= (height as number),
      );
    }
  }
  await key("y");
  await act(async () => setup.renderer.resize(120, 40));
  await frame();
};
let application: Promise<void> | undefined;
let pids: number[] = [];
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath, approvalMode: "acceptEdits" },
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
  for (const label of ["Первая задача", "Вторая задача"]) {
    await send(`/worktree create ${label}`);
    await approve("create-approval-120x40");
    await until(
      async () =>
        (await records()).some(
          (record) => record.label === label && record.state === "ready",
        ),
      "Create incomplete",
    );
    await idle();
  }
  const [a, b] = await records();
  assert.ok(a && b);
  config.lsp.servers.fixture.trustedWorkspaces.push(a.path, b.path);
  await writeFile(configPath, JSON.stringify(config));
  const sessions: string[] = [];
  for (const tree of [a, b]) {
    await send(`/worktree open ${tree.id}`);
    await until(
      () => setup.captureCharFrame().includes(`Рабочая копия: ${tree.label}`),
      "Open did not select managed root",
    );
    await idle();
    await send(`${tree.label}: проверь TypeScript и измени same.ts`);
    await until(
      () => setup.captureCharFrame().includes(`Задача ${tree === a ? 1 : 2}:`),
      "Agent did not finish in worktree",
    );
    await idle();
    const store = await projectSessionStore(tree.path);
    const list = await store.list();
    assert.equal(list.length, 1);
    const session = await store.load(list[0]?.id as string);
    sessions.push(session.id);
    const canonicalRoot = await canonicalWorkspaceRoot(tree.path);
    assert.equal(session.projectPath, canonicalRoot);
    assert.equal(session.worktree?.id, tree.id);
    assert.ok(
      Object.keys(session.runtime?.workspaceObservations ?? {}).every((path) =>
        (process.platform === "win32" ? path.toLowerCase() : path).startsWith(
          canonicalRoot,
        ),
      ),
    );
    assert.ok(
      Object.values(session.runtime?.invocations ?? {}).some(
        (record) =>
          record.toolSource?.type === "extension" &&
          record.toolSource.extensionId === "builtin.lsp",
      ),
    );
    await capture(`isolated-${tree === a ? "a" : "b"}-120x40`);
  }
  assert.notEqual(sessions[0], sessions[1]);
  assert.equal(requests, 12);
  assert.equal(
    await readFile(join(root, "same.ts"), "utf8"),
    'export const value: number = "wrong";\n',
  );
  assert.equal(
    await readFile(join(a.path, "same.ts"), "utf8"),
    "export const value: number = 1;\n",
  );
  assert.equal(
    await readFile(join(b.path, "same.ts"), "utf8"),
    "export const value: number = 2;\n",
  );
  pids = await lspProcessTree();
  assert.ok(pids.length >= 2);
  await send(`/worktree remove ${a.id}`);
  await until(
    () => setup.captureCharFrame().includes("WORKTREE_IN_USE"),
    "Inactive tab did not protect remove",
  );
  await idle();
  await capture("active-remove-refusal-120x40");
  await send("/permissions default");
  await frame();
  await send(`/worktree apply ${a.id}`);
  await approve("apply-approval-120x40");
  await until(
    async () =>
      (await readFile(join(root, "same.ts"), "utf8")).includes("= 1;"),
    "Apply failed",
  );
  await idle();
  await send(`/worktree apply ${b.id}`);
  await until(
    () => setup.captureCharFrame().includes("WORKTREE_CONFLICT"),
    "Conflicting second task did not stop",
  );
  await idle();
  await capture("conflict-120x40");
  await send("/btw Что изолировано в рабочей копии?");
  await until(
    () => setup.captureCharFrame().includes("Побочный вопрос продолжает"),
    "/btw unavailable",
  );
  assert.equal(side, 1);
  await key("ESCAPE");
  await send("/settings");
  await until(
    () => !!setup.renderer.root.findDescendantById("settings-global-search"),
    "Settings unavailable",
  );
  await key("ESCAPE");
  for (const [width, height] of [
    [120, 40],
    [100, 30],
    [80, 24],
    [60, 20],
    [40, 12],
    [24, 8],
  ]) {
    await act(async () =>
      setup.renderer.resize(width as number, height as number),
    );
    await frame();
    await capture(`result-${width}x${height}`);
    if (width === 24) {
      const editor = setup.renderer.root.findDescendantById("prompt-editor");
      assert.ok(
        editor &&
          editor.height >= 1 &&
          editor.y >= 0 &&
          editor.y + editor.height <= (height as number) &&
          editor.x + editor.width <= (width as number),
        "Tiny focused input clipped",
      );
      await act(async () => setup.mockInput.pasteBracketedText("Проверка"));
      await frame();
      assert.ok(setup.captureCharFrame().includes("Проверка"));
      await capture("tiny-draft-24x8");
      await act(async () => setup.renderer.resize(40, 12));
      await frame();
      assert.ok(
        setup.captureCharFrame().includes("Проверка"),
        "Resize lost draft",
      );
      await key("a", true);
      await key("k", true);
    }
  }
  await act(async () => setup.renderer.resize(120, 40));
  await frame();
  await key("ARROW_LEFT", false, true);
  await key("w", true);
  await frame();
  await send(`/worktree remove ${a.id}`);
  await until(
    () => setup.captureCharFrame().includes("WORKTREE_DIRTY"),
    "Closed dirty tree not preserved",
  );
  await idle();
  await send("/exit");
  await application;
  await waitForLspProcessExit(pids);
  assert.equal(
    (await records()).filter((record) => record.state === "ready").length,
    2,
  );
  process.stdout.write(
    "Worktree TUI: real detached creation/approval, two roots/sessions/LSP, isolated edits, apply/conflict, active/dirty refusal, Settings, /btw, resize and shutdown passed.\n",
  );
} finally {
  server.stop(true);
  setup.renderer.destroy();
  await rm(directory, { recursive: true, force: true });
}
