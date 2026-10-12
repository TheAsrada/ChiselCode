/** @jsxImportSource @opentui/react */
import { useState } from "react";
import stringWidth from "string-width";
import type { OwnedUiContribution } from "../extensions/ui-types.js";
import type { Palette } from "./appearance.js";
import { DialogAction, OpenTuiDialog } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";

export function compactUiStatuses(
  items: readonly OwnedUiContribution[],
  width: number,
) {
  const statuses = items.filter((item) => item.descriptor.slot === "status");
  const budget = width < 45 ? 0 : Math.floor(width * 0.45);
  const visible: { item: OwnedUiContribution; label: string }[] = [];
  let used = statuses.length > 3 ? 10 : 0;
  for (const item of statuses) {
    const label = terminalLine(
      item.snapshot.label ?? item.descriptor.title,
      23,
    );
    const cells = stringWidth(label) + 2;
    if (
      visible.length === 3 ||
      used + cells + (visible.length + 1 < statuses.length ? 10 : 0) > budget
    )
      break;
    visible.push({ item, label });
    used += cells;
  }
  const remaining = statuses.length - visible.length;
  return {
    visible,
    remaining: budget ? remaining : 0,
    reserved:
      visible.reduce((sum, item) => sum + stringWidth(item.label) + 2, 0) +
      (budget && remaining ? 10 : 0),
    statuses,
  };
}
export function OpenTuiStatusOverflow({
  items,
  width,
  height,
  palette,
  owner,
  onClose,
  onOpen,
}: {
  items: readonly OwnedUiContribution[];
  width: number;
  height: number;
  palette: Palette;
  owner: string;
  onClose(): void;
  onOpen(item: OwnedUiContribution): void;
}) {
  const [selected, setSelected] = useState(items[0]?.key);
  const index = Math.max(
    0,
    items.findIndex((item) => item.key === selected),
  );
  useUiKeyboard((key) => {
    if (capturedInputOwner(key) !== owner) return;
    if (key.ctrl && key.name === "c" && !key.shift) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.ctrl || key.meta || key.option) return;
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      onClose();
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      key.stopPropagation();
      setSelected(
        items[
          Math.max(
            0,
            Math.min(items.length - 1, index + (key.name === "up" ? -1 : 1)),
          )
        ]?.key,
      );
    } else if (
      (key.name === "return" || key.name === "enter") &&
      items[index]
    ) {
      key.preventDefault();
      key.stopPropagation();
      onOpen(items[index]!);
    }
  });
  return (
    <OpenTuiDialog
      id="ui-status-overflow"
      width={width}
      height={height}
      palette={palette}
      onClose={onClose}
    >
      <text height={1} fg={palette.accent}>
        Статусы возможностей
      </text>
      <TerminalScrollbox
        minHeight={0}
        flexGrow={1}
        focused={false}
        viewportCulling
      >
        {items.slice(0, 64).map((item) => (
          <DialogAction
            key={item.key}
            id={`ui-overflow-${item.key}`}
            active={item.key === items[index]?.key}
            tone={item.snapshot.tone}
            label={terminalLine(
              item.snapshot.label ?? item.descriptor.title,
              Math.min(96, width - 6),
            )}
            palette={palette}
            onSelect={() => onOpen(item)}
          />
        ))}
      </TerminalScrollbox>
      <DialogAction label="Назад" palette={palette} onSelect={onClose} />
    </OpenTuiDialog>
  );
}
