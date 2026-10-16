/** @jsxImportSource @opentui/react */
import React, {
  createContext,
  type ReactNode,
  useContext,
  useState,
} from "react";
import type {
  OwnedUiContribution,
  UiActionUse,
  UiNode,
  UiSurface as UiSurfaceName,
} from "../extensions/ui-types.js";
import { uiNodeInfo } from "../extensions/ui-types.js";
import { type Palette, THEMES } from "./appearance.js";
import { DialogAction, OpenTuiDialog } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import {
  TerminalScrollbox,
  useTerminalDecoration,
} from "./terminal-decoration.js";
import { terminalSafeText } from "./terminal-text.js";

type Composition = {
  items: readonly OwnedUiContribution[];
  palette: Palette;
  dispatch?(key: string, use: UiActionUse, revision: number): void;
  interactive?: boolean;
};
const Context = createContext<Composition>({
  items: [],
  palette: THEMES.obsidian,
});
export const UiCompositionProvider = Context.Provider;
type Values = Partial<
  Record<"text" | "title" | "state" | "count" | "path", string | number>
>;
function color(palette: Palette, tone?: string) {
  return tone === "accent"
    ? palette.accent
    : tone === "success"
      ? palette.green
      : tone === "warning"
        ? palette.yellow
        : tone === "error"
          ? palette.red
          : tone === "muted"
            ? palette.muted
            : palette.text;
}
function Element({
  node,
  item,
  native,
  values,
}: {
  node: UiNode;
  item: OwnedUiContribution;
  native: ReactNode;
  values: Values;
}) {
  const context = useContext(Context);
  const { borderChars } = useTerminalDecoration();
  const fg = color(context.palette, "tone" in node ? node.tone : undefined);
  switch (node.type) {
    case "native":
      return native;
    case "text":
      return (
        <text fg={fg}>
          {node.bold ? <strong>{node.text}</strong> : node.text}
        </text>
      );
    case "value":
      return (
        <text fg={fg}>
          {terminalSafeText(
            String(values[node.field] ?? ""),
            node.maxLength ?? 2000,
          )}
        </text>
      );
    case "button":
      return (
        <DialogAction
          label={node.label}
          tone={node.tone}
          palette={context.palette}
          disabled={!context.interactive}
          onSelect={() =>
            context.dispatch?.(item.key, node.action, item.snapshot.revision)
          }
        />
      );
    case "box":
      return (
        <box
          width="100%"
          minWidth={0}
          flexShrink={0}
          flexGrow={node.grow ? 1 : undefined}
          minHeight={0}
          flexDirection={node.direction ?? "column"}
          flexWrap={node.direction === "row" ? "wrap" : "no-wrap"}
          gap={node.gap ?? 0}
          padding={node.padding ?? 0}
          border={node.border ?? false}
          borderStyle="rounded"
          customBorderChars={borderChars}
          borderColor={fg}
        >
          {node.children.map((child, index) => (
            <Element
              // Unkeyed SDK nodes are positional slots; label updates must preserve their native child.
              key={child.key ?? (child.type === "native" ? "native" : index)}
              node={child}
              item={item}
              native={native}
              values={values}
            />
          ))}
        </box>
      );
  }
}

/** Compose validated snapshots only; extension JavaScript never runs in React's paint path. */
export function UiSurface({
  name,
  children,
  values = {},
  preserveNative = false,
}: {
  name: UiSurfaceName;
  children?: ReactNode;
  values?: Values;
  preserveNative?: boolean;
}) {
  const context = useContext(Context);
  let result = children;
  for (const item of context.items) {
    if (
      item.descriptor.slot !== "render" ||
      !item.descriptor.surfaces?.includes(name) ||
      item.snapshot.state !== "ready"
    )
      continue;
    const patch = item.snapshot.render;
    if (!patch) continue;
    // Protected input/error owners cannot be duplicated, replaced or removed.
    if (
      preserveNative &&
      (patch.mode === "hide" ||
        (patch.mode === "replace" && uiNodeInfo(patch.content).native !== 1))
    )
      continue;
    if (patch.mode === "hide") {
      result = null;
      continue;
    }
    const content = patch.content && (
      <Element
        key={item.key}
        node={patch.content}
        item={item}
        native={result}
        values={values}
      />
    );
    result =
      patch.mode === "replace" ? (
        content
      ) : (
        <React.Fragment key={item.key}>
          {patch.mode === "before" && content}
          {result}
          {patch.mode === "after" && content}
        </React.Fragment>
      );
  }
  return result;
}

/** Kept outside customizable surfaces, so a failed provider cannot hide its fallback. */
export function UiCompositionNotices() {
  const { items, palette } = useContext(Context);
  const failed = items.filter(
    (item) =>
      item.descriptor.slot === "render" &&
      ["error", "unavailable"].includes(item.snapshot.state),
  );
  return failed.length ? (
    <text fg={palette.yellow} height={1} flexShrink={0}>
      {failed
        .map(
          (item) =>
            `${item.extensionId}: интерфейс недоступен, сохранён стандартный вид`,
        )
        .join(" · ")}
    </text>
  ) : null;
}

/** Keyboard access uses a core-owned modal; extensions cannot capture editor input. */
export function UiCompositionControls({
  width,
  height,
  owner,
  onClose,
}: {
  width: number;
  height: number;
  owner: string;
  onClose(): void;
}) {
  const context = useContext(Context);
  const buttons = context.items
    .filter(
      (item) =>
        item.descriptor.slot === "render" &&
        item.snapshot.state === "ready" &&
        item.snapshot.render?.mode !== "hide",
    )
    .flatMap((item) =>
      uiNodeInfo(item.snapshot.render?.content).buttons.map(
        (button, index) => ({
          item,
          use: button.action,
          label: button.label,
          id: `${item.key}/${index}`,
        }),
      ),
    );
  const [selected, select] = useState(buttons[0]?.id);
  const index = Math.max(
    0,
    buttons.findIndex((button) => button.id === selected),
  );
  const pageSize = Math.max(1, Math.min(20, height - 10));
  const start = Math.floor(index / pageSize) * pageSize;
  const activate = (button: (typeof buttons)[number]) => {
    onClose();
    context.dispatch?.(
      button.item.key,
      button.use,
      button.item.snapshot.revision,
    );
  };
  useUiKeyboard((key) => {
    if (capturedInputOwner(key) !== owner) return;
    if (key.ctrl || key.meta || key.option) return;
    if (["escape", "up", "down", "tab", "return", "enter"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "escape") onClose();
      else if (key.name === "return" || key.name === "enter") {
        if (buttons[index]) activate(buttons[index]!);
      } else
        select(
          buttons[
            (index +
              (key.name === "up" || key.shift ? -1 : 1) +
              buttons.length) %
              buttons.length
          ]?.id,
        );
    }
  });
  return (
    <OpenTuiDialog
      id="ui-composition-controls"
      width={width}
      height={height}
      palette={context.palette}
      onClose={onClose}
    >
      <text fg={context.palette.accent}>Действия интерфейса расширений</text>
      <text fg={context.palette.muted}>
        ↑/↓ выбор · Enter выполнить · Esc назад
      </text>
      <TerminalScrollbox flexGrow={1} minHeight={0}>
        {buttons.length ? (
          buttons
            .slice(start, start + pageSize)
            .map((button) => (
              <DialogAction
                key={button.id}
                label={`${button.item.descriptor.title} · ${button.label}`}
                palette={context.palette}
                active={button.id === buttons[index]?.id}
                onSelect={() => activate(button)}
              />
            ))
        ) : (
          <text fg={context.palette.muted}>Нет доступных действий</text>
        )}
      </TerminalScrollbox>
      {buttons.length > pageSize && (
        <text fg={context.palette.muted}>
          {index + 1} / {buttons.length}
        </text>
      )}
      <DialogAction
        label="Назад"
        palette={context.palette}
        onSelect={onClose}
      />
    </OpenTuiDialog>
  );
}
