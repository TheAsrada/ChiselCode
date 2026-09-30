/** @jsxImportSource @opentui/react */
import { RGBA } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { type ReactNode, useRef } from "react";
import { type Palette, THEMES } from "./appearance.js";

export function dialogLayout(width: number, height: number) {
  const popupWidth = Math.max(1, Math.min(104, width - (width >= 50 ? 4 : 2)));
  const popupHeight = Math.max(
    1,
    Math.min(30, height - (height >= 12 ? 2 : 0)),
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
}: {
  id: string;
  width: number;
  height: number;
  palette: Palette;
  onClose: () => void;
  children: ReactNode;
}) {
  const renderer = useRenderer();
  const dismiss = useRef(false);
  const { popupWidth, popupHeight, left, top, roomy, tiny } = dialogLayout(
    width,
    height,
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
      backgroundColor={RGBA.fromInts(
        0,
        0,
        0,
        palette.bg === THEMES.paper.bg ? 65 : 150,
      )}
      onMouseDown={() => {
        dismiss.current = !renderer.getSelection()?.getSelectedText();
      }}
      onMouseUp={() => {
        if (dismiss.current && !renderer.getSelection()?.getSelectedText())
          onClose();
      }}
    >
      <box
        position="absolute"
        left={left + 1}
        top={top + 1}
        width={popupWidth}
        height={popupHeight}
        backgroundColor={RGBA.fromInts(0, 0, 0, 85)}
      />
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
