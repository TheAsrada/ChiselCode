/** @jsxImportSource @opentui/react */
import { useState } from "react";
import type { OwnedUiContribution } from "../extensions/ui-types.js";
import type { Palette } from "./appearance.js";
import { DialogAction, OpenTuiDialog } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";

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
      maxWidth={72}
      maxHeight={Math.min(22, Math.max(8, items.length + 6))}
      palette={palette}
      onClose={onClose}
    >
      <text height={1} fg={palette.accent}>
        Состояние сервисов
      </text>
      <TerminalScrollbox
        minHeight={0}
        flexGrow={1}
        focused={false}
        viewportCulling
      >
        {!items.length && <text fg={palette.muted}>Сервисы не подключены</text>}
        {items.slice(0, 64).map((item) => (
          <DialogAction
            key={item.key}
            id={`ui-overflow-${item.key}`}
            active={item.key === items[index]?.key}
            tone={item.snapshot.tone}
            label={terminalLine(
              item.snapshot.label ?? item.descriptor.title,
              Math.min(66, width - 8),
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
