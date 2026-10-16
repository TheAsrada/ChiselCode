/** @jsxImportSource @opentui/react */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";

import { useLayoutEffect, useRef, useState } from "react";
import { subagentActive } from "../subagents/contracts.js";
import { subagentStatusTitle } from "../subagents/service.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { SubagentElapsed } from "./subagent-elapsed.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";

export function AgentsSidebar({
  controller,
  state,
  width,
  height,
  palette,
  focused,
  embedded = false,
  onFocus,
  onBack,
  onContext,
  onOpen,
  onStop,
}: {
  controller: TuiController;
  state: TuiViewState;
  width: number;
  height: number;
  palette: Palette;
  focused: boolean;
  embedded?: boolean;
  onFocus(): void;
  onBack(): void;
  onContext(): void;
  onOpen(id: string): void;
  onStop(id: string): void;
}) {
  const body = useRef<ScrollBoxRenderable>(null);
  const pressed = useRef<string | undefined>(undefined);
  const [action, setAction] = useState(0);
  const tiny = height < 12 || width < 30;
  const children = state.children ?? [];
  const selected = children.find(
    (child) => child.id === state.agentTree?.selected,
  );
  const collapsed = state.agentTree?.collapsed ?? false;
  const visible = collapsed ? [] : children;
  const keys = [undefined, ...visible.map((child) => child.id)];
  const index = Math.max(0, keys.indexOf(state.agentTree?.selected));
  const rowHeight = tiny ? 1 : 4;
  const rootHeight = tiny ? 1 : 2;
  const headerHeight = embedded ? 0 : 1;
  const footerHeight = tiny
    ? 1
    : selected
      ? Math.min(6, Math.max(2, Math.floor(height / 4)))
      : 2;
  const bodyHeight = Math.max(1, height - headerHeight - footerHeight);
  const running = children.filter((child) =>
    subagentActive(child.status),
  ).length;
  const approvals = children.filter(
    (child) => child.status === "awaiting_approval",
  ).length;
  const owner = `agents:${controller.conversationId}:${controller.currentGeneration}`;
  const actions = [
    () => (selected ? onOpen(selected.id) : onBack()),
    ...(selected && subagentActive(selected.status)
      ? [() => onStop(selected.id)]
      : []),
    onContext,
    onBack,
  ];
  useLayoutEffect(() => {
    const scroll = body.current;
    if (!scroll) return;
    const y = index === 0 ? 0 : rootHeight + (index - 1) * rowHeight;
    const bottom = y + (index === 0 ? rootHeight : rowHeight);
    if (y < scroll.scrollTop) scroll.scrollTo(y);
    else if (bottom > scroll.scrollTop + bodyHeight)
      scroll.scrollTo(bottom - bodyHeight);
    controller.agentPresentation.treeScroll = scroll.scrollTop;
  }, [index, bodyHeight, rowHeight, rootHeight, controller]);
  useUiKeyboard((key) => {
    if (
      !focused ||
      (capturedInputOwner(key) && capturedInputOwner(key) !== owner)
    )
      return;
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.ctrl || key.option || key.meta) return;
    if (key.name === "escape" || key.name === "f7") {
      key.preventDefault();
      key.stopPropagation();
      onBack();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      setAction(
        (current) =>
          (current + (key.shift ? -1 : 1) + actions.length + 1) %
          (actions.length + 1),
      );
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      key.stopPropagation();
      if (action) actions[action - 1]?.();
      else if (selected) onOpen(selected.id);
      else onBack();
      return;
    }
    if (key.name === "s" && selected && subagentActive(selected.status)) {
      key.preventDefault();
      key.stopPropagation();
      onStop(selected.id);
      return;
    }
    if (key.name === "c" && !key.ctrl) {
      key.preventDefault();
      key.stopPropagation();
      onContext();
      return;
    }
    if (action !== 0) return;
    if (
      [
        "up",
        "down",
        "j",
        "k",
        "home",
        "end",
        "pageup",
        "pagedown",
        "left",
        "right",
      ].includes(key.name)
    ) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "left" || key.name === "right") {
        controller.collapseAgents(key.name === "left");
        return;
      }
      const delta =
        (key.name === "up" || key.name === "k" || key.name === "pageup"
          ? -1
          : 1) *
        (key.name.startsWith("page")
          ? Math.max(1, Math.floor(bodyHeight / rowHeight))
          : 1);
      controller.selectAgent(
        keys[
          key.name === "home"
            ? 0
            : key.name === "end"
              ? keys.length - 1
              : Math.max(0, Math.min(keys.length - 1, index + delta))
        ],
      );
    }
  });
  const color = (status: string) =>
    status === "awaiting_approval"
      ? palette.yellow
      : [
            "failed",
            "timed_out",
            "budget_exhausted",
            "approval_unavailable",
          ].includes(status)
        ? palette.red
        : status === "completed"
          ? palette.green
          : status === "running"
            ? palette.accent
            : palette.muted;
  return (
    <box
      id="agents-sidebar"
      width={width}
      height={height}
      flexDirection="column"
      backgroundColor={palette.surface}
    >
      {!embedded && (
        <box height={1} flexShrink={0} flexDirection="row">
          <text fg={palette.accent} width={Math.max(1, width - 12)}>
            {terminalLine(
              `Агенты ${running}${approvals ? ` ?${approvals}` : ""}${focused ? " >" : ""}`,
              width - 12,
            )}
          </text>
          <DialogAction
            id="agents-context"
            label="Контекст C"
            palette={palette}
            onSelect={onContext}
          />
        </box>
      )}
      <TerminalScrollbox
        id="agents-tree"
        ref={body}
        height={bodyHeight}
        flexShrink={0}
        focused={false}
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={onFocus}
        viewportCulling
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Keyboard tree navigation is handled by the active input owner. */}
        <box
          id="agent-root"
          height={rootHeight}
          flexDirection="row"
          backgroundColor={!selected ? palette.raised : palette.surface}
          onMouseDown={(event) => {
            if (event.button === 0) pressed.current = "root";
          }}
          onMouseUp={(event) => {
            if (event.button === 0 && pressed.current === "root") {
              event.stopPropagation();
              controller.selectAgent();
              onFocus();
            }
            pressed.current = undefined;
          }}
        >
          <DialogAction
            id="agents-collapse"
            label={collapsed ? "+" : "-"}
            palette={palette}
            onSelect={() => {
              controller.collapseAgents(!collapsed);
              onFocus();
            }}
          />
          <text
            fg={!selected ? palette.accent : palette.text}
            attributes={TextAttributes.BOLD}
            selectable={false}
          >
            {terminalLine(
              `Основной агент · ${state.busy ? "Работает" : "Готов"}`,
              width - 3,
            )}
          </text>
        </box>
        {visible.map((child, i) => {
          const chosen = child.id === selected?.id;
          const duplicates =
            children.filter((item) => item.label === child.label).length > 1;
          const line = i === visible.length - 1 ? "└─" : "├─";
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: The whole row selects; Enter opens independently.
            <box
              key={child.id}
              id={`agent-node-${child.id}`}
              height={rowHeight}
              flexShrink={0}
              flexDirection="column"
              backgroundColor={chosen ? palette.raised : palette.bg}
              onMouseDown={(event) => {
                if (event.button === 0) pressed.current = child.id;
              }}
              onMouseUp={(event) => {
                const accept =
                  event.button === 0 && pressed.current === child.id;
                pressed.current = undefined;
                if (accept) {
                  event.stopPropagation();
                  controller.selectAgent(child.id);
                  onFocus();
                }
              }}
            >
              <text
                fg={chosen ? palette.accent : palette.text}
                attributes={TextAttributes.BOLD}
                height={1}
                selectable={false}
              >
                {terminalLine(
                  `${chosen ? (focused && action === 0 ? ">" : "|") : " "}${line} ${child.label}${duplicates ? ` #${child.ordinal}` : ""}${tiny ? ` · ${subagentStatusTitle(child.status)}` : ""}`,
                  width,
                )}
              </text>
              {!tiny && (
                <text height={1} fg={color(child.status)} selectable={false}>
                  {terminalLine(
                    `    ${subagentStatusTitle(child.status)} · ${child.mode === "coding" ? "Рабочая копия" : "Чтение"}`,
                    width,
                  )}
                </text>
              )}
              {!tiny &&
                (state.backgroundTasks ?? []).some(
                  (task) => task.childId === child.id && !task.finishedAt,
                ) && (
                  <DialogAction
                    label={`Фон ${(state.backgroundTasks ?? []).filter((task) => task.childId === child.id && !task.finishedAt).length}`}
                    palette={palette}
                    onSelect={() => controller.showBackground(child.id)}
                  />
                )}
              {!tiny && (
                <text height={1} fg={palette.muted} selectable={false}>
                  {terminalLine(`    ${child.step}`, width)}
                </text>
              )}
            </box>
          );
        })}
        {!children.length && (
          <box
            flexShrink={0}
            flexDirection="column"
            padding={tiny ? 0 : 1}
            marginTop={tiny ? 0 : 1}
            backgroundColor={palette.bg}
          >
            <text fg={palette.text} attributes={TextAttributes.BOLD}>
              Пока нет помощников
            </text>
            {!tiny && (
              <text fg={palette.muted}>
                Когда агент делегирует задачу, здесь появятся её шаги и
                результат.
              </text>
            )}
          </box>
        )}
      </TerminalScrollbox>
      <box
        height={footerHeight}
        flexShrink={0}
        flexDirection="column"
        backgroundColor={palette.raised}
        paddingLeft={tiny ? 0 : 1}
        paddingRight={tiny ? 0 : 1}
      >
        {!tiny && selected && (
          <text fg={palette.text} height={1}>
            {terminalLine(selected.label, width)}
          </text>
        )}
        {!tiny && selected && (
          <text fg={palette.muted} height={1}>
            {terminalLine(
              selected.worktree
                ? `Копия: ${selected.worktree.label}`
                : selected.step,
              width,
            )}
          </text>
        )}
        {!tiny && selected && footerHeight >= 4 && (
          <text fg={palette.muted} height={1}>
            {terminalLine(
              selected.spend.unknownUsage &&
                selected.spend.usage.inputTokens +
                  selected.spend.usage.outputTokens ===
                  0
                ? "Расход пока неизвестен"
                : `Расход: ${selected.spend.usage.inputTokens + selected.spend.usage.outputTokens} ток.${selected.spend.unknownUsage ? " · часть неизвестна" : ""}`,
              width,
            )}
          </text>
        )}
        {!tiny && selected && footerHeight >= 6 && (
          <SubagentElapsed record={selected} palette={palette} />
        )}
        {tiny ? (
          <text
            fg={palette.accent}
            height={1}
            content={terminalLine(
              action
                ? `[${[selected ? "Обзор" : "Чат", ...(selected && subagentActive(selected.status) ? ["Стоп"] : []), "Контекст", "Назад"][action - 1]}] Enter Esc`
                : selected
                  ? subagentActive(selected.status)
                    ? "Enter обзор S стоп Esc"
                    : "Enter обзор Esc назад"
                  : "Enter чат Esc назад",
              width,
            )}
          />
        ) : (
          <box height={1} flexDirection="row" gap={1}>
            <DialogAction
              id="agents-open"
              label={selected ? "Открыть" : "Основной чат"}
              palette={palette}
              active={action === 1}
              onSelect={actions[0] ?? onBack}
            />
            {selected && subagentActive(selected.status) && (
              <DialogAction
                id="agents-stop"
                label="Стоп S"
                palette={palette}
                active={action === 2}
                onSelect={() => onStop(selected.id)}
              />
            )}
            {action > (selected && subagentActive(selected.status) ? 2 : 1) && (
              <text fg={palette.accent}>
                {action === actions.length ? "Назад Enter" : "Контекст Enter"}
              </text>
            )}
          </box>
        )}
        {!tiny && footerHeight >= 5 && (
          <text fg={palette.muted} height={1}>
            ↑↓ выбор · ←→ дерево · Tab действия
          </text>
        )}
      </box>
    </box>
  );
}
