import type { AgentEventHandlers } from "../core/agent-loop.js";
import { stripActiveSkillsBlock } from "../skills/skills.js";
import type { Session, ToolExecutionResult } from "../types/domain.js";
import { fileDiffStats, fileDiffTitle } from "./file-diff.js";
import { formatToolSummary } from "./theme.js";
import type { TuiTranscript } from "./tui.js";

const fileTools = new Set(["edit_file", "write_file", "delete_file"]);

export function appendToolResult(
  view: TuiTranscript,
  name: string,
  result: ToolExecutionResult,
): void {
  if (result.isError || result.requiresApproval) {
    view.append(`✗ ${name}: ${result.output}`, "error");
  } else if (result.fileDiff) {
    const diff = result.fileDiff;
    view.append(
      `${fileDiffTitle(diff)} · ${fileDiffStats(diff)}`,
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
      `… показаны последние ${tail.length} из ${session.messages.length} сообщений сессии.`,
      "info",
    );
  const names = new Map(
    session.messages.flatMap((message) =>
      message.content.flatMap((block) =>
        block.type === "tool_use" ? [[block.id, block.name] as const] : [],
      ),
    ),
  );
  for (const message of tail) {
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
        });
      }
    }
  }
  view.replace?.(entries);
}
