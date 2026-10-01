/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";
import {
  APPROVAL_MODE_DESCRIPTIONS,
  APPROVAL_MODE_LABELS,
  type ApprovalMode,
  availableApprovalModes,
} from "../security/approval-mode.js";
import type { Palette } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";

const summaries: Record<ApprovalMode, string> = {
  default: "Подтверждать правки и команды",
  acceptEdits: "Правки автоматически · команды с подтверждением",
  dontAsk: "Только чтение и заранее разрешённые действия",
  bypassPermissions: "Правки и команды без подтверждений",
};

export function OpenTuiPermissions({
  width,
  height,
  palette,
  mode,
  allowBypassPermissions,
  onSelect,
  onClose,
  onSettings,
}: {
  width: number;
  height: number;
  palette: Palette;
  mode: ApprovalMode;
  allowBypassPermissions: boolean;
  onSelect: (mode: ApprovalMode) => void;
  onClose: () => void;
  onSettings: () => void;
}) {
  const modes = availableApprovalModes(allowBypassPermissions);
  const [selected, setSelected] = useState(Math.max(0, modes.indexOf(mode)));
  const selectedRef = useRef(selected);
  const { popupHeight, innerWidth, roomy } = dialogLayout(width, height, 22);
  const choose = (index: number) => {
    const next = modes[index];
    if (next) onSelect(next);
  };
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return;
    if (key.name === "escape") {
      key.preventDefault();
      onClose();
    } else if (key.name === "up" || key.name === "down" || key.name === "f4") {
      key.preventDefault();
      selectedRef.current =
        (selectedRef.current + (key.name === "up" ? -1 : 1) + modes.length) %
        modes.length;
      setSelected(selectedRef.current);
    } else if (key.name === "return") {
      key.preventDefault();
      choose(selectedRef.current);
    } else if (key.name === "tab") {
      key.preventDefault();
      onSettings();
    }
  });
  return (
    <OpenTuiDialog
      id="permissions"
      width={width}
      height={height}
      maxHeight={22}
      palette={palette}
      onClose={onClose}
    >
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={palette.accent} height={1}>
          <strong>Разрешения</strong>
        </text>
        <DialogAction label="Esc ×" palette={palette} onSelect={onClose} />
      </box>
      {roomy && (
        <text fg={palette.muted} height={1}>
          Выбор для следующего запроса · Plan/Build сохраняется
        </text>
      )}
      <box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        marginTop={roomy ? 1 : 0}
      >
        {modes.map((item, index) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: Arrow keys and Enter select a permission mode.
          <box
            id={`permissions-mode-${item}`}
            key={item}
            flexDirection="column"
            height={popupHeight >= 14 ? 2 : 1}
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={
              index === selected ? palette.raised : palette.surface
            }
            onMouseUp={(event) => {
              event.stopPropagation();
              choose(index);
            }}
          >
            <text
              height={1}
              selectable={false}
              fg={
                item === "bypassPermissions"
                  ? palette.red
                  : index === selected
                    ? palette.accent
                    : palette.text
              }
            >
              {index === selected ? "› " : "  "}
              {APPROVAL_MODE_LABELS[item]}
              {item === mode ? "  ✓" : ""}
            </text>
            {popupHeight >= 14 && (
              <text height={1} fg={palette.muted} selectable={false}>
                {summaries[item]}
              </text>
            )}
          </box>
        ))}
        {popupHeight >= 14 && (
          <scrollbox flexGrow={1} minHeight={0} marginTop={1}>
            <text fg={palette.muted}>
              {APPROVAL_MODE_DESCRIPTIONS[modes[selected] ?? "default"]}
            </text>
            {!allowBypassPermissions && (
              <text fg={palette.muted}>
                Bypass доступен после включения в Settings → Разрешения.
              </text>
            )}
          </scrollbox>
        )}
      </box>
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text height={1} fg={palette.muted}>
          {innerWidth >= 45
            ? "↑↓ выбрать · Enter применить"
            : "↑↓ · Enter · Esc"}
        </text>
        <DialogAction
          id="permissions-settings"
          label="Tab Settings"
          palette={palette}
          onSelect={onSettings}
        />
      </box>
    </OpenTuiDialog>
  );
}
