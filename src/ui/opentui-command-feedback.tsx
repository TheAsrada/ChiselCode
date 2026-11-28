/** @jsxImportSource @opentui/react */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useRef, useState } from "react";
import type { Palette } from "./appearance.js";
import { DialogAction, OpenTuiDialog } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { isCtrlC } from "./terminal-keys.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";
import type { CommandFeedbackAction, TuiViewState } from "./tui-controller.js";

export function OpenTuiCommandFeedback({
  feedback,
  owner,
  width,
  height,
  palette,
  onClose,
  onAction,
}: {
  feedback: NonNullable<TuiViewState["commandFeedback"]>;
  owner: string;
  width: number;
  height: number;
  palette: Palette;
  onClose(): void;
  onAction(action: CommandFeedbackAction): void;
}) {
  const scroll = useRef<ScrollBoxRenderable>(null);
  const [selected, select] = useState(0);
  const actions = feedback.entries.flatMap((entry) => entry.actions ?? []);
  const action = actions[selected - 1];
  const activate = () => {
    onClose();
    if (action) onAction(action);
  };
  const failed = feedback.entries.some(
    (entry) => entry.tone === "error" || entry.tone === "warn",
  );
  useUiKeyboard((key) => {
    if (capturedInputOwner(key) !== owner) return;
    key.preventDefault();
    key.stopPropagation();
    if (key.repeated || key.eventType === "release") return;
    if (key.name === "escape" || isCtrlC(key)) onClose();
    else if (key.name === "return") activate();
    else if (key.name === "tab" && actions.length) {
      const count = actions.length + 1;
      select((index) => (index + (key.shift ? count - 1 : 1)) % count);
    } else if (key.name === "up") scroll.current?.scrollBy(-1);
    else if (key.name === "down") scroll.current?.scrollBy(1);
    else if (key.name === "pageup")
      scroll.current?.scrollBy(-Math.max(1, height - 6));
    else if (key.name === "pagedown")
      scroll.current?.scrollBy(Math.max(1, height - 6));
    else if (key.name === "home") scroll.current?.scrollTo(0);
    else if (key.name === "end")
      scroll.current?.scrollTo(Number.MAX_SAFE_INTEGER);
  });
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
        label={terminalLine(
          action
            ? `${action.action.label} · Enter${actions.length > 1 ? " / Tab" : ""}`
            : actions.length && width >= 40
              ? "Закрыть · Esc / Tab к действиям"
              : width >= 40
                ? "Закрыть · Enter / Esc"
                : "Закрыть · Esc",
          Math.min(80, width - 6),
        )}
        palette={palette}
        primary
        onSelect={activate}
      />
    </OpenTuiDialog>
  );
}
