import { expect, test } from "bun:test";
import { initializeSessionState } from "../../src/sessions/migrations.js";
import { createSession } from "../../src/sessions/store.js";
import { buildFileDiff } from "../../src/tools/file-diff.js";
import {
  actionFailed,
  actionTargets,
  activateActionTarget,
  groupToolActions,
  type ToolAction,
} from "../../src/ui/tool-actions.js";
import {
  replaySessionIntoTranscript,
  toolTranscriptHandlers,
} from "../../src/ui/tool-transcript.js";
import { TuiController } from "../../src/ui/tui-controller.js";

function snapshot(controller: TuiController) {
  return JSON.parse(
    JSON.stringify(
      groupToolActions(controller.snapshot.transcript).map((entry) =>
        entry.actionGroup
          ? {
              kind: entry.actionGroup.kind,
              id: entry.actionGroup.id,
              items: entry.actionGroup.items.map(
                ({ id, name, input, state, result }) => ({
                  id,
                  name,
                  input,
                  state,
                  result: result && {
                    output: result.output,
                    details: result.details,
                    artifact: result.artifact,
                    isError: result.isError,
                    errorCode: result.errorCode,
                  },
                }),
              ),
            }
          : { text: entry.text, diff: entry.fileDiff, card: entry.chatCard },
      ),
    ),
  );
}

test("parallel starts/results count once, preserve order and stay attached across message boundaries", () => {
  const view = new TuiController("/project");
  const tools = toolTranscriptHandlers(() => view);
  view.appendToLast("Изучу проект.");
  tools.onToolStart?.("read_file", { path: "a.ts" }, undefined, "a");
  tools.onToolStart?.("search_files", { pattern: "TODO" }, undefined, "b");
  const group = groupToolActions(view.snapshot.transcript)[1]?.actionGroup;
  expect(group?.items.map((item) => item.id)).toEqual(["a", "b"]);
  if (!group) throw new Error("Missing group");
  view.activateAction({ id: group.id, group });
  view.append("Промежуточное сообщение", "assistant");
  tools.onToolResult?.("search_files", { output: "Найдено 2" }, "b");
  tools.onToolResult?.("read_file", { output: "export const a = 1;" }, "a");
  expect(
    groupToolActions(view.snapshot.transcript)[1]?.actionGroup?.items.map(
      (item) => item.state,
    ),
  ).toEqual(["succeeded", "succeeded"]);
  expect(view.presentation.actions.expanded.has(group.id)).toBe(true);
  expect(view.snapshot.transcript.at(-1)?.text).toBe("Промежуточное сообщение");
  view.dispose();
});

test("live and JSON-restored conversations share grouping, skill metadata and failed results", () => {
  const view = new TuiController("/project");
  const tools = toolTranscriptHandlers(() => view);
  const session = createSession("/project", "fixture", "model");
  initializeSessionState(session);
  const calls = [
    { id: "read", name: "read_file", input: { path: "a.ts" } },
    { id: "unknown", name: "vendor.new_tool", input: { path: "b.ts" } },
    { id: "skill1", name: "load_skill", input: { name: "review" } },
    { id: "skill2", name: "load_skill", input: { name: "checks" } },
  ];
  const results = [
    { output: "Исходник" },
    {
      output: "Отказ доступа",
      isError: true,
      errorCode: "PERMISSION_DENIED" as const,
    },
    {
      output: "PRIVATE INSTRUCTIONS",
      details: {
        skill: { name: "review", description: "Проверка", source: "bundled" },
      },
    },
    {
      output: "Другие инструкции",
      details: {
        skill: { name: "checks", description: "Тесты", source: "user" },
      },
    },
  ];
  view.append("Задача", "user");
  session.messages.push({
    role: "user",
    content: [{ type: "text", text: "Задача" }],
  });
  for (const [at, chunk] of [calls.slice(0, 2), calls.slice(2)].entries()) {
    const text = at === 0 ? "Изучу." : "Загружу инструкции.";
    view.appendToLast(text);
    session.messages.push({
      role: "assistant",
      content: [
        { type: "text", text },
        ...chunk.map((call) => ({ type: "tool_use" as const, ...call })),
      ],
    });
    for (const call of chunk)
      tools.onToolStart?.(call.name, call.input, undefined, call.id);
    session.messages.push({
      role: "user",
      content: chunk.map((call) => {
        const result = results[calls.indexOf(call)];
        if (!result) throw new Error("Missing result");
        tools.onToolResult?.(call.name, result, call.id);
        if (session.runtime)
          session.runtime.invocations[call.id] = {
            ...call,
            fingerprint: call.id,
            state: result.isError ? "denied" : "succeeded",
            createdAt: "",
            updatedAt: "",
            result,
          };
        return {
          type: "tool_result" as const,
          toolUseId: call.id,
          content: result.output,
          isError: result.isError,
        };
      }),
    });
  }
  const restored = new TuiController("/project");
  replaySessionIntoTranscript(restored, JSON.parse(JSON.stringify(session)));
  expect(snapshot(restored)).toEqual(
    JSON.parse(JSON.stringify(snapshot(view))),
  );
  const rows = groupToolActions(restored.snapshot.transcript);
  expect(
    rows.flatMap((row) =>
      row.actionGroup?.kind === "actions" ? row.actionGroup.items : [],
    ),
  ).toHaveLength(2);
  expect(
    rows.flatMap((row) =>
      row.actionGroup?.kind === "skills" ? row.actionGroup.items : [],
    ),
  ).toHaveLength(2);
  expect(rows.some((row) => row.actionGroup?.items.some(actionFailed))).toBe(
    true,
  );
  expect(session.messages[1]?.content[1]?.type).toBe("tool_use");
  restored.dispose();
  view.dispose();
});

test("diffs and meaningful cards leave the group and form boundaries; unknown tools retain their result", () => {
  const view = new TuiController("/project");
  const tools = toolTranscriptHandlers(() => view);
  tools.onToolStart?.("read_file", { path: "a" }, undefined, "a");
  tools.onToolResult?.("read_file", { output: "a" }, "a");
  tools.onToolStart?.("write_file", { path: "new" }, undefined, "diff");
  tools.onToolResult?.(
    "write_file",
    { output: "new", fileDiff: buildFileDiff("new", null, "new") },
    "diff",
  );
  tools.onToolStart?.("vendor.unknown", {}, undefined, "unknown");
  tools.onToolResult?.(
    "vendor.unknown",
    { output: "Доступный результат" },
    "unknown",
  );
  tools.onToolStart?.("ext:vendor:report", {}, undefined, "report");
  tools.onToolResult?.(
    "ext:vendor:report",
    {
      output: "Отчёт",
      presentation: {
        extensionId: "vendor",
        view: { cards: [{ id: "report", revision: 1, title: "Отчёт" }] },
      },
    },
    "report",
  );
  const rows = groupToolActions(view.snapshot.transcript);
  expect(
    rows.map(
      (row) =>
        row.actionGroup?.items.map((item) => item.id) ??
        (row.fileDiff ? "diff" : "card"),
    ),
  ).toEqual([["a"], "diff", ["unknown"], "card"]);
  expect(rows[2]?.actionGroup?.items[0]?.result?.output).toBe(
    "Доступный результат",
  );
  view.dispose();
});

test("large groups mount by pages, stable expansion belongs to each conversation, cancellation is explicit", async () => {
  const view = new TuiController("/project");
  view.startRequest();
  for (let index = 0; index < 1200; index++)
    view.upsertToolAction({
      id: `call-${index}`,
      name: "read_file",
      result: { output: `Результат ${index}` },
    });
  view.upsertToolAction({ id: "pending", name: "run_shell" });
  view.finishRequest("cancelled");
  const rows = groupToolActions(view.snapshot.transcript);
  const group = rows[0]?.actionGroup;
  expect(group?.items).toHaveLength(1201);
  expect(group?.items.at(-1)?.state).toBe("cancelled");
  expect(actionTargets(rows, view.presentation.actions)).toHaveLength(1);
  if (!group) throw new Error("Missing group");
  view.activateAction({ id: group.id, group });
  expect(
    actionTargets(rows, view.presentation.actions).filter(
      (target) => target.action,
    ),
  ).toHaveLength(40);
  view.activateAction({ id: `action-more:${group.id}`, group, more: true });
  expect(
    actionTargets(rows, view.presentation.actions).filter(
      (target) => target.action,
    ),
  ).toHaveLength(80);
  view.switchSession(undefined, "/other");
  expect(view.presentation.actions.expanded.size).toBe(0);
  view.dispose();
});

test("full result pagination does no model work and late reads cannot update a closed conversation", async () => {
  const action: ToolAction = {
    id: "a",
    name: "run_shell",
    input: {},
    state: "failed",
    result: {
      output: "Краткий результат",
      isError: true,
      artifact: {
        uri: "tool-result://00000000-0000-0000-0000-000000000000",
        tokens: 10000,
      },
    },
  };
  const view = new TuiController("/project");
  let complete: ((text: string) => void) | undefined;
  const abort = new AbortController();
  const state = view.presentation.actions;
  const read = activateActionTarget(
    state,
    { id: "action-output:a", action },
    () => {},
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    abort.signal,
  );
  expect(state.pages.get("a")?.loading).toBe(true);
  abort.abort();
  complete?.("Чужой поздний результат");
  await read;
  expect(state.pages.get("a")?.text).not.toContain("Чужой");
  view.dispose();
});

test("skill failures remain separate and expansion is isolated between conversations", () => {
  const first = new TuiController("/project");
  const second = new TuiController("/project");
  first.upsertToolAction({
    id: "skill",
    name: "load_skill",
    input: { name: "missing" },
    result: { output: "Навык недоступен", isError: true },
  });
  first.upsertToolAction({
    id: "read",
    name: "read_file",
    result: { output: "Файл" },
  });
  second.upsertToolAction({
    id: "skill",
    name: "load_skill",
    result: { output: "Инструкции" },
  });
  const group = groupToolActions(first.snapshot.transcript)[0]?.actionGroup;
  expect(group?.kind).toBe("skills");
  expect(group?.items[0]?.state).toBe("failed");
  if (!group) throw new Error("Missing group");
  first.activateAction({ id: group.id, group });
  expect(first.presentation.actions.expanded.has(group.id)).toBe(true);
  expect(second.presentation.actions.expanded.has(group.id)).toBe(false);
  expect(
    groupToolActions(first.snapshot.transcript)[1]?.actionGroup?.items,
  ).toHaveLength(1);
  first.dispose();
  second.dispose();
});

test("parallel standalone calls and pending approval keep grouping boundaries", () => {
  const view = new TuiController("/project");
  const tools = toolTranscriptHandlers(() => view);
  tools.onToolStart?.("read_file", { path: "a" }, undefined, "a");
  tools.onToolStart?.("write_file", { path: "new" }, undefined, "diff");
  tools.onToolStart?.("vendor.report", {}, undefined, "report");
  tools.onToolStart?.("read_file", { path: "b" }, undefined, "b");
  tools.onToolResult?.(
    "vendor.report",
    {
      output: "Отчёт",
      presentation: {
        extensionId: "vendor",
        view: {
          cards: [{ id: "parallel-report", revision: 1, title: "Отчёт" }],
        },
      },
    },
    "report",
  );
  tools.onToolResult?.(
    "write_file",
    { output: "new", fileDiff: buildFileDiff("new", null, "new") },
    "diff",
  );
  tools.onToolResult?.("read_file", { output: "b" }, "b");
  tools.onToolResult?.("read_file", { output: "a" }, "a");
  expect(
    groupToolActions(view.snapshot.transcript).flatMap((row) =>
      row.actionGroup ? [row.actionGroup.items.map((item) => item.id)] : [],
    ),
  ).toEqual([["a"], ["b"]]);
  view.upsertToolAction({
    id: "approval",
    name: "run_shell",
    input: { command: "deploy" },
    state: "awaiting_approval",
  });
  const pending = groupToolActions(view.snapshot.transcript).at(-1);
  expect(pending?.actionGroup).toBeUndefined();
  expect(pending?.text).toBe("Ожидает ответа · run_shell · deploy");
  view.dispose();
});
