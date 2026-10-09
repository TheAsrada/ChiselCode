/** @jsxImportSource @opentui/react */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";
import { subagentActive } from "../subagents/contracts.js";
import { subagentStatusTitle } from "../subagents/service.js";
import type { Palette } from "./appearance.js";
import { useClipboardActions } from "./opentui-clipboard.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { FormattedMessage } from "./opentui-message.js";
import { capturedInputOwner } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";

export function OpenTuiAgentDetails({
  controller,
  view,
  width,
  height,
  palette,
  onLoad,
  onStop,
  onApply,
}: {
  controller: TuiController;
  view: TuiViewState;
  width: number;
  height: number;
  palette: Palette;
  onLoad(id: string, section: "history" | "changes"): void;
  onStop(id: string): void;
  onApply(id: string): void;
}) {
  const renderer = useRenderer();
  const clipboard = useClipboardActions();
  const record = view.children?.find(
    (child) => child.id === view.agentView?.id,
  );
  const section = view.agentView?.section ?? "history";
  const body = useRef<ScrollBoxRenderable>(null);
  const sticky = useRef(true);
  const [follow, setFollow] = useState(true);
  const [focus, setFocus] = useState(0);
  const [newText, setNewText] = useState(false);
  const origin = useRef(controller.currentGeneration);
  const owner = `agent-view:${controller.conversationId}:${origin.current}`;
  const layout = dialogLayout(width, height, 30, 104);
  const tiny = width < 30 || height < 10;
  const contentWidth = Math.max(1, layout.popupWidth - (layout.tiny ? 2 : 4));
  const active = record ? subagentActive(record.status) : false;
  const apply =
    record?.mode === "coding" &&
    !active &&
    record.cleanup.quiescent &&
    !!record.worktree;
  const sections = ["history", "changes", "result"] as const;
  const actions = [
    {
      label: tiny ? "Назад" : "Назад · Esc",
      run: () => controller.hideAgent(),
    },
    ...(active && record
      ? [{ label: tiny ? "Стоп" : "Остановить", run: () => onStop(record.id) }]
      : []),
    ...(apply && record
      ? [
          {
            label: tiny ? "Перенос" : "Применить",
            run: () => onApply(record.id),
          },
        ]
      : []),
    ...(record?.text
      ? [
          {
            label: tiny ? "Копия" : "Копировать",
            run: () => {
              void clipboard?.copyText(record.text);
            },
          },
        ]
      : []),
  ];
  const recordId = record?.id;
  const anchor = `${recordId}:${section}`;
  useLayoutEffect(() => {
    if (!recordId) return;
    body.current?.scrollTo(
      controller.agentPresentation.scroll.get(anchor) ?? 0,
    );
    sticky.current = !controller.agentPresentation.scroll.has(anchor);
    setFollow(sticky.current);
    return () => {
      if (body.current)
        controller.agentPresentation.scroll.set(anchor, body.current.scrollTop);
    };
  }, [anchor, controller, recordId]);
  useLayoutEffect(() => {
    if (width < 1 || height < 1) return;
    if (sticky.current && !renderer.getSelection()?.getSelectedText())
      body.current?.scrollTo(Number.MAX_SAFE_INTEGER);
    else if (record?.text) setNewText(true);
  }, [record?.text, width, height, renderer]);
  const switchSection = (next: typeof section) => {
    controller.setAgentView({ section: next, notice: undefined });
    if (record && next !== "result") onLoad(record.id, next);
  };
  useKeyboard((key) => {
    if (
      !controller.isCurrent(origin.current) ||
      (capturedInputOwner(key) && capturedInputOwner(key) !== owner)
    )
      return;
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.ctrl || key.option || key.meta) return;
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      controller.hideAgent();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      setFocus(
        (current) =>
          (current + (key.shift ? -1 : 1) + actions.length + 1) %
          (actions.length + 1),
      );
      return;
    }
    if (key.name === "left" || key.name === "right") {
      key.preventDefault();
      key.stopPropagation();
      switchSection(
        sections[
          (sections.indexOf(section) + (key.name === "left" ? -1 : 1) + 3) % 3
        ] ?? "history",
      );
      return;
    }
    if (key.name === "s" && active && record) {
      key.preventDefault();
      key.stopPropagation();
      onStop(record.id);
      return;
    }
    if ((key.name === "return" || key.name === "enter") && focus) {
      key.preventDefault();
      key.stopPropagation();
      actions[focus - 1]?.run();
      return;
    }
    if (
      !focus &&
      ["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)
    ) {
      key.preventDefault();
      key.stopPropagation();
      const scroll = body.current;
      if (!scroll) return;
      // Explicit reading takes priority even while an asynchronously loaded body is still short.
      scroll.stickyScroll = key.name === "end";
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
        key.name === "home"
          ? false
          : scroll.scrollTop >= scroll.scrollHeight - scroll.viewport.height;
      setFollow(sticky.current);
      controller.agentPresentation.scroll.set(anchor, scroll.scrollTop);
      if (sticky.current) setNewText(false);
    }
  });
  const rows = Math.max(
    1,
    layout.popupHeight - (layout.tiny ? 0 : 2) - (layout.roomy ? 2 : 0) - 3,
  );
  return (
    <OpenTuiDialog
      id="agent-details"
      width={width}
      height={height}
      maxHeight={30}
      maxWidth={104}
      palette={palette}
      onClose={() => controller.hideAgent()}
    >
      <text height={1} fg={palette.accent}>
        {terminalLine(
          `${tiny ? "Помощник" : (record?.label ?? "Помощник не найден")} · ${record ? subagentStatusTitle(record.status) : "недоступен"}`,
          contentWidth,
        )}
      </text>
      <box height={1} flexDirection="row" flexShrink={0}>
        {sections.map((item, index) => (
          <DialogAction
            key={item}
            id={`agent-section-${item}`}
            label={
              tiny
                ? (["Ход", "Diff", "Итог"][index] ?? item)
                : (["Ход работы", "Изменения", "Итог"][index] ?? item)
            }
            palette={palette}
            active={section === item}
            onSelect={() => switchSection(item)}
          />
        ))}
      </box>
      <TerminalScrollbox
        id="agent-history"
        ref={body}
        height={rows}
        focused={false}
        flexShrink={0}
        stickyScroll={follow}
        stickyStart="bottom"
        onMouseDown={() => {
          setFocus(0);
          sticky.current = false;
          setFollow(false);
        }}
        onMouseScroll={() => {
          const scroll = body.current;
          if (scroll) {
            sticky.current =
              scroll.scrollTop >= scroll.scrollHeight - scroll.viewport.height;
            setFollow(sticky.current);
            controller.agentPresentation.scroll.set(anchor, scroll.scrollTop);
          }
        }}
      >
        {record && (
          <text fg={palette.muted} selectable>
            {record.task}
          </text>
        )}
        {view.agentView?.loading && (
          <text fg={palette.muted}>Загрузка сохранённой истории…</text>
        )}
        {section === "history" && (
          <>
            {view.agentView?.history && (
              <text fg={palette.text} selectable>
                {view.agentView.history}
              </text>
            )}
            {record?.progress.slice(-50).map((item) => (
              <text
                key={item.sequence}
                fg={item.outcome === "failed" ? palette.red : palette.muted}
                selectable
              >
                {item.text}
              </text>
            ))}
            {record?.text && (
              <FormattedMessage
                id="agent-stream"
                content={record.text}
                streaming={active}
                palette={palette}
                width={contentWidth}
              />
            )}
          </>
        )}
        {section === "changes" && (
          <>
            <text fg={palette.muted}>
              {active
                ? "Снимок текущего состояния; перенос доступен после остановки."
                : "Результат относительно committed base; origin ещё не изменён."}
            </text>
            {view.agentView?.diffs?.map((diff) => (
              <box key={diff.path} flexDirection="column">
                <text fg={palette.accent}>{diff.path}</text>
                <diff
                  diff={diff.patch}
                  view="unified"
                  height={Math.max(
                    3,
                    Math.min(16, diff.patch.split("\n").length),
                  )}
                />
              </box>
            ))}
            {!view.agentView?.diffs?.length && (
              <text fg={palette.muted}>
                {record?.mode === "readonly"
                  ? "Режим чтения: отдельной копии и изменений нет."
                  : (view.agentView?.history ??
                    "Откройте этот раздел для проверки изменений.")}
              </text>
            )}
          </>
        )}
        {section === "result" && record && (
          <>
            <FormattedMessage
              id="agent-result"
              content={record.text || "Итог пока недоступен."}
              palette={palette}
              width={contentWidth}
            />
            <text
              fg={palette.muted}
            >{`Расход: ${record.spend.usage.inputTokens + record.spend.usage.outputTokens} токенов${record.spend.unknownUsage ? " · часть неизвестна" : ""}. ${record.spend.unknownCost ? "Стоимость неизвестна или известна частично" : `~$${record.spend.knownCost.toFixed(4)}`}`}</text>
            <text
              fg={palette.muted}
            >{`Модель: ${record.model}\nКонтекст на момент отправки${record.context.truncated ? ": часть истории не вошла" : ""}.\nФактические операции:`}</text>
            {record.progress
              .filter((item) => item.type === "tool")
              .map((item) => (
                <text
                  key={item.sequence}
                  fg={item.outcome === "failed" ? palette.red : palette.muted}
                >
                  {item.text}
                </text>
              ))}
            <text fg={palette.muted}>
              Слова модели не подтверждают прохождение тестов без результата
              инструмента.
            </text>
            {record.worktree && (
              <text
                fg={palette.muted}
                selectable
              >{`Копия: ${record.worktree.label}\n${record.worktree.path}\nBase: ${record.worktree.base}`}</text>
            )}
            {!record.cleanup.quiescent && (
              <text fg={palette.yellow}>
                Cleanup не подтверждён; применение и удаление заблокированы.
              </text>
            )}
          </>
        )}
        {record?.error && <text fg={palette.red}>{record.error.message}</text>}
        {record?.persistenceError && (
          <text fg={palette.yellow}>
            Ошибка сохранения: {record.persistenceError}
          </text>
        )}
        {view.agentView?.notice && (
          <text fg={palette.yellow}>{view.agentView.notice}</text>
        )}
        {newText && <text fg={palette.accent}>Новый текст · End к ответу</text>}
      </TerminalScrollbox>
      <box height={1} flexDirection="row" flexShrink={0}>
        {width < 60 ? (
          <text fg={palette.accent}>
            {terminalLine(
              `[${actions[Math.max(0, focus - 1)]?.label ?? "Назад"}] Tab · Enter${active ? " · S стоп" : ""}`,
              contentWidth,
            )}
          </text>
        ) : (
          actions.map((action, index) => (
            <DialogAction
              key={action.label}
              id={`agent-action-${index}`}
              label={action.label}
              active={focus === index + 1}
              palette={palette}
              onSelect={action.run}
            />
          ))
        )}
      </box>
    </OpenTuiDialog>
  );
}
