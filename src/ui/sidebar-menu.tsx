/** @jsxImportSource @opentui/react */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { cleanSettingsInput } from "./opentui-settings-input.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiPresentationController as TuiController } from "./tui-controller.js";

export interface SidebarMenuAction {
  id: string;
  label: string;
  detail: string;
  shortcut: string;
  group: string;
  run(): void;
}

export function SidebarMenu({
  actions: catalog,
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
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const actions = useMemo(() => {
    const words = query
      .normalize("NFKC")
      .toLocaleLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return catalog.filter((item) => {
      const text = `${item.label} ${item.detail} ${item.shortcut} ${item.group}`
        .normalize("NFKC")
        .toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [catalog, query]);
  const [selectedKey, setSelectedKey] = useState(
    controller?.sidebarPresentation.menuKey ??
      catalog[controller?.sidebarPresentation.menuIndex ?? 0]?.id,
  );
  const index = actions.findIndex((item) => item.id === selectedKey);
  // A removed extension action cannot silently turn into another command.
  const selected =
    index >= 0 ? index : selectedKey ? -1 : actions.length ? 0 : -1;
  const scroll = useRef<ScrollBoxRenderable>(null);
  const restored = useRef(false);
  const compact = height < 12 || width < 30;
  const canSearch = height >= 5;
  const restore = () => {
    const body = scroll.current;
    if (restored.current || !body || body.scrollHeight === 0) return;
    const position = controller?.sidebarPresentation.scroll.get("menu");
    if (position !== undefined) body.scrollTo(position);
    restored.current = true;
  };
  useLayoutEffect(() => {
    const body = scroll.current;
    return () => {
      if (body && controller)
        controller.sidebarPresentation.scroll.set("menu", body.scrollTop);
    };
  }, [controller]);
  const pick = (nextIndex: number) => {
    const next = Math.max(0, Math.min(actions.length - 1, nextIndex));
    const id = actions[next]?.id;
    setSelectedKey(id);
    if (id) scroll.current?.scrollChildIntoView(`sidebar-menu-${id}`);
    if (controller && id) {
      controller.sidebarPresentation.menuKey = id;
      controller.sidebarPresentation.menuIndex = catalog.findIndex(
        (item) => item.id === id,
      );
    }
  };
  const selectedId = actions[selected]?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Resize must reveal the selected command again.
  useLayoutEffect(() => {
    if (selectedId)
      scroll.current?.scrollChildIntoView(`sidebar-menu-${selectedId}`);
  }, [selectedId, height, compact]);
  useUiKeyboard((key) => {
    if (
      !focused ||
      capturedInputOwner(key) !== owner ||
      key.ctrl ||
      key.meta ||
      key.option
    )
      return;
    if (searching) {
      if (
        ["escape", "tab", "down", "up", "return", "enter"].includes(key.name)
      ) {
        key.preventDefault();
        key.stopPropagation();
        if (key.name === "escape" && query) {
          setQuery("");
          setSelectedKey(undefined);
        }
        setSearching(false);
        if ((key.name === "return" || key.name === "enter") && !key.repeated)
          actions[selected]?.run();
      }
      return;
    }
    if (key.name === "/" && canSearch) {
      key.preventDefault();
      key.stopPropagation();
      setSearching(true);
    } else if (
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
    } else if (["return", "enter", "space", " "].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      if (!key.repeated) actions[selected]?.run();
    }
  });
  return (
    <box width={width} height={height} flexDirection="column">
      {canSearch && (
        <input
          id="sidebar-menu-search"
          value={query}
          width="100%"
          marginBottom={1}
          placeholder="Найти действие /"
          focused={focused && searching}
          backgroundColor={palette.raised}
          textColor={palette.text}
          focusedTextColor={palette.text}
          placeholderColor={palette.muted}
          onMouseDown={() => {
            onFocus();
            setSearching(true);
          }}
          onInput={(value) => {
            setQuery(cleanSettingsInput(value).slice(0, 200));
            setSelectedKey(undefined);
          }}
        />
      )}
      <TerminalScrollbox
        id="sidebar-menu"
        ref={scroll}
        width={width}
        height={Math.max(1, height - (canSearch ? 2 : 0))}
        focused={false}
        paddingLeft={1}
        paddingRight={1}
        viewportCulling
        renderBefore={restore}
      >
        {!actions.length && <text fg={palette.muted}>Ничего не найдено</text>}
        {actions.map((action, row) => (
          <box key={action.id} flexDirection="column" flexShrink={0}>
            {(row === 0 || action.group !== actions[row - 1]?.group) && (
              <text
                height={1}
                marginTop={row ? 1 : 0}
                fg={palette.muted}
                attributes={TextAttributes.BOLD}
                selectable={false}
              >
                {action.group}
              </text>
            )}
            <DialogAction
              id={`sidebar-menu-${action.id}`}
              palette={palette}
              active={row === selected}
              label={terminalLine(
                `${focused && selected === row ? "> " : ""}${action.label}`,
                Math.max(1, width - 5 - action.shortcut.length),
              )}
              subtitle={
                compact
                  ? undefined
                  : terminalLine(action.detail, Math.max(1, width - 4))
              }
              trailing={{ label: action.shortcut }}
              onSelect={() => {
                pick(row);
                onFocus();
                action.run();
              }}
            />
          </box>
        ))}
      </TerminalScrollbox>
    </box>
  );
}
