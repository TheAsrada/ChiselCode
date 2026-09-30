/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { SessionSummary } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import {
  OpenTuiSessions,
  type OpenTuiSessionsActions,
} from "../../src/ui/opentui-sessions.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";

const base: SessionSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Первый сеанс",
  titleSource: "auto",
  createdAt: "2026-09-27T10:00:00.000Z",
  updatedAt: "2026-09-27T10:00:00.000Z",
  providerId: "anthropic",
  profileId: "anthropic-default",
  model: "claude-opus-5",
  messageCount: 2,
  totalTokens: { inputTokens: 30, outputTokens: 10 },
};

test("session picker searches, previews and resumes without losing the composer", async () => {
  const second = {
    ...base,
    id: "00000000-0000-4000-8000-000000000002",
    title: "Второй сеанс",
    updatedAt: "2026-09-28T10:00:00.000Z",
  };
  const entries = [base, second];
  const resumed: string[] = [];
  const preview = createSession(process.cwd(), "anthropic", "claude-opus-5");
  preview.id = base.id;
  preview.messages = [
    { role: "user", content: [{ type: "text", text: "Секретный запрос" }] },
  ];
  const actions: OpenTuiSessionsActions = {
    load: async () => [...entries],
    preview: async () => preview,
    resume: async (id) => {
      resumed.push(id);
    },
    rename: async () => {},
    delete: async () => {},
    activeId: () => undefined,
  };
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {}}
      sessionPicker={actions}
      onSubmit={async () => {}}
    />,
    { width: 60, height: 15 },
  );
  try {
    await setup.renderOnce();
    await act(async () => {
      await setup.mockInput.typeText("/sessions");
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Возобновить сессию");
    await act(async () => {
      await setup.mockInput.typeText("Первый");
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("1 сессий");
    await act(async () => {
      setup.mockInput.pressKey(" ");
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Секретный запрос");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(resumed).toEqual([base.id]);
    expect(setup.captureCharFrame()).toContain("Опишите задачу");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("session picker confirms deletion and refreshes without deleting on Escape", async () => {
  const entries = [base];
  const deleted: string[] = [];
  const actions: OpenTuiSessionsActions = {
    load: async () => [...entries],
    preview: async () =>
      createSession(process.cwd(), "anthropic", "claude-opus-5"),
    resume: async () => {},
    rename: async (_id, title) => {
      entries[0] = { ...base, title };
    },
    delete: async (id) => {
      deleted.push(id);
      entries.length = 0;
    },
    activeId: () => base.id,
  };
  const setup = await testRender(
    <OpenTuiSessions
      actions={actions}
      width={80}
      height={24}
      onClose={() => {}}
    />,
    { width: 80, height: 24 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Первый сеанс");
    await act(async () => {
      setup.mockInput.pressKey("r", { ctrl: true });
    });
    await act(async () => {
      setup.mockInput.pressKey("!");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(entries[0]?.title).toBe("Первый сеанс!");
    await act(async () => {
      setup.mockInput.pressKey("d", { ctrl: true });
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Удалить");
    await act(async () => {
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(deleted).toEqual([]);
    await act(async () => {
      setup.mockInput.pressKey("d", { ctrl: true });
    });
    await act(async () => {
      setup.mockInput.pressKey("y");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await setup.renderOnce();
    expect(deleted).toEqual([base.id]);
    expect(setup.captureCharFrame()).toContain("Сессий нет");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
