import { expect, test } from "bun:test";
import type { RuntimeEvent } from "../../src/runtime/events.js";
import {
  RequestActivityTracker,
  toolActivityKind,
} from "../../src/ui/request-activity.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

const event = (
  type: RuntimeEvent["type"],
  fields: Partial<RuntimeEvent> = {},
): RuntimeEvent => ({
  id: "event",
  sessionId: "session",
  timestamp: new Date(0).toISOString(),
  type,
  ...fields,
});

test("parallel tools remain active independently and only running invocations are counted", () => {
  const activity = new RequestActivityTracker();
  activity.reset();
  expect(
    activity.accept(
      event("tool_queued", { invocationId: "a", name: "read_file" }),
    ).kind,
  ).toBe("preparing");
  expect(
    activity.accept(
      event("tool_started", { invocationId: "a", name: "read_file" }),
    ).kind,
  ).toBe("reading");
  expect(
    activity.accept(event("tool_queued", { invocationId: "b", name: "grep" }))
      .kind,
  ).toBe("reading");
  expect(
    activity.accept(event("tool_started", { invocationId: "b", name: "grep" }))
      .label,
  ).toBe("Выполняю 2 действия");
  expect(
    activity.accept(
      event("tool_completed", { invocationId: "b", name: "grep" }),
    ).kind,
  ).toBe("reading");
  expect(
    activity.accept(
      event("tool_progress", { invocationId: "b", name: "grep", text: "late" }),
    ).kind,
  ).toBe("reading");
  expect(
    activity.accept(
      event("tool_failed", { invocationId: "a", name: "read_file" }),
    ).kind,
  ).toBe("thinking");
  expect(
    activity.accept(event("provider_text_delta", { text: "Ответ" })).kind,
  ).toBe("answering");
});

test("same-kind batches keep their semantic icon and approval does not look like execution", () => {
  const activity = new RequestActivityTracker();
  activity.accept(
    event("tool_started", { invocationId: "a", name: "read_file" }),
  );
  expect(
    activity.accept(
      event("tool_started", { invocationId: "b", name: "read_file" }),
    ).label,
  ).toBe("Читаю файлы · 2");
  expect(
    activity.accept(
      event("tool_approval_requested", {
        invocationId: "c",
        name: "write_file",
      }),
    ),
  ).toMatchObject({ kind: "approval", moving: false });
  expect(
    activity.accept(
      event("tool_failed", { invocationId: "c", name: "write_file" }),
    ).kind,
  ).toBe("reading");
});

test("prepared metadata supplies the true category and arbitrary shell/extension prose is not classified", () => {
  const activity = new RequestActivityTracker();
  activity.accept(
    event("tool_queued", {
      invocationId: "lsp",
      name: "ext:builtin.lsp:diagnostics",
    }),
  );
  const source = {
    type: "extension" as const,
    extensionId: "builtin.lsp",
    originalName: "diagnostics",
  };
  activity.accept(
    event("tool_prepared", {
      invocationId: "lsp",
      name: "ext:builtin.lsp:diagnostics",
      toolSource: source,
    }),
  );
  expect(
    activity.accept(
      event("tool_started", {
        invocationId: "lsp",
        name: "ext:builtin.lsp:diagnostics",
      }),
    ).kind,
  ).toBe("checking");
  expect(toolActivityKind("run_shell")).toBe("command");
  expect(
    toolActivityKind("read_file", {
      type: "extension",
      extensionId: "custom",
      originalName: "tests",
    }),
  ).toBe("tool");
  expect(
    toolActivityKind("ext:builtin.lsp:status", {
      ...source,
      originalName: "status",
    }),
  ).toBe("tool");
  expect(
    toolActivityKind("ext:builtin.lsp:definition", {
      ...source,
      originalName: "definition",
    }),
  ).toBe("searching");
  expect(toolActivityKind("tests_are_running")).toBe("tool");
});

test("provider failures, compaction, cancellation and a new request have independent lifetimes", () => {
  const activity = new RequestActivityTracker();
  expect(activity.accept(event("context_compaction_started")).kind).toBe(
    "context",
  );
  activity.accept(event("context_compaction_completed"));
  expect(activity.accept(event("provider_failed"))).toMatchObject({
    kind: "failed",
    moving: false,
  });
  expect(activity.accept(event("provider_request_started")).kind).toBe(
    "thinking",
  );
  activity.stop();
  expect(
    activity.accept(event("provider_text_delta", { text: "late" })),
  ).toMatchObject({ kind: "stopping", moving: false });
  expect(activity.reset().kind).toBe("thinking");
  expect(
    activity.accept(event("provider_text_delta", { text: "fresh" })).kind,
  ).toBe("answering");
});

test("request projection survives tab switches, resets between requests and never changes chat history", () => {
  const workspace = new TuiWorkspace("/project");
  try {
    const controller = workspace.newTab();
    controller.startRequest();
    controller.trackToolEvent(
      event("tool_started", { name: "write_file", invocationId: "write" }),
    );
    workspace.newTab();
    expect(controller.snapshot.requestActivity?.kind).toBe("editing");
    workspace.execution(controller).cancel();
    expect(controller.snapshot.requestActivity?.kind).toBe("stopping");
    controller.finishRequest("cancelled");
    expect(controller.snapshot.requestActivity).toBeUndefined();
    controller.startRequest();
    expect(controller.snapshot.requestActivity?.kind).toBe("thinking");
    controller.switchSession(undefined, "/other");
    expect(controller.snapshot.requestActivity).toBeUndefined();
    expect(controller.snapshot.transcript).toEqual([]);
  } finally {
    workspace.dispose();
  }
  const controller = new TuiController("/project");
  controller.trackToolEvent(event("provider_text_delta", { text: "late" }));
  expect(controller.snapshot.requestActivity).toBeUndefined();
  controller.dispose();
});
