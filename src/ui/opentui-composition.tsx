/** @jsxImportSource @opentui/react */
import React, { type ReactNode, useContext, useEffect, useState } from "react";
import type { UiNativeProps } from "../extension-sdk/ui-composition.js";
import type {
  UiActionUse,
  UiNode,
  UiSurface as UiSurfaceName,
} from "../extensions/ui-types.js";
import { uiNodeInfo } from "../extensions/ui-types.js";
import {
  UiCompositionContext as Context,
  type Values,
} from "./extension-composition-context.js";

export { UiCompositionProvider } from "./extension-composition-context.js";

import {
  UiNativePresentation,
  uiBoxStyle,
  uiTextStyle,
} from "./extension-presentation.js";
import { DialogAction, OpenTuiDialog } from "./opentui-dialog.js";
import { UiElement as Element } from "./opentui-extension-elements.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";

/** Compose validated snapshots only; extension JavaScript never runs in React's paint path. */
export function UiSurface({
  name,
  children,
  values = {},
  preserveNative = false,
  instanceId,
}: {
  name: UiSurfaceName;
  children?: ReactNode;
  values?: Values;
  preserveNative?: boolean;
  instanceId?: string | number;
}) {
  const context = useContext(Context);
  const props: UiNativeProps = {};
  const collect = (node?: UiNode) => {
    if (node?.type === "native") Object.assign(props, node.props);
    if (node?.type === "box") node.children.forEach(collect);
  };
  for (const item of context.items)
    if (
      item.descriptor.surfaces?.includes(name) &&
      item.snapshot.state === "ready"
    )
      collect(item.snapshot.render?.content);
  let native = children;
  if (
    React.isValidElement<Record<string, unknown>>(children) &&
    (children.type === "box" || children.type === "text")
  ) {
    native = React.cloneElement(
      children,
      children.type === "text"
        ? uiTextStyle(context.palette, props)
        : {
            ...uiBoxStyle(context.palette, props),
            ...(props.title ? { title: props.title } : {}),
          },
    );
  }
  let result = (
    <UiNativePresentation value={props}>{native}</UiNativePresentation>
  ) as ReactNode;
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
        instance={`${name}:${instanceId ?? "main"}`}
        surface={name}
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
      (item.descriptor.slot === "render" || item.descriptor.slot === "pane") &&
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

/** Independent panes remain available even when the built-in sidebar is closed. */
export const extensionPaneWidth = (width: number) =>
  Math.min(44, Math.max(24, Math.floor(width / 3)));
export function UiPaneRegion({
  placement,
  width,
  narrow = false,
}: {
  placement: "sidebar" | "above_prompt" | "below_prompt";
  width: number;
  narrow?: boolean;
}) {
  const context = useContext(Context);
  const items = context.items.filter(
    (item) =>
      item.descriptor.slot === "pane" &&
      (item.descriptor.placement === placement ||
        (narrow &&
          placement === "above_prompt" &&
          item.descriptor.placement === "sidebar")) &&
      item.snapshot.render?.mode !== "hide",
  );
  const collapsed = context.collapsed ?? new Set<string>();
  if (!items.length) return null;
  return (
    <box
      width={placement === "sidebar" ? extensionPaneWidth(width) : "100%"}
      minWidth={0}
      minHeight={0}
      flexShrink={0}
      flexDirection="column"
    >
      {items.map((item) => (
        <box
          key={item.key}
          width="100%"
          minWidth={0}
          minHeight={0}
          flexShrink={1}
          border
          borderColor={context.palette.border}
          borderStyle="rounded"
          flexDirection="column"
        >
          <DialogAction
            label={`${collapsed.has(item.key) ? ">" : "v"} ${item.descriptor.title}`}
            palette={context.palette}
            onSelect={() => context.togglePane?.(item.key)}
          />
          {!collapsed.has(item.key) &&
            (item.snapshot.state === "ready" &&
            item.snapshot.render?.content ? (
              <TerminalScrollbox
                maxHeight={placement === "sidebar" ? undefined : 10}
                minHeight={0}
              >
                <Element
                  instance={`pane:${item.key}`}
                  node={item.snapshot.render.content}
                  item={item}
                  native={null}
                  values={{}}
                />
              </TerminalScrollbox>
            ) : (
              <text fg={context.palette.muted}>
                {item.snapshot.state === "loading"
                  ? "Загрузка…"
                  : "Данные недоступны"}
              </text>
            ))}
        </box>
      ))}
    </box>
  );
}

export function UiCompositionFocusGuard() {
  const context = useContext(Context);
  useEffect(() => {
    if (
      context.focus &&
      !context.targets?.some(
        (target) =>
          target.key === context.focus?.key &&
          target.nodeKey === context.focus?.nodeKey &&
          target.instance === context.focus?.instance,
      )
    )
      context.setFocus?.(undefined);
  }, [context.focus, context.targets, context.setFocus]);
  return null;
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
  const buttons = [
    ...context.items
      .filter(
        (item) =>
          item.descriptor.slot === "pane" &&
          item.snapshot.render?.mode !== "hide",
      )
      .map((item) => ({
        item,
        id: `pane:${item.key}`,
        label: context.collapsed?.has(item.key)
          ? "Развернуть панель"
          : "Свернуть панель",
        pane: true,
        use: undefined as UiActionUse | undefined,
        nodeKey: "",
        instance: "",
      })),
    ...(context.targets ?? []).flatMap((target) => {
      const item = context.items.find(
        (item) => item.key === target.key && item.snapshot.state === "ready",
      );
      return item ? [{ item, ...target, use: target.action, pane: false }] : [];
    }),
  ];
  const [selected, select] = useState(buttons[0]?.id);
  const index = Math.max(
    0,
    buttons.findIndex((button) => button.id === selected),
  );
  const pageSize = Math.max(1, Math.min(20, height - 10));
  const start = Math.floor(index / pageSize) * pageSize;
  const activate = (button: (typeof buttons)[number]) => {
    onClose();
    if (button.pane) {
      context.togglePane?.(button.item.key);
      return;
    }
    if (!button.use) {
      if (button.nodeKey)
        context.setFocus?.({
          key: button.item.key,
          nodeKey: button.nodeKey,
          instance: button.instance,
        });
      return;
    }
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
