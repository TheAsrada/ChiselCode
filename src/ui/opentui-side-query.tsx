/** @jsxImportSource @opentui/react */

import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";
import { isModelRequestActive } from "../models/contracts.js";
import type { Palette } from "./appearance.js";
import { useClipboardActions } from "./opentui-clipboard.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { FormattedMessage } from "./opentui-message.js";
import { capturedInputOwner } from "./overlay-input.js";
import { sideStatus } from "./side-query-state.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";

/** Presentation only. Unmount/hide never owns or cancels the model request. */
export function OpenTuiSideQuery({
  controller,
  view,
  width,
  height,
  palette,
  onSubmit,
  onStop,
}: {
  controller: TuiController;
  view: TuiViewState;
  width: number;
  height: number;
  palette: Palette;
  onSubmit(question: string): void;
  onStop(): void;
}) {
  const renderer = useRenderer();
  const origin = useRef(controller.currentGeneration);
  const sideOwner = `side:${controller.conversationId}:${origin.current}`;
  const clipboard = useClipboardActions();
  const record = view.sideQueries?.find(
    (item) => item.operationId === view.sideView?.selected,
  );
  const editing = view.sideView?.editing ?? !record;
  const draft = view.sideView?.draft ?? "";
  const running = record
    ? isModelRequestActive(record.status)
    : view.sidePending;
  const pending = view.sidePending || running;
  const layout = dialogLayout(width, height, 20, 76);
  const compact = width < 60 || height < 14;
  const contentWidth = Math.max(1, layout.popupWidth - (layout.tiny ? 2 : 4));
  const body = useRef<ScrollBoxRenderable>(null);
  const input = useRef<TextareaRenderable>(null);
  const sticky = useRef(true);
  const [newText, setNewText] = useState(false);
  const [focus, setFocus] = useState(0);
  const selected = record?.operationId ?? "pending";
  useLayoutEffect(() => {
    if (!editing || !input.current) return;
    input.current.cursorOffset = Math.min(
      controller.sidePresentation.draftCursor,
      input.current.plainText.length,
    );
    const selection = controller.sidePresentation.draftSelection;
    if (selection) input.current.setSelection(selection.start, selection.end);
    const editor = input.current;
    return () => {
      controller.sidePresentation.draftCursor = editor.cursorOffset;
      controller.sidePresentation.draftSelection =
        editor.getSelection() ?? undefined;
    };
  }, [controller, editing]);

  useLayoutEffect(() => {
    if (editing) setFocus(0);
  }, [editing]);
  const actions = [
    {
      id: "hide",
      label: compact ? "Скрыть" : "Скрыть · Esc",
      run: () => controller.hideSide(),
    },
    ...(running
      ? [
          {
            id: "stop",
            label: compact ? "Стоп" : "Остановить ответ",
            run: onStop,
          },
        ]
      : []),
    ...(record?.text
      ? [
          {
            id: "copy",
            label: "Копировать",
            run: () => {
              void clipboard?.copyText(record.text);
            },
          },
        ]
      : []),
    {
      id: "new",
      label: compact ? "Вопрос" : "Новый вопрос",
      run: () => controller.newSideQuestion(),
    },
    ...(editing
      ? [
          {
            id: "send",
            label: pending ? "Ответ идёт" : "Отправить",
            run: () => {
              if (!pending && draft.trim()) onSubmit(draft);
            },
          },
        ]
      : []),
    ...(newText && !editing
      ? [
          {
            id: "bottom",
            label: "К ответу",
            run: () => {
              sticky.current = true;
              body.current?.scrollTo(Number.MAX_SAFE_INTEGER);
              setNewText(false);
            },
          },
        ]
      : []),
    ...(editing && record
      ? [
          {
            id: "answer",
            label: "К ответу",
            run: () => controller.readSideAnswer(),
          },
        ]
      : []),
  ];
  const focusOrder = [
    0,
    ...actions.flatMap((action, index) =>
      action.id === "send" && pending ? [] : [index + 1],
    ),
  ];
  const activeFocus = focusOrder.includes(focus) ? focus : 0;
  useLayoutEffect(() => {
    if (editing) return;
    const remembered = controller.sidePresentation.scroll.get(selected);
    if (remembered !== undefined) {
      body.current?.scrollTo(remembered);
      sticky.current =
        remembered >=
        (body.current?.scrollHeight ?? 0) -
          (body.current?.viewport.height ?? 0);
    }
    return () => {
      if (body.current)
        controller.sidePresentation.scroll.set(
          selected,
          body.current.scrollTop,
        );
    };
  }, [controller, selected, editing]);
  useLayoutEffect(() => {
    if (width < 1 || height < 1) return;
    if (sticky.current && !renderer.getSelection()?.getSelectedText())
      body.current?.scrollTo(Number.MAX_SAFE_INTEGER);
    else if (record?.text) setNewText(true);
  }, [record?.text, width, height, renderer]);
  useKeyboard((key) => {
    if (!controller.isCurrent(origin.current)) return;
    if (capturedInputOwner(key) && capturedInputOwner(key) !== sideOwner)
      return;
    if (key.ctrl && key.name === "c") return;
    if (key.name === "escape" || key.name === "f6") {
      key.preventDefault();
      key.stopPropagation();
      controller.hideSide();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      setFocus(
        focusOrder[
          (focusOrder.indexOf(activeFocus) +
            (key.shift ? -1 : 1) +
            focusOrder.length) %
            focusOrder.length
        ] ?? 0,
      );
      return;
    }
    if (activeFocus > 0 && (key.name === "return" || key.name === "enter")) {
      key.preventDefault();
      key.stopPropagation();
      actions[activeFocus - 1]?.run();
      return;
    }
    if (!editing && activeFocus === 0) {
      const scroll = body.current;
      if (!scroll) return;
      if (
        ["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)
      ) {
        key.preventDefault();
        key.stopPropagation();
        if (key.name === "home") scroll.scrollTo(0);
        else if (key.name === "end") scroll.scrollTo(Number.MAX_SAFE_INTEGER);
        else
          scroll.scrollBy(
            (key.name === "up" || key.name === "pageup" ? -1 : 1) *
              (key.name.startsWith("page")
                ? Math.max(1, scroll.viewport.height - 1)
                : 1),
          );
        sticky.current =
          scroll.scrollTop >= scroll.scrollHeight - scroll.viewport.height;
        controller.sidePresentation.scroll.set(selected, scroll.scrollTop);
        if (sticky.current) setNewText(false);
      }
    }
  });
  return (
    <OpenTuiDialog
      id="side-query"
      width={width}
      height={height}
      maxWidth={76}
      maxHeight={20}
      shadow={!layout.tiny}
      palette={palette}
      onClose={() => controller.hideSide()}
    >
      <text id="side-query-heading" height={1} fg={palette.accent}>
        {terminalLine(
          `${width < 30 ? "Побочный" : "Побочный вопрос"} · ${record ? sideStatus[record.status] : pending ? "Подготовка" : "Новый вопрос"}`,
          contentWidth,
        )}
      </text>
      {!compact && (
        <text height={1} fg={palette.muted}>
          {terminalLine(
            `${record?.model ?? view.modelSelection?.model ?? "Выбранная модель"} · Контекст на момент отправки${record?.context.truncated ? " · часть истории не вошла" : ""}`,
            contentWidth,
          )}
        </text>
      )}
      {editing ? (
        <box flexGrow={1} minHeight={1} flexDirection="column">
          <textarea
            id="side-question-editor"
            ref={input}
            initialValue={draft}
            flexGrow={1}
            minHeight={1}
            focused={activeFocus === 0}
            backgroundColor={palette.surface}
            focusedBackgroundColor={palette.surface}
            textColor={palette.text}
            focusedTextColor={palette.text}
            cursorColor={palette.accent}
            placeholder="Побочный вопрос…"
            onContentChange={() =>
              controller.setSideDraft(input.current?.plainText ?? "")
            }
            onSubmit={() => {
              const question = input.current?.plainText ?? "";
              if (!pending && question.trim()) onSubmit(question);
            }}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", shift: true, action: "newline" },
            ]}
          />
          {pending && (
            <text height={1} fg={palette.muted}>
              {terminalLine(
                "Ответ уже идёт; вопрос сохранён в черновике.",
                contentWidth,
              )}
            </text>
          )}
        </box>
      ) : (
        <TerminalScrollbox
          id="side-query-body"
          ref={body}
          flexGrow={1}
          minHeight={1}
          width="100%"
          focused={activeFocus === 0}
          stickyScroll
          stickyStart="bottom"
          onMouseDown={() => setFocus(0)}
          onMouseScroll={() => {
            const scroll = body.current;
            if (scroll) {
              sticky.current =
                scroll.scrollTop >=
                scroll.scrollHeight - scroll.viewport.height;
              controller.sidePresentation.scroll.set(
                selected,
                scroll.scrollTop,
              );
            }
          }}
        >
          {record?.question && (
            <text fg={palette.muted} selectable>
              {record.question}
            </text>
          )}
          {record?.text ? (
            <FormattedMessage
              id="side-response"
              content={record.text}
              palette={palette}
              width={contentWidth}
            />
          ) : (
            <text fg={palette.muted}>
              {pending
                ? "Готовим отдельный ответ. Основная задача продолжается."
                : "Ответ пока недоступен."}
            </text>
          )}
          {(record?.error || view.sideNotice) && (
            <text fg={palette.red} selectable>
              {record?.error?.message ?? view.sideNotice}
            </text>
          )}
          {record?.persistenceError && (
            <text fg={palette.yellow}>{record.persistenceError}</text>
          )}
          {newText && (
            <text fg={palette.accent}>Новый текст ↓ · End к ответу</text>
          )}
        </TerminalScrollbox>
      )}
      {!compact && record && (
        <text height={1} fg={palette.muted}>
          {record.usage
            ? `Токены: ${record.usage.inputTokens + record.usage.outputTokens}${record.usageSource === "partial" ? " · частично" : ""}`
            : "Расход токенов неизвестен"}{" "}
          ·{" "}
          {record.cost.source !== "unknown" && record.cost.usd !== undefined
            ? `~$${record.cost.usd.toFixed(4)}`
            : "Стоимость неизвестна"}
        </text>
      )}
      <box flexDirection="row" flexShrink={0} height={1} width="100%">
        {actions
          .filter(
            (_action, index) =>
              !compact || index === Math.max(0, activeFocus - 1),
          )
          .map((action) => (
            <DialogAction
              key={action.id}
              id={`side-${action.id}`}
              label={`${actions[activeFocus - 1] === action ? "> " : ""}${compact && activeFocus === 0 ? "Tab → " : ""}${action.label}`}
              palette={palette}
              active={actions[activeFocus - 1] === action}
              disabled={action.id === "send" && !!pending}
              onSelect={action.run}
            />
          ))}
      </box>
    </OpenTuiDialog>
  );
}
