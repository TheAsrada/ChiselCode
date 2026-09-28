/** @jsxImportSource @opentui/react */
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import React, { useEffect, useState } from "react";
import { ContextSidebar } from "./context-sidebar.js";
import {
  parseSidebarMode,
  type SidebarMode,
  sidebarLayout,
  toggleSidebarMode,
} from "./sidebar-layout.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";

const PATCH = `diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -1 +1 @@
-const greeting = "Hello";
+const greeting = "Привет";
`;

/** Isolated compatibility probe, never selected by the regular CLI. */
export function OpenTuiSpike({
  onExit,
  controller,
  initialMode = "auto",
  onModeChange,
}: {
  onExit: () => void;
  controller?: TuiController;
  initialMode?: SidebarMode;
  onModeChange?: (mode: SidebarMode) => void;
}) {
  const { width, height } = useTerminalDimensions();
  const editor = React.useRef<TextareaRenderable>(null);
  const transcript = React.useRef<ScrollBoxRenderable>(null);
  const nextId = React.useRef(1);
  const [draft, setDraft] = useState("");
  const [lines, setLines] = useState([
    { id: 0, text: "ChiselCode · OpenTUI compatibility probe" },
  ]);
  const [mode, setMode] = useState<SidebarMode>(initialMode);
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [view, setView] = useState<TuiViewState>(
    () =>
      controller?.snapshot ?? {
        projectPath: process.cwd(),
        transcript: [],
        streaming: "",
        draft: "",
        focus: "composer",
      },
  );
  useEffect(() => controller?.subscribe(setView), [controller]);
  const [expanded, setExpanded] = useState(false);
  const [focus, setFocus] = useState<"editor" | "transcript">("editor");
  const layout = sidebarLayout(width, mode, overlayDismissed);
  const showSidebar = layout.placement !== "hidden";
  const contextOnly =
    layout.placement === "overlay" || layout.placement === "fullscreen";
  const textWidth = layout.feedWidth;

  const changeMode = (next: SidebarMode) => {
    setMode(next);
    setOverlayDismissed(false);
    onModeChange?.(next);
  };

  useEffect(() => {
    if (!contextOnly && focus === "editor") editor.current?.focus();
  }, [contextOnly, focus]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return onExit();
    if (key.name === "escape") {
      if (contextOnly) setOverlayDismissed(true);
      else if (expanded) setExpanded(false);
      else onExit();
    }
    if (key.ctrl && key.name === "b")
      changeMode(toggleSidebarMode(mode, width));
    if (key.name === "tab" && !contextOnly) {
      setFocus((value) => (value === "editor" ? "transcript" : "editor"));
      if (focus === "editor") transcript.current?.focus();
    }
    if (key.ctrl && key.name === "d") setExpanded((value) => !value);
  });

  const submit = () => {
    const value = editor.current?.plainText.trim();
    if (!value) return;
    if (value === "/sidebar" || value.startsWith("/sidebar ")) {
      const arg = value.slice("/sidebar".length).trim();
      const next = arg ? parseSidebarMode(arg) : toggleSidebarMode(mode, width);
      if (next) changeMode(next);
      editor.current?.setText("");
      setDraft("");
      return;
    }
    controller?.append(`❯ ${value}`, "user");
    setLines((current) => [
      ...current,
      { id: nextId.current++, text: `❯ ${value}` },
    ]);
    editor.current?.setText("");
    setDraft("");
  };

  return (
    <box
      width={width}
      height={height}
      flexDirection="row"
      backgroundColor="#111827"
    >
      {!contextOnly && (
        <box
          width={textWidth}
          height={height}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg="#78c8d4">
            ChiselCode · probe · {width}×{height}
          </text>
          {height >= 12 && (
            <scrollbox
              ref={transcript}
              flexGrow={1}
              stickyScroll
              stickyStart="bottom"
              viewportCulling
            >
              {(controller ? view.transcript : lines).map((line) => (
                <text key={line.id} fg="#d6dce5">
                  {line.text}
                </text>
              ))}
              <text fg="#8090a0">example.ts · +1 −1 · Ctrl+D: diff</text>
              {expanded && (
                <diff
                  diff={PATCH}
                  view={textWidth >= 100 ? "split" : "unified"}
                  height={5}
                />
              )}
            </scrollbox>
          )}
          <text fg="#f1c56d">
            {draft ? "Черновик" : "Готово"} · Enter: отправить · Shift+Enter:
            строка · Esc: выход
          </text>
          <textarea
            ref={editor}
            height={Math.min(4, Math.max(2, height - 3))}
            placeholder="Напишите сообщение…"
            onContentChange={() => {
              const next = editor.current?.plainText ?? "";
              setDraft(next);
              controller?.setDraft(next);
            }}
            onSubmit={submit}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", shift: true, action: "newline" },
            ]}
          />
        </box>
      )}
      {showSidebar && (
        <box
          width={contextOnly ? width : 41}
          height={height}
          flexDirection="row"
        >
          {!contextOnly && <box width={1} backgroundColor="#465264" />}
          <ContextSidebar
            state={view}
            width={contextOnly ? Math.min(width, 40) : 40}
            height={height}
          />
        </box>
      )}
    </box>
  );
}
