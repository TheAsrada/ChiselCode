import type { AgentEventHandlers } from "../core/agent-loop.js";
import { stripActiveSkillsBlock } from "../skills/skills.js";
import type { ChatPresentationPort } from "../types/chat-presentation.js";
import type { Session, ToolExecutionResult } from "../types/domain.js";
import {
  appendChatPresentation,
  chatCardText,
  resultChatPresentation,
  toolChatLabel,
} from "./chat-presentation.js";
import { compactionNotice } from "./context-compaction.js";
import { extensionResultLabel, extensionToolLabel } from "./extension-tool.js";
import { fileDiffStats, fileDiffTitle } from "./file-diff-model.js";
import { requestCompletion } from "./request-timing.js";
import { FAIL_MARK, formatToolSummary } from "./theme.js";
import {
  actionIsSeparate,
  actionLabel,
  mergeToolAction,
  type ToolAction,
} from "./tool-actions.js";
import type { TuiTranscript } from "./tui-contract.js";
import { webResultSummary } from "./web-result.js";

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
  const extension = extensionResultLabel(result);
  const presentation = resultChatPresentation(result);
  if (result.errorCode === "BACKGROUND_RESOURCE_BUSY" && presentation) {
    appendChatPresentation(view, presentation);
  } else if (result.isError || result.requiresApproval) {
    view.append(`${FAIL_MARK} ${extension ?? name}: ${result.output}`, "error");
  } else if (result.diffs?.length || result.fileDiff) {
    if (presentation) appendChatPresentation(view, presentation);
    if (extension) view.append(extension, "tool");
    for (const diff of result.diffs ??
      (result.fileDiff ? [result.fileDiff] : []))
      view.append(
        `${fileDiffTitle(diff)} | ${fileDiffStats(diff)}`,
        "tool",
        diff,
      );
  } else if (presentation) {
    appendChatPresentation(view, presentation);
  } else if (fileTools.has(name)) {
    view.append(result.output, "info");
  } else if (extension) {
    view.append(
      `${extension}${result.artifact ? " · полный результат сохранён" : " · готово"}`,
      "tool",
    );
  } else if (webResultSummary(result)) {
    view.append(webResultSummary(result) ?? "Web", "tool");
  } else if (result.details?.mcp) {
    const display = result.details.mcp as { server: string; tool: string };
    view.append(
      `[mcp] ${display.server} · ${display.tool}${result.artifact ? " · полный результат сохранён" : " · готово"}`,
      "tool",
    );
  }
}

/** File operations have one temporary activity row, replaced by their result. */
export function toolTranscriptHandlers(
  getView: () => TuiTranscript | undefined,
): AgentEventHandlers {
  return {
    onToolStart: (name, input, source, invocationId) => {
      const view = getView();
      if (
        invocationId &&
        view?.upsertToolAction?.({
          id: invocationId,
          name,
          input,
          source,
          state: "running",
        })
      )
        return;
      const label = toolChatLabel(source, input);
      if (label) view?.setToolActivity(label);
      else if (extensionToolLabel(source))
        view?.setToolActivity(extensionToolLabel(source));
      else if (source?.type === "mcp")
        view?.setToolActivity(
          `[mcp] ${source.serverTitle} · ${source.title ?? source.originalName}`,
        );
      else if (
        source?.type === "web" ||
        name === "web_search" ||
        name === "web_fetch"
      )
        view?.setToolActivity(formatToolSummary(name, input));
      else if (fileTools.has(name))
        view?.setToolActivity(`[chisel] ${name} ${String(input.path ?? "")}`);
      else view?.append(`[chisel] ${formatToolSummary(name, input)}`, "tool");
    },
    onToolResult: (name, result, invocationId) => {
      const view = getView();
      if (!view) return;
      view.setToolActivity();
      if (
        invocationId &&
        view.upsertToolAction?.({ id: invocationId, name, result })
      )
        return;
      appendToolResult(view, name, result);
    },
  };
}

const REPLAY_MESSAGE_LIMIT = 30;
/** Session UI metadata stays outside ChatMessage/provider protocol. */
export function replaySessionIntoTranscript(
  view: TuiTranscript,
  session: Session,
  chat?: ChatPresentationPort,
): void {
  const entries: Parameters<NonNullable<TuiTranscript["replace"]>>[0] = [];
  const collector: TuiTranscript = {
    upsertToolAction: (update) => {
      const index = entries.findIndex(
        (entry) =>
          entry.toolAction?.id === update.id ||
          entry.toolBoundary === update.id,
      );
      if (actionIsSeparate(update.name, update.result)) {
        const boundary = { text: "", toolBoundary: update.id };
        if (index >= 0) entries[index] = boundary;
        else entries.push(boundary);
        return false;
      }
      const toolAction = mergeToolAction(entries[index]?.toolAction, update);
      const entry = {
        text: actionLabel(toolAction),
        tone: "tool" as const,
        toolAction,
      };
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
      return true;
    },
    append: (text, tone, fileDiff) => {
      entries.push({ text, tone, fileDiff });
    },
    upsertCard: (extensionId, card) => {
      const index = entries.findIndex(
        (entry) =>
          entry.chatCard?.extensionId === extensionId &&
          entry.chatCard.card.id === card.id,
      );
      const prior = entries[index];
      if (prior?.chatCard && prior.chatCard.card.revision >= card.revision)
        return;
      const entry = {
        text: chatCardText(card),
        tone: "tool" as const,
        chatCard: structuredClone({ extensionId, card }),
      };
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
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
  const children = Object.values(session.children ?? {});
  const childrenByInvocation = new Map(
    children.map((receipt) => [receipt.child.invocationId, receipt]),
  );
  const timings = new Map<number, NonNullable<Session["requestTimings"]>>();
  for (const timing of session.requestTimings ?? []) {
    const group = timings.get(timing.afterMessage) ?? [];
    group.push(timing);
    timings.set(timing.afterMessage, group);
  }
  const presentations = new Map<
    number,
    NonNullable<Session["chatPresentations"]>
  >();
  const savedPresentations = [
    ...(session.chatPresentations ?? []),
    ...Object.values(session.backgroundTasks ?? {}).flatMap((receipt) =>
      receipt.presentation
        ? [
            {
              afterMessage: receipt.afterMessage,
              presentation: receipt.presentation,
            },
          ]
        : [],
    ),
  ];
  for (const record of savedPresentations) {
    const group = presentations.get(record.afterMessage) ?? [];
    group.push(record);
    presentations.set(record.afterMessage, group);
  }
  const appendTimings = (afterMessage: number) => {
    for (const record of presentations.get(afterMessage) ?? [])
      appendChatPresentation(target, record.presentation);
    for (const record of compactions.get(afterMessage) ?? [])
      target.append(compactionNotice(record), "context");
    for (const timing of timings.get(afterMessage) ?? [])
      target.append(requestCompletion(timing.status, timing.elapsedMs), "dim");
  };
  const compactions = new Map<
    number,
    NonNullable<Session["context"]>["compactions"]
  >();
  const seenCompactions = new Set<string>();
  for (const record of session.context?.compactions ?? []) {
    if (seenCompactions.has(record.id)) continue;
    seenCompactions.add(record.id);
    const group = compactions.get(record.afterMessage) ?? [];
    group.push(record);
    compactions.set(record.afterMessage, group);
  }
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
        const legacy = /^ext:(.+):([^:]+)$/.exec(block.name);
        const invocation = session.runtime?.invocations[block.id];
        const source =
          invocation?.toolSource ??
          (legacy
            ? {
                type: "extension" as const,
                extensionId: legacy[1] ?? "",
                originalName: legacy[2] ?? "",
              }
            : undefined);
        const child = childrenByInvocation.get(block.id);
        const presentation =
          child?.presentation ??
          (child
            ? chat?.render(child.child.extensionId, "task", {
                child: child.child,
              })
            : undefined);
        if (presentation) {
          appendChatPresentation(target, presentation);
          continue;
        }
        if (
          source?.type === "mcp" ||
          source?.type === "web" ||
          source?.type === "extension"
        )
          if (!target.upsertToolAction) continue;
        if (
          target.upsertToolAction?.({
            id: block.id,
            name: block.name,
            input: block.input,
            source,
            state:
              invocation &&
              ["succeeded", "failed", "denied", "cancelled"].includes(
                invocation.state,
              )
                ? invocation.state
                : "interrupted",
          })
        )
          continue;
        if (!session.fileDiffs?.[block.id])
          target.append(
            `[chisel] ${formatToolSummary(block.name, block.input)}`,
            "tool",
          );
      } else {
        const name = names.get(block.toolUseId) ?? "tool";
        const saved = session.runtime?.invocations[block.toolUseId];
        const legacy = /^ext:(.+):([^:]+)$/.exec(name);
        const source =
          saved?.toolSource ??
          (legacy
            ? {
                type: "extension" as const,
                extensionId: legacy[1] ?? "",
                originalName: legacy[2] ?? "",
              }
            : undefined);
        const result = {
          ...saved?.result,
          output: block.content,
          isError: block.isError,
          details:
            saved?.result?.details ??
            (source?.type === "extension"
              ? {
                  extension: {
                    id: source.extensionId,
                    tool: source.originalName,
                    ...(source.chat ? { chat: source.chat } : {}),
                  },
                }
              : undefined),
          artifact:
            session.runtime?.invocations[block.toolUseId]?.result?.artifact,
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
        };
        const presentation =
          saved?.result?.presentation ??
          (source?.type === "extension"
            ? chat?.render(
                source.extensionId,
                source.chat?.view ?? source.originalName,
                result,
              )
            : undefined);
        const restoredResult = {
          ...result,
          ...(presentation ? { presentation } : {}),
        };
        if (
          !target.upsertToolAction?.({
            id: block.toolUseId,
            name,
            result: restoredResult,
          })
        )
          appendToolResult(target, name, restoredResult);
      }
    }
    appendTimings(start + index + 1);
  }
  for (const receipt of children) {
    const presentation =
      receipt.presentation ??
      chat?.render(receipt.child.extensionId, "task", { child: receipt.child });
    if (presentation) appendChatPresentation(target, presentation);
  }
  view.replace?.(entries);
}
