import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionChatView,
  ExtensionContext,
} from "../../src/extensions/contracts.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { attachExtensionTools } from "../../src/extensions/tools.js";
import {
  createSession,
  loadSession,
  saveSession,
} from "../../src/sessions/store.js";
import { ToolCatalog } from "../../src/tools/catalog.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { ChatCard } from "../../src/types/chat-presentation.js";
import {
  appendToolResult,
  replaySessionIntoTranscript,
  toolTranscriptHandlers,
} from "../../src/ui/tool-transcript.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { fixtureTool } from "../fixtures/tool-extension.js";

const report: ChatCard = {
  id: "report",
  revision: 1,
  title: "Проверка проекта",
  description: "Проверены файлы проекта",
  status: { label: "Готово", tone: "success" },
};

test("tools and commands share workspace-owned chat views and preserve model-facing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-extension-chat-"));
  const view: ExtensionChatView = {
    id: "report",
    render(data) {
      expect(Object.isFrozen(data)).toBe(true);
      return { cards: [report] };
    },
  };
  let context!: ExtensionContext;
  const tool = fixtureTool("inspect", {
    chat: { title: "Проверка проекта", inputField: "label", view: "report" },
  });
  tool.execute = async () => ({ output: "Original provider-visible output" });
  const host = new ExtensionHost([
    {
      id: "vendor/report",
      activate(ctx) {
        context = ctx;
        ctx.chat.register(view);
        ctx.tools.register(tool);
        ctx.commands.register({
          name: "report",
          description: "Проверить проект",
          chat: { title: "Проверка проекта", view: "report" },
          parse: () => undefined,
          execute: () => ({ output: "Command output" }),
        });
      },
    },
    {
      id: "other",
      activate(ctx) {
        ctx.chat.register({
          id: "report",
          render: () => ({ summary: "Другое расширение" }),
        });
      },
    },
  ]);
  try {
    const scope = await host.open(root);
    view.render = () => {
      throw new Error("Mutated registration");
    };
    const catalog = new ToolCatalog();
    const binding = await attachExtensionTools(scope, catalog);
    const handler = catalog.get("ext:vendor/report:inspect");
    expect(handler.spec.source).toMatchObject({
      chat: { title: "Проверка проекта", view: "report" },
    });
    expect(
      catalog.selectForTurn().find((item) => item.name === handler.spec.name),
    ).not.toHaveProperty("chat");
    const result = await handler.execute({} as ToolContext, {
      data: undefined,
      preview: "",
      resources: [],
    });
    expect(result.output).toBe("Original provider-visible output");
    expect(result.presentation).toEqual({
      extensionId: "vendor/report",
      view: { cards: [report] },
    });
    const controller = new TuiController(root);
    const handlers = toolTranscriptHandlers(() => controller);
    handlers.onToolStart?.(
      handler.spec.name,
      { label: "Навигация" },
      handler.spec.source,
    );
    expect(controller.snapshot.toolActivity).toBe(
      "Проверка проекта · «Навигация»",
    );
    appendToolResult(controller, handler.spec.name, result);
    expect(controller.snapshot.transcript[0]?.chatCard?.extensionId).toBe(
      "vendor/report",
    );
    const command = scope.commands.get("report");
    const commandResult = await command.execute(
      {} as Parameters<typeof command.execute>[0],
      undefined,
    );
    expect(commandResult).toMatchObject({
      output: "Command output",
      presentation: { extensionId: "vendor/report", view: { cards: [report] } },
    });
    expect(scope.commands.descriptors()[0]?.chat?.title).toBe(
      "Проверка проекта",
    );
    expect(scope.chat.render("other", "report", {})?.view.summary).toBe(
      "Другое расширение",
    );
    expect(() =>
      context.chat.register({ id: "late", render: () => undefined }),
    ).toThrow();
    await binding.dispose();
    await host.dispose();
    expect(scope.chat.render("vendor/report", "report", {})).toBeUndefined();
    controller.dispose();
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid or throwing chat formatters never fail an executed tool or forge another owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-bad-chat-"));
  const tool = fixtureTool("inspect", {
    chat: { title: "Проверка", view: "bad" },
  });
  tool.execute = async () => ({
    output: "Executed",
    presentation: { extensionId: "other", view: { cards: [report] } },
  });
  let fail = false;
  const host = new ExtensionHost([
    {
      id: "bad",
      activate(ctx) {
        ctx.chat.register({
          id: "bad",
          render: () => {
            if (fail) throw new Error("Formatting failed");
            return { cards: [{ ...report, revision: -1 }] };
          },
        });
        ctx.tools.register(tool);
      },
    },
  ]);
  try {
    const scope = await host.open(root);
    const handler = await scope.tools.getHandler("ext:bad:inspect");
    for (const value of [false, true]) {
      fail = value;
      expect(
        await handler.execute({} as ToolContext, {
          data: undefined,
          preview: "",
          resources: [],
        }),
      ).toEqual({ output: "Executed" });
    }
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("card revisions are scoped to the extension and leave the main stream and draft intact", () => {
  const controller = new TuiController(process.cwd());
  controller.setDraft("Продолжить работу");
  controller.upsertCard("one", report);
  const firstId = controller.snapshot.transcript[0]?.id;
  controller.appendToLast("Основной ответ ");
  controller.upsertCard("one", {
    ...report,
    revision: 3,
    status: { label: "Ошибка", tone: "error" },
  });
  controller.upsertCard("one", { ...report, revision: 2 });
  controller.upsertCard("one", { ...report, revision: 3 });
  controller.upsertCard("two", report);
  expect(controller.snapshot.transcript).toHaveLength(2);
  expect(controller.snapshot.transcript[0]?.id).toBe(firstId);
  expect(controller.snapshot.transcript[0]?.chatCard?.card.status?.tone).toBe(
    "error",
  );
  expect(controller.snapshot.streaming).toBe("Основной ответ ");
  expect(controller.snapshot.draft).toBe("Продолжить работу");
  controller.dispose();
});

test("saved command cards replay after an extension is absent without changing provider messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-chat-replay-"));
  const variable =
    process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
  const prior = process.env[variable];
  process.env[variable] = root;
  try {
    const session = createSession(root, "anthropic", "test");
    session.messages = [
      { role: "user", content: [{ type: "text", text: "/report" }] },
    ];
    session.chatPresentations = [
      {
        afterMessage: 1,
        presentation: {
          extensionId: "vendor/report",
          view: { cards: [report] },
        },
      },
    ];
    await saveSession(session);
    const restored = await loadSession(session.id, root);
    expect(restored.messages).toEqual(session.messages);
    const controller = new TuiController(root);
    replaySessionIntoTranscript(controller, restored);
    expect(controller.snapshot.transcript[1]?.chatCard).toEqual({
      extensionId: "vendor/report",
      card: report,
    });
    expect(
      controller.snapshot.transcript.some((item) =>
        item.text.includes("[extension]"),
      ),
    ).toBe(false);
    controller.dispose();
  } finally {
    if (prior === undefined) delete process.env[variable];
    else process.env[variable] = prior;
    await rm(root, { recursive: true, force: true });
  }
});
