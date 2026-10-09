/** @jsxImportSource @opentui/react */
import type { ClipboardService, EditBufferRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
} from "react";
import type { Palette } from "./appearance.js";
import { TerminalClipboardController } from "./terminal-clipboard.js";
import { terminalLine } from "./terminal-text.js";

const ClipboardContext = createContext<TerminalClipboardController | null>(
  null,
);

export function OpenTuiClipboard({
  children,
  palette,
  clipboard,
}: {
  children: ReactNode;
  palette: Palette;
  clipboard?: ClipboardService;
}) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const [notice, setNotice] = useState("");
  const [controller] = useState(
    () => new TerminalClipboardController(renderer, setNotice, clipboard),
  );
  useEffect(() => controller.attach(), [controller]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  return (
    <ClipboardContext value={controller}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Right-click is also available through paste/copy keyboard shortcuts. */}
      <box width="100%" height="100%" onMouseDown={controller.mouseDown}>
        {children}
        {notice && (
          <box
            position="absolute"
            bottom={0}
            left={0}
            width="100%"
            height={1}
            zIndex={200}
            backgroundColor={palette.surface}
          >
            <text
              id="clipboard-notice"
              fg={palette.accent}
              selectable={false}
              height={1}
            >
              {terminalLine(notice, width)}
            </text>
          </box>
        )}
      </box>
    </ClipboardContext>
  );
}

/** A popup owns paste while open; otherwise paste can restore composer focus. */
export function useClipboardComposer(
  resolve: () => EditBufferRenderable | null,
): void {
  const controller = useContext(ClipboardContext);
  const current = useEffectEvent(resolve);
  useLayoutEffect(
    () => controller?.registerComposer(() => current()),
    [controller],
  );
}

export function useClipboardActions() {
  return useContext(ClipboardContext);
}
