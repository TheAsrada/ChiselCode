/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type ReactNode, useRef, useState } from "react";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { capturedInputOwner } from "./overlay-input.js";
import { useTerminalDecoration } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";

export type SidebarTab = "menu" | "context" | "agents";
const tabs: readonly SidebarTab[] = ["menu", "context", "agents"];

export function sidebarChrome(height: number) {
  return {
    header: height >= 12 ? 4 : Math.min(2, Math.max(0, height - 1)),
    footer: height >= 6 ? 1 : 0,
  };
}

/** One persistent navigation strip; content owns its own scroll and input. */
export function SidebarPanel({
  tab,
  width,
  height,
  palette,
  focused,
  owner,
  running,
  approvals,
  busy,
  onSelect,
  onFocus,
  onBack,
  onHide,
  children,
}: {
  tab: SidebarTab;
  width: number;
  height: number;
  palette: Palette;
  focused: boolean;
  owner: string;
  running: number;
  approvals: number;
  busy?: boolean;
  onSelect(tab: SidebarTab): void;
  onFocus(): void;
  onBack(): void;
  onHide(): void;
  children: ReactNode;
}) {
  const { unicode } = useTerminalDecoration();
  const [hovered, setHovered] = useState<SidebarTab>();
  const pressed = useRef<SidebarTab | undefined>(undefined);
  const chrome = sidebarChrome(height);
  const tabWidth = Math.max(1, Math.floor((width - (width >= 30 ? 2 : 0)) / 3));
  useKeyboard((key) => {
    if (!focused || capturedInputOwner(key) !== owner) return;
    if (key.name === "f7" && tab !== "agents") {
      key.preventDefault();
      key.stopPropagation();
      onSelect("agents");
      return;
    }
    if (key.name === "escape" && tab !== "agents") {
      key.preventDefault();
      key.stopPropagation();
      onBack();
      return;
    }
    const direction =
      key.name === "[" || (key.ctrl && key.name === "left")
        ? -1
        : key.name === "]" || (key.ctrl && key.name === "right")
          ? 1
          : 0;
    const direct =
      !key.ctrl && !key.option && !key.meta && /^[123]$/.test(key.name)
        ? tabs[Number(key.name) - 1]
        : undefined;
    if (direction || direct) {
      key.preventDefault();
      key.stopPropagation();
      onSelect(
        direct ??
          tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length] ??
          "context",
      );
    }
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Tab reaches the same sidebar focus.
    <box
      id="sidebar-panel"
      width={width}
      height={height}
      flexDirection="column"
      backgroundColor={palette.surface}
      onMouseDown={onFocus}
    >
      {chrome.header === 4 && (
        <box
          height={2}
          flexShrink={0}
          paddingLeft={1}
          paddingTop={1}
          flexDirection="row"
        >
          <text
            attributes={TextAttributes.BOLD}
            fg={palette.muted}
            width={Math.max(1, width - 15)}
            selectable={false}
          >
            ПАНЕЛЬ СЕАНСА
          </text>
          <text
            fg={busy ? palette.accent : palette.muted}
            width={9}
            selectable={false}
          >
            {busy ? "В работе" : "Готов"}
          </text>
          <DialogAction
            id="sidebar-hide"
            label={unicode ? "×" : "x"}
            palette={palette}
            onSelect={onHide}
          />
        </box>
      )}
      {chrome.header > 0 && (
        <box
          id="sidebar-tabs"
          height={chrome.header === 4 ? 2 : chrome.header}
          flexShrink={0}
          paddingLeft={width >= 30 ? 1 : 0}
          flexDirection="row"
        >
          {tabs.map((item) => {
            const active = tab === item;
            const name =
              item === "menu"
                ? "Меню"
                : item === "context"
                  ? "Контекст"
                  : `Агенты ${running}${approvals ? `!${approvals}` : ""}`;
            const compact =
              item === "menu"
                ? "Меню"
                : item === "context"
                  ? "Конт."
                  : `Аг.${running}${approvals ? `!${approvals}` : ""}`;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: 1/2/3 and brackets switch the same tabs.
              // biome-ignore lint/a11y/useKeyWithMouseEvents: Keyboard focus is shared by the strip; the active focused tab has its own marker.
              <box
                key={item}
                id={`sidebar-tab-${item}`}
                width={tabWidth}
                height={chrome.header === 4 ? 2 : chrome.header}
                flexShrink={0}
                flexDirection="column"
                onMouseOver={() => setHovered(item)}
                onMouseOut={() => setHovered(undefined)}
                onMouseDown={(event) => {
                  if (event.button === 0) pressed.current = item;
                  event.stopPropagation();
                }}
                onMouseUp={(event) => {
                  const accept = event.button === 0 && pressed.current === item;
                  pressed.current = undefined;
                  event.stopPropagation();
                  if (accept) {
                    onFocus();
                    onSelect(item);
                  }
                }}
              >
                <text
                  height={1}
                  width={tabWidth}
                  selectable={false}
                  attributes={active ? TextAttributes.BOLD : 0}
                  fg={
                    active
                      ? palette.bg
                      : item === "agents" && approvals
                        ? palette.yellow
                        : palette.muted
                  }
                  bg={
                    active
                      ? palette.accent
                      : hovered === item
                        ? palette.raised
                        : palette.surface
                  }
                  content={terminalLine(
                    `${active && focused ? "> " : " "}${name.length + 2 <= tabWidth ? name : compact}`,
                    tabWidth,
                  )}
                />
                {chrome.header >= 2 && (
                  <text
                    height={1}
                    width={tabWidth}
                    selectable={false}
                    fg={active ? palette.accent : palette.border}
                    content={(unicode ? (active ? "━" : "─") : "-").repeat(
                      tabWidth,
                    )}
                  />
                )}
              </box>
            );
          })}
        </box>
      )}
      <box
        id="sidebar-content"
        width={width}
        height={Math.max(1, height - chrome.header - chrome.footer)}
        flexShrink={0}
        flexDirection="column"
      >
        {children}
      </box>
      {chrome.footer > 0 && (
        <text
          id="sidebar-hint"
          height={1}
          paddingLeft={1}
          fg={palette.muted}
          selectable={false}
          content={terminalLine(
            focused
              ? "1-3 разделы · [ ] · Esc в чат"
              : "Ctrl+B панель · F7 агенты",
            Math.max(1, width - 1),
          )}
        />
      )}
    </box>
  );
}

export function SidebarSection({
  title,
  width,
  palette,
  children,
  trailing,
}: {
  title: string;
  width: number;
  palette: Palette;
  children: ReactNode;
  trailing?: string;
}) {
  return (
    <box
      width="100%"
      marginBottom={1}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      flexDirection="column"
      backgroundColor={palette.bg}
    >
      <box height={1} flexShrink={0} flexDirection="row" marginBottom={0}>
        <text
          fg={palette.muted}
          attributes={TextAttributes.BOLD}
          selectable={false}
          width={Math.max(1, width - 2 - (trailing?.length ?? 0))}
        >
          {title}
        </text>
        {trailing && (
          <text fg={palette.accent} selectable={false}>
            {trailing}
          </text>
        )}
      </box>
      {children}
    </box>
  );
}
