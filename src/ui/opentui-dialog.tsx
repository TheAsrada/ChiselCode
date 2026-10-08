/** @jsxImportSource @opentui/react */
import { RGBA } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { type ReactNode, useRef } from "react";
import { type Palette, THEMES } from "./appearance.js";
import { useTerminalDecoration } from "./terminal-decoration.js";

export function dialogLayout(
  width: number,
  height: number,
  maxHeight = 30,
  maxWidth = 104,
) {
  const popupWidth = Math.max(
    1,
    Math.min(maxWidth, width - (width >= 50 ? 4 : 2)),
  );
  const popupHeight = Math.max(
    1,
    Math.min(maxHeight, height - (height >= 12 ? 2 : 0)),
  );
  return {
    popupWidth,
    popupHeight,
    innerWidth: Math.max(1, popupWidth - 4),
    roomy: popupHeight >= 18,
    tiny: popupHeight < 8 || popupWidth < 30,
    left: Math.max(0, Math.floor((width - popupWidth) / 2)),
    top: Math.max(0, Math.floor((height - popupHeight) / 2)),
  };
}

/** Shared modal surface for settings and the skills library. */
export function OpenTuiDialog({
  id,
  width,
  height,
  palette,
  onClose,
  children,
  maxHeight,
  maxWidth,
  shadow = true,
}: {
  id: string;
  width: number;
  height: number;
  palette: Palette;
  onClose: () => void;
  children: ReactNode;
  maxHeight?: number;
  maxWidth?: number;
  shadow?: boolean;
}) {
  const renderer = useRenderer();
  const { borderChars } = useTerminalDecoration();
  const dismiss = useRef(false);
  const { popupWidth, popupHeight, left, top, roomy, tiny } = dialogLayout(
    width,
    height,
    maxHeight,
    maxWidth,
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape also dismisses the dialog.
    <box
      id={`${id}-backdrop`}
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={100}
      backgroundColor={
        shadow
          ? RGBA.fromInts(0, 0, 0, palette.bg === THEMES.paper.bg ? 65 : 150)
          : palette.bg
      }
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        dismiss.current = !renderer.getSelection()?.getSelectedText();
      }}
      onMouseUp={(event) => {
        if (event.button !== 0) return;
        if (dismiss.current && !renderer.getSelection()?.getSelectedText())
          onClose();
      }}
    >
      {shadow && (
        <box
          position="absolute"
          left={left + 1}
          top={top + 1}
          width={popupWidth}
          height={popupHeight}
          backgroundColor={RGBA.fromInts(0, 0, 0, 85)}
        />
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Popup clicks must not dismiss the backdrop. */}
      <box
        id={`${id}-popup`}
        position="absolute"
        left={left}
        top={top}
        width={popupWidth}
        height={popupHeight}
        border={tiny ? [] : true}
        borderStyle="rounded"
        customBorderChars={borderChars}
        borderColor={palette.border}
        backgroundColor={palette.surface}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={roomy ? 1 : 0}
        paddingBottom={roomy ? 1 : 0}
        flexDirection="column"
        overflow="hidden"
        onMouseUp={(event) => event.stopPropagation()}
      >
        {children}
      </box>
    </box>
  );
}

export function DialogAction({
  label,
  onSelect,
  palette,
  active = false,
  primary = false,
  disabled = false,
  id,
}: {
  label: string;
  onSelect: () => void;
  palette: Palette;
  active?: boolean;
  primary?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Dialog actions have keyboard equivalents.
    <box
      id={id}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={
        primary && !disabled
          ? palette.accent
          : active
            ? palette.raised
            : palette.surface
      }
      onMouseUp={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        if (!disabled) onSelect();
      }}
    >
      <text
        height={1}
        selectable={false}
        fg={
          disabled
            ? palette.muted
            : primary
              ? palette.bg
              : active
                ? palette.accent
                : palette.text
        }
      >
        {label}
      </text>
    </box>
  );
}
