/** @jsxImportSource @opentui/react */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";
import { subagentActive } from "../subagents/contracts.js";
import { subagentStatusTitle } from "../subagents/service.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { capturedInputOwner } from "./overlay-input.js";
import {
  TerminalScrollbox,
  useTerminalDecoration,
} from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";

export function AgentsSidebar({
  controller,
  state,
  width,
  height,
  palette,
  focused,
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
  onFocus(): void;
  onBack(): void;
  onContext(): void;
  onOpen(id: string): void;
  onStop(id: string): void;
}) {
  const { unicode } = useTerminalDecoration();
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
  const rowHeight = tiny ? 1 : 3;
  const footerHeight = tiny
    ? 1
    : selected
      ? Math.min(6, Math.max(2, Math.floor(height / 4)))
      : 2;
  const bodyHeight = Math.max(1, height - 1 - footerHeight);
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
    const y = index === 0 ? 0 : 1 + (index - 1) * rowHeight;
    const bottom = y + (index === 0 ? 1 : rowHeight);
    if (y < scroll.scrollTop) scroll.scrollTo(y);
    else if (bottom > scroll.scrollTop + bodyHeight)
      scroll.scrollTo(bottom - bodyHeight);
    controller.agentPresentation.treeScroll = scroll.scrollTop;
  }, [index, bodyHeight, rowHeight, controller]);
  useKeyboard((key) => {
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
      <TerminalScrollbox
        id="agents-tree"
        ref={body}
        height={bodyHeight}
        flexShrink={0}
        focused={false}
        onMouseDown={onFocus}
        viewportCulling
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Keyboard tree navigation is handled by the active input owner. */}
        <box
          id="agent-root"
          height={1}
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
          <text fg={palette.text} selectable={false}>
            {terminalLine(
              `Основной агент · ${state.busy ? "Работает" : "Готов к задаче"}`,
              width - 3,
            )}
          </text>
        </box>
        {visible.map((child, i) => {
          const chosen = child.id === selected?.id;
          const duplicates =
            children.filter((item) => item.label === child.label).length > 1;
          const line = unicode
            ? i === visible.length - 1
              ? "└─"
              : "├─"
            : i === visible.length - 1
              ? "`-"
              : "|-";
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: The whole row selects; Enter opens independently.
            <box
              key={child.id}
              id={`agent-node-${child.id}`}
              height={rowHeight}
              flexShrink={0}
              flexDirection="column"
              backgroundColor={chosen ? palette.raised : palette.surface}
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
                selectable={false}
              >
                {terminalLine(
                  `${chosen ? (focused && action === 0 ? ">" : "|") : " "}${line} ${child.label}${duplicates ? ` #${child.ordinal}` : ""}${tiny ? ` · ${subagentStatusTitle(child.status)}` : ""}`,
                  width,
                )}
              </text>
              {!tiny && (
                <text fg={color(child.status)} selectable={false}>
                  {terminalLine(
                    `    ${subagentStatusTitle(child.status)} · ${child.mode === "coding" ? "Рабочая копия" : "Чтение"}`,
                    width,
                  )}
                </text>
              )}
              {!tiny && (
                <text fg={palette.muted} selectable={false}>
                  {terminalLine(`    ${child.step}`, width)}
                </text>
              )}
            </box>
          );
        })}
        {!children.length && (
          <text fg={palette.muted}>
            Помощники появятся, когда агент делегирует задачу.
          </text>
        )}
      </TerminalScrollbox>
      <box
        height={footerHeight}
        flexShrink={0}
        flexDirection="column"
        backgroundColor={palette.raised}
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
        <text fg={palette.accent} height={1}>
          {terminalLine(
            tiny
              ? action
                ? `[${[selected ? "Обзор" : "Чат", ...(selected && subagentActive(selected.status) ? ["Стоп"] : []), "Контекст", "Назад"][action - 1]}] Enter Esc`
                : selected
                  ? subagentActive(selected.status)
                    ? "Enter обзор S стоп Esc"
                    : "Enter обзор Esc назад"
                  : "Enter чат Esc назад"
              : `${action ? `[${[selected ? "Открыть" : "Основной чат", ...(selected && subagentActive(selected.status) ? ["Остановить"] : []), "Контекст", "Назад"][action - 1]}] ` : ""}Enter ${selected ? "открыть" : "основной чат"}${selected && subagentActive(selected.status) ? " · S остановить" : ""} · Esc назад`,
            width,
          )}
        </text>
        {!tiny && footerHeight >= 5 && (
          <text fg={palette.muted} height={1}>
            ↑↓ выбор · ←→ дерево · Tab действия
          </text>
        )}
      </box>
    </box>
  );
}
