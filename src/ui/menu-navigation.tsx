/** @jsxImportSource @opentui/react */
import type { KeyEvent } from "@opentui/core";
import { useState } from "react";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { terminalLine } from "./terminal-text.js";

export interface MenuAction {
  id: string;
  label: string;
  shortLabel?: string;
  run(): void;
  disabled?: boolean;
  primary?: boolean;
}

/** Local focus only: operations and input ownership remain with the caller. */
export function useMenuNavigation(
  areas: readonly string[],
  actions: readonly MenuAction[],
  initial = "search",
) {
  const [storedArea, setArea] = useState(initial);
  const [actionId, setActionId] = useState("");
  const available = actions.filter((item) => !item.disabled);
  const targets = areas.filter(
    (item) => item !== "actions" || available.length > 0,
  );
  const area = targets.includes(storedArea)
    ? storedArea
    : (targets[0] ?? initial);
  const priorIndex = actions.findIndex((item) => item.id === actionId);
  const action =
    available.find((item) => item.id === actionId) ??
    actions.slice(Math.max(0, priorIndex)).find((item) => !item.disabled) ??
    available.at(-1);
  const tab = (reverse = false, wrap = true) => {
    const index = targets.indexOf(area);
    const next = index + (reverse ? -1 : 1);
    if (!wrap && (next < 0 || next >= targets.length)) return false;
    setArea(targets[(next + targets.length) % targets.length] ?? initial);
    return true;
  };
  const handle = (key: KeyEvent) => {
    // Opening a field or another local view must require a fresh Enter.
    if (key.repeated && !key.shift && ["return", "enter"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      return true;
    }
    if (key.ctrl || key.meta || key.option) return false;
    if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      tab(key.shift);
      return true;
    }
    if (area !== "actions") return false;
    if (["up", "left", "down", "right", "home", "end"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      const index = available.findIndex((item) => item.id === action?.id);
      const next =
        key.name === "home"
          ? 0
          : key.name === "end"
            ? available.length - 1
            : (index +
                (["up", "left"].includes(key.name) ? -1 : 1) +
                available.length) %
              available.length;
      setActionId(available[next]?.id ?? "");
      return true;
    }
    if (["return", "enter", "space"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      if (!key.repeated) action?.run();
      return true;
    }
    return false;
  };
  return { area, setArea, action, handle, tab };
}

/** A single scrolling action row keeps every operation reachable on small screens. */
export function MenuActions({
  actions,
  navigation,
  width,
  palette,
  compact = false,
  id,
}: {
  actions: readonly MenuAction[];
  navigation: ReturnType<typeof useMenuNavigation>;
  width: number;
  palette: Palette;
  compact?: boolean;
  id: string;
}) {
  const collapsed =
    compact ||
    actions.reduce((sum, item) => sum + item.label.length + 4, 0) > width;
  const shown = collapsed
    ? navigation.action
      ? [navigation.action]
      : []
    : actions;
  return (
    <box id={id} height={1} flexShrink={0} flexDirection="row">
      {shown.map((item) => (
        <DialogAction
          key={item.id}
          id={item.id}
          label={terminalLine(
            `${navigation.area === "actions" && navigation.action?.id === item.id ? "› " : ""}${collapsed ? "Действия: " : ""}${width < 40 ? (item.shortLabel ?? item.label) : item.label}`,
            Math.max(1, width - 2),
          )}
          active={
            navigation.area === "actions" && navigation.action?.id === item.id
          }
          disabled={item.disabled}
          primary={item.primary}
          palette={palette}
          onSelect={item.run}
        />
      ))}
    </box>
  );
}
