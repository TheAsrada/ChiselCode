/** @jsxImportSource @opentui/react */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Palette } from "./appearance.js";
import { capturedInputOwner } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiController } from "./tui-controller.js";

export interface SidebarMenuAction {
  id: string;
  label: string;
  detail: string;
  shortcut: string;
  group: string;
  run(): void;
}

export function SidebarMenu({
  actions,
  controller,
  width,
  height,
  palette,
  focused,
  owner,
  onFocus,
}: {
  actions: readonly SidebarMenuAction[];
  controller?: TuiController;
  width: number;
  height: number;
  palette: Palette;
  focused: boolean;
  owner: string;
  onFocus(): void;
}) {
  const [selected, setSelected] = useState(
    controller?.sidebarPresentation.menuIndex ?? 0,
  );
  const scroll = useRef<ScrollBoxRenderable>(null);
  const pressed = useRef<string | undefined>(undefined);
  const restored = useRef(false);
  const restore = () => {
    const body = scroll.current;
    if (restored.current || !body || body.scrollHeight === 0) return;
    const position = controller?.sidebarPresentation.scroll.get("menu");
    if (position !== undefined) body.scrollTo(position);
    else if (actions[selected])
      body.scrollChildIntoView(`sidebar-menu-${actions[selected].id}`);
    restored.current = true;
  };
  useLayoutEffect(() => {
    const body = scroll.current;
    return () => {
      if (body && controller)
        controller.sidebarPresentation.scroll.set("menu", body.scrollTop);
    };
  }, [controller]);
  const compact = height < 12 || width < 30;
  const pick = (index: number) => {
    const next = Math.max(0, Math.min(actions.length - 1, index));
    setSelected(next);
    const id = actions[next]?.id;
    if (id) scroll.current?.scrollChildIntoView(`sidebar-menu-${id}`);
    if (controller) controller.sidebarPresentation.menuIndex = next;
  };
  const selectedId = actions[selected]?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A resized viewport must reveal the selected action again.
  useLayoutEffect(() => {
    const body = scroll.current;
    if (!body) return;
    if (selectedId) body.scrollChildIntoView(`sidebar-menu-${selectedId}`);
  }, [selectedId, compact, height]);
  useKeyboard((key) => {
    if (
      !focused ||
      capturedInputOwner(key) !== owner ||
      key.ctrl ||
      key.meta ||
      key.option
    )
      return;
    if (
      ["up", "down", "home", "end", "pageup", "pagedown"].includes(key.name)
    ) {
      key.preventDefault();
      key.stopPropagation();
      const delta = key.name === "up" || key.name === "pageup" ? -1 : 1;
      pick(
        key.name === "home"
          ? 0
          : key.name === "end"
            ? actions.length - 1
            : selected + delta * (key.name.startsWith("page") ? 3 : 1),
      );
    } else if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      key.stopPropagation();
      actions[selected]?.run();
    }
  });
  return (
    <TerminalScrollbox
      id="sidebar-menu"
      ref={scroll}
      width={width}
      height={height}
      focused={false}
      paddingLeft={1}
      paddingRight={1}
      viewportCulling
      renderBefore={restore}
    >
      {actions.map((action, index) => (
        <box key={action.id} flexDirection="column" flexShrink={0}>
          {(index === 0 || action.group !== actions[index - 1]?.group) && (
            <text
              height={1}
              marginTop={index ? 1 : 0}
              marginBottom={compact ? 0 : 1}
              fg={palette.muted}
              attributes={TextAttributes.BOLD}
              selectable={false}
            >
              {action.group}
            </text>
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Arrow keys select and Enter invokes the same action. */}
          <box
            id={`sidebar-menu-${action.id}`}
            height={compact ? 1 : 3}
            flexShrink={0}
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={selected === index ? palette.raised : palette.bg}
            onMouseDown={(event) => {
              if (event.button === 0) pressed.current = action.id;
              event.stopPropagation();
            }}
            onMouseUp={(event) => {
              const accept =
                event.button === 0 && pressed.current === action.id;
              pressed.current = undefined;
              event.stopPropagation();
              if (accept) {
                pick(index);
                onFocus();
                action.run();
              }
            }}
          >
            <box height={1} flexDirection="row">
              <text
                selectable={false}
                attributes={selected === index ? TextAttributes.BOLD : 0}
                fg={selected === index ? palette.accent : palette.text}
                width={Math.max(1, width - 4 - action.shortcut.length)}
                content={terminalLine(
                  `${focused && selected === index ? "> " : ""}${action.label}`,
                  Math.max(1, width - 4 - action.shortcut.length),
                )}
              />
              <text
                selectable={false}
                fg={palette.muted}
                content={action.shortcut}
              />
            </box>
            {!compact && (
              <text
                height={1}
                selectable={false}
                fg={palette.muted}
                content={terminalLine(action.detail, Math.max(1, width - 4))}
              />
            )}
          </box>
        </box>
      ))}
    </TerminalScrollbox>
  );
}
