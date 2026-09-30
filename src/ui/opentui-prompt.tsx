/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import type { Palette } from "./appearance.js";
import { terminalSafeText } from "./opentui-transcript.js";

/** Shared composer surface; the native textarea keeps ownership of editing. */
export function OpenTuiPrompt({
  children,
  palette,
  width,
  focused,
  hasDraft,
  busy,
  model,
  onSubmit,
}: {
  children: ReactNode;
  palette: Palette;
  width: number;
  focused: boolean;
  hasDraft: boolean;
  busy?: boolean;
  model?: string;
  onSubmit: () => void;
}) {
  return (
    <box
      id="prompt"
      width="100%"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={focused ? palette.accent : palette.border}
      backgroundColor={palette.surface}
      title={hasDraft ? " Черновик " : " Сообщение "}
      titleColor={palette.muted}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      flexDirection="column"
    >
      {children}
      <box
        height={1}
        width="100%"
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text height={1} fg={palette.muted}>
          <span fg={palette.accent}>Chisel</span>
          {model
            ? ` · ${terminalSafeText(model, Math.max(1, width - 30))}`
            : ""}
          {busy ? " · отвечает" : ""}
        </text>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Enter also submits the message. */}
        <box
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={hasDraft ? palette.raised : palette.surface}
          onMouseUp={(event) => {
            event.stopPropagation();
            if (hasDraft) onSubmit();
          }}
        >
          <text
            fg={hasDraft ? palette.accent : palette.muted}
            height={1}
            selectable={false}
          >
            {width >= 60 ? "Отправить ↵" : "↵"}
          </text>
        </box>
      </box>
    </box>
  );
}
