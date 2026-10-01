import type { AgentEventHandlers } from "../core/agent-loop.js";
import { stripActiveSkillsBlock } from "../skills/skills.js";
import type { Session, ToolExecutionResult } from "../types/domain.js";
import { fileDiffStats, fileDiffTitle } from "./file-diff-model.js";
import { requestCompletion } from "./request-timing.js";
import { FAIL_MARK, formatToolSummary } from "./theme.js";
import type { TuiTranscript } from "./tui-contract.js";

const fileTools = new Set([
  "edit_file",
  "write_file",
  "delete_file",
  "apply_patch",
]);

export function appendToolResult(
  view: TuiTranscript,
  name: string,
  result: ToolExecutionResult,
): void {
  if (result.isError || result.requiresApproval) {
    view.append(`${FAIL_MARK} ${name}: ${result.output}`, "error");
  } else if (result.diffs?.length || result.fileDiff) {
    for (const diff of result.diffs ??
      (result.fileDiff ? [result.fileDiff] : []))
      view.append(
        `${fileDiffTitle(diff)} | ${fileDiffStats(diff)}`,
        "tool",
        diff,
      );
  } else if (fileTools.has(name)) {
    view.append(result.output, "info");
  }
}

/** File operations have one temporary activity row, replaced by their result. */
export function toolTranscriptHandlers(
  getView: () => TuiTranscript | undefined,
): AgentEventHandlers {
  return {
    onToolStart: (name, input) => {
      const view = getView();
      if (fileTools.has(name))
        view?.setToolActivity(`[chisel] ${name} ${String(input.path ?? "")}`);
      else view?.append(`[chisel] ${formatToolSummary(name, input)}`, "tool");
    },
    onToolResult: (name, result) => {
      const view = getView();
      if (!view) return;
      if (fileTools.has(name)) view.setToolActivity();
      appendToolResult(view, name, result);
    },
  };
}

const REPLAY_MESSAGE_LIMIT = 30;
/** Session UI metadata stays outside ChatMessage/provider protocol. */
export function replaySessionIntoTranscript(
  view: TuiTranscript,
  session: Session,
): void {
  const entries: Parameters<NonNullable<TuiTranscript["replace"]>>[0] = [];
  const collector: TuiTranscript = {
    append: (text, tone, fileDiff) => {
      entries.push({ text, tone, fileDiff });
    },
    appendToLast: () => {},
    setToolActivity: () => {},
    clear: () => {},
  };
  const target = view.replace ? collector : view;
  const tail = view.replace
    ? session.messages
    : session.messages.slice(-REPLAY_MESSAGE_LIMIT);
  if (session.messages.length > tail.length)
    target.append(
      `... показаны последние ${tail.length} из ${session.messages.length} сообщений сессии.`,
      "info",
    );
  const names = new Map(
    session.messages.flatMap((message) =>
      message.content.flatMap((block) =>
        block.type === "tool_use" ? [[block.id, block.name] as const] : [],
      ),
    ),
  );
  const timings = new Map<number, NonNullable<Session["requestTimings"]>>();
  for (const timing of session.requestTimings ?? []) {
    const group = timings.get(timing.afterMessage) ?? [];
    group.push(timing);
    timings.set(timing.afterMessage, group);
  }
  const appendTimings = (afterMessage: number) => {
    for (const timing of timings.get(afterMessage) ?? [])
      target.append(requestCompletion(timing.status, timing.elapsedMs), "dim");
  };
  const start = session.messages.length - tail.length;
  if (start === 0) appendTimings(0);
  for (const [index, message] of tail.entries()) {
    for (const block of message.content) {
      if (block.type === "text") {
        const text =
          message.role === "user"
            ? stripActiveSkillsBlock(block.text).trim()
            : block.text.trim();
        if (text)
          target.append(text, message.role === "user" ? "user" : "assistant");
      } else if (block.type === "tool_use") {
        if (!session.fileDiffs?.[block.id])
          target.append(
            `[chisel] ${formatToolSummary(block.name, block.input)}`,
            "tool",
          );
      } else {
        appendToolResult(target, names.get(block.toolUseId) ?? "tool", {
          output: block.content,
          isError: block.isError,
          fileDiff: session.fileDiffs?.[block.toolUseId],
          diffs:
            session.runtime?.invocations[block.toolUseId]?.result?.diffs ??
            Object.entries(session.fileDiffs ?? {})
              .filter(
                ([key]) =>
                  key === block.toolUseId ||
                  key.startsWith(`${block.toolUseId}:`),
              )
              .map(([, diff]) => diff),
        });
      }
    }
    appendTimings(start + index + 1);
  }
  view.replace?.(entries);
}
