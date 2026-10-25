/** @jsxImportSource @opentui/react */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useRef } from "react";
import type { Palette } from "./appearance.js";
import { DialogAction, OpenTuiDialog } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalSafeText } from "./terminal-text.js";
import type { TuiViewState } from "./tui-controller.js";

/** Home feedback is owned by its project and disappears when dismissed. */
export function OpenTuiCommandFeedback({
  feedback,
  owner,
  width,
  height,
  palette,
  onClose,
}: {
  feedback: NonNullable<TuiViewState["commandFeedback"]>;
  owner: string;
  width: number;
  height: number;
  palette: Palette;
  onClose(): void;
}) {
  const scroll = useRef<ScrollBoxRenderable>(null);
  useUiKeyboard((key) => {
    if (capturedInputOwner(key) !== owner) return;
    key.preventDefault();
    key.stopPropagation();
    if (key.repeated || key.eventType === "release") return;
    if (
      key.name === "escape" ||
      key.name === "return" ||
      (key.ctrl && key.name === "c")
    )
      onClose();
    else if (key.name === "up") scroll.current?.scrollBy(-1);
    else if (key.name === "down") scroll.current?.scrollBy(1);
    else if (key.name === "pageup")
      scroll.current?.scrollBy(-Math.max(1, height - 6));
    else if (key.name === "pagedown")
      scroll.current?.scrollBy(Math.max(1, height - 6));
    else if (key.name === "home") scroll.current?.scrollTo(0);
    else if (key.name === "end")
      scroll.current?.scrollTo(Number.MAX_SAFE_INTEGER);
  });
  const failed = feedback.entries.some(
    (entry) => entry.tone === "error" || entry.tone === "warn",
  );
  return (
    <OpenTuiDialog
      id="command-feedback"
      width={width}
      height={height}
      palette={palette}
      onClose={onClose}
      maxHeight={20}
      maxWidth={88}
    >
      <text
        height={1}
        flexShrink={0}
        fg={failed ? palette.yellow : palette.accent}
      >
        {failed ? "Ошибка команды" : "Результат команды"}
      </text>
      <TerminalScrollbox ref={scroll} flexGrow={1} minHeight={0} width="100%">
        {feedback.entries.map((entry) => (
          <text
            key={entry.id}
            fg={
              entry.tone === "error"
                ? palette.red
                : entry.tone === "warn"
                  ? palette.yellow
                  : palette.text
            }
          >
            {terminalSafeText(entry.text)}
          </text>
        ))}
      </TerminalScrollbox>
      <DialogAction
        id="command-feedback-close"
        label={width >= 40 ? "Закрыть · Enter / Esc" : "Закрыть · Esc"}
        palette={palette}
        primary
        onSelect={onClose}
      />
    </OpenTuiDialog>
  );
}
