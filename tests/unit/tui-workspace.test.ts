import { expect, test } from "bun:test";
import { createSession } from "../../src/sessions/store.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

test("home and tabs preserve independent drafts, projects and background output", () => {
  const workspace = new TuiWorkspace("/project-a");
  try {
    const first = workspace.newTab();
    const firstKey = workspace.activeKey;
    first.setDraft("first draft");
    first.setBusy(true);
    const second = workspace.newTab("/project-b");
    second.setDraft("second draft");
    first.appendToLast("background answer");
    expect(second.snapshot.streaming).toBe("");
    workspace.select();
    expect(workspace.controller).toBe(workspace.home);
    workspace.select(firstKey);
    expect(workspace.controller.snapshot).toMatchObject({
      draft: "first draft",
      projectPath: "/project-a",
      streaming: "background answer",
    });
    expect(workspace.close()).toBe(false);
    first.setBusy(false);
    expect(workspace.close()).toBe(true);
    expect(workspace.controller).toBe(second);
    expect(second.snapshot.draft).toBe("second draft");
    workspace.close();
    expect(workspace.controller).toBe(workspace.home);
  } finally {
    workspace.dispose();
  }
});

test("opening a saved session reuses its tab without replacing unsent input", () => {
  const workspace = new TuiWorkspace("/project");
  try {
    const session = createSession("/project", "anthropic", "model");
    session.title = "Saved conversation";
    session.messages = [
      { role: "user", content: [{ type: "text", text: "original prompt" }] },
    ];
    const controller = workspace.openSession(session);
    controller.setDraft("unsent");
    workspace.select();
    expect(workspace.openSession(session)).toBe(controller);
    expect(workspace.tabs).toHaveLength(1);
    expect(controller.snapshot.draft).toBe("unsent");
    expect(controller.snapshot.transcript[0]?.text).toContain(
      "original prompt",
    );
    workspace.close();
    workspace.openSession(session);
    expect(workspace.controller.snapshot.sessionId).toBe(session.id);
    expect(session.messages).toHaveLength(1);
  } finally {
    workspace.dispose();
  }
});

test("cycling visits only conversation tabs and closing an inactive tab keeps the current route", () => {
  const workspace = new TuiWorkspace("/project");
  try {
    workspace.newTab();
    const firstKey = workspace.activeKey;
    const second = workspace.newTab();
    workspace.close(firstKey);
    expect(workspace.controller).toBe(second);
    workspace.cycle(1);
    expect(workspace.controller).toBe(second);
    workspace.newDraft();
    expect(workspace.controller).toBe(workspace.home);
    workspace.cycle(-1);
    expect(workspace.controller).toBe(second);
  } finally {
    workspace.dispose();
  }
});

test("a new draft opens welcome without allocating a tab and keeps existing conversations", () => {
  const workspace = new TuiWorkspace("/project-a");
  try {
    workspace.home.setDraft("pending task");
    expect(workspace.newDraft()).toBe(workspace.home);
    expect(workspace.home.snapshot.draft).toBe("pending task");
    expect(workspace.tabs).toHaveLength(0);
    const first = workspace.newTab("/project-b");
    first.setDraft("unsent in conversation");
    first.setBusy(true);
    const firstKey = workspace.activeKey;
    workspace.newDraft();
    expect(workspace.tabs).toHaveLength(1);
    expect(workspace.home.snapshot).toMatchObject({
      projectPath: "/project-b",
      draft: "",
    });
    first.appendToLast("background response");
    expect(workspace.home.snapshot.streaming).toBe("");
    workspace.cycle(1);
    expect(workspace.activeKey).toBe(firstKey);
    expect(workspace.controller.snapshot).toMatchObject({
      draft: "unsent in conversation",
      streaming: "background response",
      busy: true,
    });
  } finally {
    workspace.dispose();
  }
});
