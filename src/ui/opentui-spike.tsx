/** @jsxImportSource @opentui/react */
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import React, { useEffect, useState } from "react";
import type { ApprovalRequest } from "../security/approval.js";
import { ContextSidebar } from "./context-sidebar.js";
import { OpenTuiApproval } from "./opentui-approval.js";
import {
  OpenTuiSessions,
  type OpenTuiSessionsActions,
} from "./opentui-sessions.js";
import {
  OpenTuiSettings,
  type OpenTuiSettingsActions,
} from "./opentui-settings.js";
import {
  OpenTuiTranscript,
  TRANSCRIPT_WINDOW,
  terminalSafeText,
} from "./opentui-transcript.js";
import {
  parseSidebarMode,
  type SidebarMode,
  sidebarLayout,
  toggleSidebarMode,
} from "./sidebar-layout.js";
import type { TuiApprovalResolver } from "./tui.js";
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
  approvalResolver,
  onSubmit,
  sessionPicker,
  settingsActions,
}: {
  onExit: () => void;
  controller?: TuiController;
  initialMode?: SidebarMode;
  onModeChange?: (mode: SidebarMode) => void;
  approvalResolver?: TuiApprovalResolver;
  onSubmit?: (prompt: string) => Promise<void>;
  sessionPicker?: OpenTuiSessionsActions;
  settingsActions?: OpenTuiSettingsActions;
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
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSelection, setSettingsSelection] = useState(0);
  useEffect(() => {
    approvalResolver?.bind(setApproval);
    return () => approvalResolver?.bind(undefined);
  }, [approvalResolver]);
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
  const [windowEnd, setWindowEnd] = useState<number>();
  const [focus, setFocus] = useState<"editor" | "transcript">("editor");
  const layout = sidebarLayout(width, mode, overlayDismissed);
  const showSidebar = layout.placement !== "hidden";
  const contextOnly =
    layout.placement === "overlay" || layout.placement === "fullscreen";
  const textWidth = layout.feedWidth;
  const editorHeight = Math.min(4, Math.max(2, height - 3));
  const feedHeight = Math.max(1, height - editorHeight - 2);
  let newestDiffId: number | undefined;
  for (let index = view.transcript.length - 1; index >= 0; index--) {
    const entry = view.transcript[index];
    if (entry?.fileDiff) {
      newestDiffId = entry.id;
      break;
    }
  }

  const shiftWindow = (direction: "up" | "down") => {
    const total = view.transcript.length;
    const current = windowEnd ?? total;
    if (direction === "up" && current > TRANSCRIPT_WINDOW)
      setWindowEnd(
        Math.max(TRANSCRIPT_WINDOW, current - TRANSCRIPT_WINDOW / 2),
      );
    if (direction === "down" && current < total) {
      const next = Math.min(total, current + TRANSCRIPT_WINDOW / 2);
      setWindowEnd(next === total ? undefined : next);
    }
  };

  const changeMode = (next: SidebarMode) => {
    setMode(next);
    setOverlayDismissed(false);
    onModeChange?.(next);
  };

  useEffect(() => {
    if (!approval && !pickerOpen && !settingsOpen && !contextOnly) {
      if (focus === "editor") editor.current?.focus();
      else transcript.current?.focus();
    }
  }, [approval, pickerOpen, settingsOpen, contextOnly, focus]);

  useKeyboard((key) => {
    if (approval) {
      const answer = key.name.toLowerCase();
      if (answer === "y" || answer === "н")
        approvalResolver?.resolve("approved");
      if (answer === "n" || answer === "т" || answer === "escape")
        approvalResolver?.resolve("denied");
      return;
    }
    if (pickerOpen || settingsOpen) return;
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
    if (key.name === "pageup") shiftWindow("up");
    if (key.name === "pagedown") shiftWindow("down");
    if (key.name === "end") {
      setWindowEnd(undefined);
      transcript.current?.scrollTo(Number.MAX_SAFE_INTEGER);
    }
  });

  const submit = () => {
    if (approval) return;
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
    if (sessionPicker && (value === "/sessions" || value === "/resume")) {
      setPickerOpen(true);
      controller?.setOverlay("sessions");
      controller?.setFocus("modal");
      editor.current?.setText("");
      setDraft("");
      return;
    }
    if (settingsActions && (value === "/settings" || value === "/model")) {
      setSettingsSelection(value === "/model" ? 1 : 0);
      setSettingsOpen(true);
      controller?.setOverlay("settings");
      controller?.setFocus("modal");
      editor.current?.setText("");
      setDraft("");
      return;
    }
    if (onSubmit)
      void onSubmit(value).catch((error) =>
        controller?.append(String(error), "error"),
      );
    else {
      controller?.append(`❯ ${value}`, "user");
      setLines((current) => [
        ...current,
        { id: nextId.current++, text: `❯ ${value}` },
      ]);
    }
    editor.current?.setText("");
    setDraft("");
  };

  if (approval)
    return <OpenTuiApproval request={approval} width={width} height={height} />;
  if (pickerOpen && sessionPicker)
    return (
      <OpenTuiSessions
        actions={sessionPicker}
        width={width}
        height={height}
        onClose={() => {
          setPickerOpen(false);
          controller?.setOverlay();
          controller?.setFocus(focus === "editor" ? "composer" : "transcript");
        }}
      />
    );
  if (settingsOpen && settingsActions)
    return (
      <OpenTuiSettings
        actions={settingsActions}
        width={width}
        height={height}
        initialSelection={settingsSelection}
        onClose={() => {
          setSettingsOpen(false);
          controller?.setOverlay();
          controller?.setFocus(focus === "editor" ? "composer" : "transcript");
        }}
      />
    );

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
            {onSubmit
              ? `ChiselCode · ${terminalSafeText(view.sessionTitle ?? "новый сеанс", Math.max(12, textWidth - 16))}`
              : `ChiselCode · probe · ${width}×${height}`}
          </text>
          {height >= 12 && (
            <scrollbox
              ref={transcript}
              height={feedHeight}
              stickyScroll
              stickyStart="bottom"
              viewportCulling
              onMouseScroll={(event) => {
                const box = transcript.current;
                if (!box) return;
                if (event.scroll?.direction === "up" && box.scrollTop <= 0)
                  shiftWindow("up");
                if (
                  event.scroll?.direction === "down" &&
                  box.scrollTop >= box.scrollHeight - box.viewport.height
                )
                  shiftWindow("down");
              }}
            >
              {controller ? (
                <OpenTuiTranscript
                  entries={view.transcript}
                  contentWidth={textWidth - 2}
                  expandedId={expanded ? newestDiffId : undefined}
                  windowEnd={windowEnd}
                />
              ) : (
                <React.Fragment>
                  {lines.map((line) => (
                    <text key={line.id} fg="#d6dce5">
                      {line.text}
                    </text>
                  ))}
                  <text fg="#8090a0">example.ts · +1 −1 · Ctrl+D: diff</text>
                  {expanded && (
                    <diff
                      diff={PATCH}
                      view={textWidth - 2 >= 100 ? "split" : "unified"}
                      height={5}
                    />
                  )}
                </React.Fragment>
              )}
              {controller && view.streaming && (
                <text fg="#d6dce5" selectable>
                  {terminalSafeText(view.streaming, 20_000)}
                </text>
              )}
              {controller && view.toolActivity && (
                <text fg="#98a6b6">
                  {terminalSafeText(view.toolActivity, 2_000)}
                </text>
              )}
            </scrollbox>
          )}
          <text fg="#f1c56d">
            {draft ? "Черновик" : "Готово"} · Enter: отправить · Shift+Enter:
            строка · Esc: выход
          </text>
          <textarea
            ref={editor}
            height={editorHeight}
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
