/** @jsxImportSource @opentui/react */
import React from "react";
import type { ChatCard as CardData } from "../types/chat-presentation.js";
import { type Palette, THEMES } from "./appearance.js";
import { diffViewForWidth } from "./file-diff-preview.js";
import { ChatCard } from "./opentui-chat-card.js";
import { ContextCompactionMessage } from "./opentui-compaction.js";
import { UiSurface } from "./opentui-composition.js";
import { FileDiffCard } from "./opentui-file-diff.js";
import { FormattedMessage } from "./opentui-message.js";
import { ToolActions } from "./opentui-tool-actions.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";
import {
  type ActionPresentation,
  type ActionTarget,
  activateActionTarget,
  createActionPresentation,
  groupToolActions,
} from "./tool-actions.js";
import type { TranscriptEntry } from "./tui-controller.js";

export { terminalSafeText } from "./terminal-text.js";

export const TRANSCRIPT_WINDOW = 240;

export function visibleTranscriptWindow<T extends TranscriptEntry>(
  entries: readonly T[],
  requestedEnd?: number,
) {
  const end = Math.max(
    0,
    Math.min(entries.length, requestedEnd ?? entries.length),
  );
  const start = Math.max(0, end - TRANSCRIPT_WINDOW);
  return { start, end, entries: entries.slice(start, end) };
}

export { FormattedMessage } from "./opentui-message.js";
export { diffViewForWidth };

export function OpenTuiTranscript({
  entries,
  onOpenSide,
  onOpenCard,
  onCardAction,
  focusedSideId,
  contentWidth,
  expandedId,
  expandedIds,
  onToggleDiff,
  windowEnd,
  palette = THEMES.obsidian,
  actionPresentation,
  onActionSelect,
  focusedActionId,
}: {
  entries: readonly TranscriptEntry[];
  onOpenSide?(operationId: string): void;
  onCardAction?(
    action: NonNullable<CardData["actions"]>[number],
    extensionId?: string,
  ): void;
  onOpenCard?(
    target: NonNullable<CardData["target"]>,
    extensionId?: string,
  ): void;
  focusedSideId?: string;
  contentWidth: number;
  expandedId?: number;
  expandedIds?: ReadonlySet<number>;
  onToggleDiff?: (id: number) => void;
  windowEnd?: number;
  palette?: Palette;
  actionPresentation?: ActionPresentation;
  onActionSelect?(target: ActionTarget): void;
  focusedActionId?: string;
}) {
  const fallback = React.useRef(createActionPresentation());
  const [, refresh] = React.useState(0);
  const actions = actionPresentation ?? fallback.current;
  const rows = React.useMemo(() => groupToolActions(entries), [entries]);
  const visible = visibleTranscriptWindow(rows, windowEnd);
  let latestDiffId: number | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.fileDiff) {
      latestDiffId = entries[index]?.id;
      break;
    }
  }
  return (
    <React.Fragment>
      {visible.start > 0 && (
        <text fg={palette.muted}>
          Up Ещё {visible.start} сообщений | PgUp / колесо
        </text>
      )}
      {visible.entries.map((entry) => {
        const renderEntry = () => {
          if (entry.actionGroup)
            return (
              <ToolActions
                key={entry.actionGroup.id}
                group={entry.actionGroup}
                state={actions}
                width={contentWidth}
                palette={palette}
                focusedId={focusedActionId}
                onCardAction={onCardAction}
                onSelect={(target) =>
                  onActionSelect
                    ? onActionSelect(target)
                    : void activateActionTarget(actions, target, () =>
                        refresh((value) => value + 1),
                      )
                }
              />
            );
          if (entry.chatCard)
            return (
              <ChatCard
                key={entry.id}
                card={entry.chatCard.card}
                extensionId={entry.chatCard.extensionId}
                width={contentWidth}
                palette={palette}
                onOpen={(target) =>
                  onOpenCard?.(target, entry.chatCard!.extensionId)
                }
                onAction={(action) =>
                  onCardAction?.(action, entry.chatCard!.extensionId)
                }
              />
            );
          const sideId = entry.sideOperationId;
          if (sideId)
            return (
              <box
                key={entry.id}
                flexDirection={contentWidth < 40 ? "column" : "row"}
                width="100%"
              >
                <text
                  fg={palette.muted}
                  height={1}
                  width={Math.max(
                    1,
                    contentWidth - (contentWidth < 40 ? 0 : 15),
                  )}
                >
                  {terminalLine(
                    entry.text,
                    Math.max(1, contentWidth - (contentWidth < 40 ? 0 : 15)),
                  )}
                </text>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: Tab focuses this record; Enter or F6 opens the view. */}
                <text
                  id={`side-open-${entry.id}`}
                  fg={palette.accent}
                  bg={focusedSideId === sideId ? palette.raised : undefined}
                  onMouseUp={(event) => {
                    event.stopPropagation();
                    onOpenSide?.(sideId);
                  }}
                >
                  {focusedSideId === sideId
                    ? "> Открыть Enter"
                    : " Открыть · F6"}
                </text>
              </box>
            );
          const diff = entry.fileDiff;
          if (!diff && entry.tone === "context")
            return (
              <ContextCompactionMessage
                key={entry.id}
                text={entry.text}
                palette={palette}
              />
            );
          if (!diff && entry.tone === "assistant")
            return (
              <FormattedMessage
                key={entry.id}
                id={`assistant-${entry.id}`}
                content={entry.text}
                palette={palette}
                width={contentWidth}
              />
            );
          if (!diff && entry.tone === "user")
            return (
              <box
                key={entry.id}
                width="100%"
                backgroundColor={palette.surface}
                paddingLeft={1}
                paddingRight={1}
                marginTop={1}
              >
                <text fg={palette.accent}>
                  {">"}{" "}
                  <span fg={palette.text}>
                    {terminalSafeText(
                      entry.text.replace(/^[>\u276f]\s*/, ""),
                      20_000,
                    )}
                  </span>
                </text>
              </box>
            );
          if (!diff && entry.tone === "tool")
            return (
              <text key={entry.id} fg={palette.muted}>
                {" "}
                •{" "}
                {terminalSafeText(
                  entry.text.replace(/^\[chisel\]\s*/, ""),
                  20_000,
                )}
              </text>
            );
          if (!diff && entry.tone === "dim")
            return (
              <box key={entry.id} width="100%" paddingLeft={1}>
                <text fg={palette.muted} selectable>
                  {terminalSafeText(entry.text, 20_000)}
                </text>
              </box>
            );
          if (!diff)
            return (
              <text
                key={entry.id}
                fg={
                  entry.tone === "error"
                    ? palette.red
                    : entry.tone === "warn"
                      ? palette.yellow
                      : entry.tone === "success"
                        ? palette.green
                        : palette.muted
                }
                selectable
              >
                {terminalSafeText(entry.text, 20_000)}
              </text>
            );
          return (
            <FileDiffCard
              key={entry.id}
              id={`file-diff-${entry.id}`}
              diff={diff}
              width={contentWidth}
              expanded={expandedIds?.has(entry.id) || expandedId === entry.id}
              latest={entry.id === latestDiffId}
              onToggle={onToggleDiff ? () => onToggleDiff(entry.id) : undefined}
              palette={palette}
            />
          );
        };
        const name = entry.actionGroup
          ? entry.actionGroup.kind === "skills"
            ? "Skills"
            : "ToolActions"
          : entry.chatCard
            ? "ChatCard"
            : entry.fileDiff
              ? "FileDiff"
              : entry.tone === "assistant"
                ? "AssistantMessage"
                : entry.tone === "user"
                  ? "UserMessage"
                  : entry.tone === "context"
                    ? "Compaction"
                    : entry.tone === "tool"
                      ? "CommandOutput"
                      : "SystemMessage";
        const problem =
          entry.tone === "error" ||
          entry.actionGroup?.items.some((action) =>
            ["failed", "denied", "cancelled", "interrupted"].includes(
              action.state,
            ),
          );
        return (
          <UiSurface
            key={entry.actionGroup?.id ?? entry.id}
            name={name}
            values={{
              text: entry.text,
              state: entry.tone,
              count: entry.actionGroup?.items.length ?? 1,
              path: entry.fileDiff?.path,
            }}
            preserveNative={!!problem}
          >
            {renderEntry()}
          </UiSurface>
        );
      })}
      {visible.end < rows.length && (
        <text fg={palette.muted}>
          Down Ещё {rows.length - visible.end} сообщений | PgDn / колесо
        </text>
      )}
    </React.Fragment>
  );
}
