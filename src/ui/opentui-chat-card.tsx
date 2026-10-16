/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import stringWidth from "string-width";
import type { ChatCard as CardData } from "../types/chat-presentation.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";

import { terminalLine } from "./terminal-text.js";

export function ChatCard({
  card,
  extensionId,
  width,
  palette,
  onOpen,
  onAction,
}: {
  card: CardData;
  extensionId: string;
  width: number;
  palette: Palette;
  onAction?(action: NonNullable<CardData["actions"]>[number]): void;
  onOpen?(target: NonNullable<CardData["target"]>): void;
}) {
  const inner = Math.max(1, width - 4);
  const narrow = inner < 48;
  const status = card.status;
  const colors = {
    muted: palette.muted,
    accent: palette.accent,
    success: palette.green,
    warning: palette.yellow,
    error: palette.red,
  };
  const color = status ? colors[status.tone] : palette.accent;
  const marker = status?.tone === "success" ? "✓" : "●";
  const statusWidth = status
    ? Math.min(inner, stringWidth(status.label) + 4)
    : 0;
  const openWidth = onOpen && card.target && inner >= 12 ? 9 : 0;
  const identity = JSON.stringify([extensionId, card.id]);
  return (
    <box
      id={`chat-card-${identity}`}
      width="100%"
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={palette.border}
      backgroundColor={palette.surface}
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
    >
      <box width="100%" flexDirection={narrow ? "column" : "row"}>
        <text
          height={1}
          width={narrow ? inner : Math.max(1, inner - statusWidth)}
          fg={palette.text}
          attributes={TextAttributes.BOLD}
        >
          {terminalLine(
            card.title,
            narrow ? inner : Math.max(1, inner - statusWidth),
          )}
        </text>
        {status && (
          <text height={1} width={statusWidth} fg={color} bg={palette.raised}>
            {terminalLine(` ${marker} ${status.label} `, statusWidth)}
          </text>
        )}
      </box>
      {card.subtitle && (
        <text height={1} fg={palette.muted}>
          {terminalLine(card.subtitle, inner)}
        </text>
      )}
      {card.description && (
        <text height={1} fg={palette.text}>
          {terminalLine(card.description, inner)}
        </text>
      )}
      {(card.detail || openWidth > 0) && (
        <box width="100%" flexDirection="row">
          <text height={1} width={Math.max(1, inner - openWidth)} fg={color}>
            {terminalLine(card.detail ?? "", Math.max(1, inner - openWidth))}
          </text>
          {openWidth > 0 && card.target && (
            <DialogAction
              id={`chat-card-open-${identity}`}
              label="Открыть"
              active
              palette={palette}
              onSelect={() => {
                if (card.target) onOpen?.(card.target);
              }}
            />
          )}
        </box>
      )}
      {card.actions?.length && onAction ? (
        <box flexDirection="row" width="100%" flexShrink={0}>
          {card.actions.map((action) => (
            <DialogAction
              key={action.action}
              id={`chat-card-${action.action}-${identity}`}
              label={action.label}
              palette={palette}
              onSelect={() => onAction(action)}
            />
          ))}
        </box>
      ) : undefined}
    </box>
  );
}
