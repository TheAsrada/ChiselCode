import type { ToolSource } from "../tools/types.js";
import {
  type ChatCard,
  ChatStyleSchema,
  type OwnedChatPresentation,
  OwnedChatPresentationSchema,
} from "../types/chat-presentation.js";
import type { ToolExecutionResult } from "../types/domain.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";
import type { TuiTranscript } from "./tui-contract.js";

export function chatCardText(card: ChatCard): string {
  return terminalSafeText(
    [
      card.title + (card.status ? ` · ${card.status.label}` : ""),
      card.subtitle,
      card.description,
      card.detail,
    ]
      .filter(Boolean)
      .join("\n"),
    20_000,
  );
}
export function appendChatPresentation(
  view: TuiTranscript,
  presentation: OwnedChatPresentation,
): void {
  for (const card of presentation.view.cards ?? []) {
    if (view.upsertCard) view.upsertCard(presentation.extensionId, card);
    else view.append(chatCardText(card), "tool");
  }
  if (presentation.view.summary) view.append(presentation.view.summary, "tool");
}
export function resultChatPresentation(
  result: ToolExecutionResult,
): OwnedChatPresentation | undefined {
  const parsed = OwnedChatPresentationSchema.safeParse(result.presentation);
  return parsed.success ? parsed.data : undefined;
}
export function toolChatLabel(
  source?: ToolSource,
  input?: Record<string, unknown>,
): string | undefined {
  if (source?.type !== "extension" || !source.chat) return undefined;
  const parsed = ChatStyleSchema.safeParse(source.chat);
  if (!parsed.success) return undefined;
  const style = parsed.data;
  const label = style.inputField ? input?.[style.inputField] : undefined;
  return terminalLine(
    style.title + (typeof label === "string" ? ` · «${label}»` : ""),
    500,
  );
}
export function extensionCommandLabel(command: {
  name: string;
  chat?: { title: string };
  source: { extensionId: string };
}): string {
  return terminalLine(
    command.chat?.title ?? `/${command.name} · ${command.source.extensionId}`,
    500,
  );
}

export function extensionResultFeedback(
  title: string,
  result: ToolExecutionResult,
): import("./tui-controller.js").ExtensionFeedback {
  const failed = result.isError || result.requiresApproval;
  const presentation = failed ? undefined : resultChatPresentation(result);
  const message = presentation
    ? [
        ...(presentation.view.cards ?? []).map(chatCardText),
        presentation.view.summary,
      ]
        .filter(Boolean)
        .join("\n\n")
    : result.output;
  return {
    title,
    message: terminalSafeText(message, 20_000) || undefined,
    tone: failed ? "error" : "info",
  };
}

export function extensionResultActions(
  result: ToolExecutionResult,
): import("./tui-controller.js").CommandFeedbackAction[] | undefined {
  if (result.isError || result.requiresApproval) return;
  const presentation = resultChatPresentation(result);
  return presentation?.view.cards?.flatMap((card) =>
    [
      ...(card.target
        ? [{ label: "Открыть", action: "open" as const, target: card.target }]
        : []),
      ...(card.actions ?? []),
    ].map((action) => ({ extensionId: presentation.extensionId, action })),
  );
}
