/** @jsxImportSource @opentui/react */

import {
  type BoxRenderable,
  type InputRenderable,
  imageInfo,
  SyntaxStyle,
} from "@opentui/core";
import {
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  UiInputEvent,
  UiPresentationContext,
} from "../extension-sdk/ui-composition.js";
import type {
  OwnedUiContribution,
  UiActionUse,
  UiNode,
  UiSurface as UiSurfaceName,
} from "../extensions/ui-types.js";
import type { Palette } from "./appearance.js";
import {
  type Composition,
  UiCompositionContext as Context,
  type Values,
} from "./extension-composition-context.js";
import {
  UiNativePresentation,
  uiBoxStyle,
  uiColor,
  uiTextStyle,
} from "./extension-presentation.js";
import { DialogAction } from "./opentui-dialog.js";
import { FormattedMessage } from "./opentui-message.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { terminalSafeText } from "./terminal-text.js";

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
export function UiElement({
  node,
  item,
  native,
  values,
  instance,
  surface,
}: {
  node: UiNode;
  item: OwnedUiContribution;
  native: ReactNode;
  values: Values;
  instance: string;
  surface?: UiSurfaceName;
}) {
  const context = useContext(Context);
  const generated = useId();
  // Legacy button keys are sibling-local; their action already identifies the callback.
  const nodeKey = node.type === "button" ? generated : (node.key ?? generated);
  const focused =
    !!context.interactive &&
    context.focus?.key === item.key &&
    context.focus.nodeKey === nodeKey &&
    context.focus.instance === instance;
  const focus = () => {
    if (context.interactive)
      context.setFocus?.({ key: item.key, nodeKey, instance });
  };
  const presentation: UiPresentationContext = { surface, instance, values };
  const dispatch = () => {
    if (node.type === "button")
      context.dispatch?.(
        item.key,
        node.action,
        item.snapshot.revision,
        presentation,
      );
  };
  const emit = (event: UiInputEvent) => {
    if (context.interactive && nodeKey)
      context.event?.(
        item.key,
        nodeKey,
        event,
        item.snapshot.revision,
        presentation,
      );
  };
  const control =
    ((node.type === "button" ||
      node.type === "input" ||
      node.type === "select") &&
      !node.disabled) ||
    (node.type === "canvas" && !!(node.onPointer || node.onKey));
  const targetId = `${item.key}/${instance}/${nodeKey}`;
  const label = "label" in node ? node.label : "Элемент";
  const action =
    node.type === "button" ? JSON.stringify(node.action) : undefined;
  useLayoutEffect(() => {
    if (!control) return;
    return context.registerTarget?.({
      id: targetId,
      key: item.key,
      nodeKey,
      instance,
      label,
      ...(action ? { action: JSON.parse(action) as UiActionUse } : {}),
    });
  }, [
    control,
    context.registerTarget,
    targetId,
    item.key,
    nodeKey,
    instance,
    label,
    action,
  ]);
  useUiKeyboard((key) => {
    if (!context.interactive || capturedInputOwner(key) !== context.owner)
      return;
    const hotkey =
      node.type === "button" &&
      node.hotkey ===
        [
          key.ctrl && "ctrl",
          (key.meta || key.option) && "alt",
          key.shift && "shift",
          key.name,
        ]
          .filter(Boolean)
          .join("+");
    if (
      hotkey &&
      (focused ||
        (context.focus?.key === item.key &&
          (key.ctrl || key.meta || key.option)))
    ) {
      key.preventDefault();
      key.stopPropagation();
      if (node.type === "button" && !node.disabled) dispatch();
      return;
    }
    if (!focused) return;
    if (key.name === "escape" || key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "escape") context.setFocus?.(undefined);
      else {
        const controls = context.targets ?? [];
        const index = controls.findIndex((n) => n.id === targetId);
        context.setFocus?.(
          controls[
            (index + (key.shift ? -1 : 1) + controls.length) % controls.length
          ],
        );
      }
      return;
    }
    if (
      node.type === "button" &&
      (["enter", "return", "space"].includes(key.name) ||
        node.hotkey ===
          [
            key.ctrl && "ctrl",
            (key.meta || key.option) && "alt",
            key.shift && "shift",
            key.name,
          ]
            .filter(Boolean)
            .join("+"))
    ) {
      key.preventDefault();
      key.stopPropagation();
      if (!node.disabled) dispatch();
    }
    if (node.type === "canvas" && node.onKey) {
      key.preventDefault();
      key.stopPropagation();
      emit({
        type: "key",
        name: key.name,
        sequence: key.sequence,
        ctrl: !!key.ctrl,
        shift: !!key.shift,
        meta: !!(key.meta || key.option),
      });
    }
  });
  const fg = color(context.palette, "tone" in node ? node.tone : undefined);
  switch (node.type) {
    case "native":
      return native;
    case "text":
      return (
        <text fg={fg} {...uiTextStyle(context.palette, node.style)}>
          {node.bold ? <strong>{node.text}</strong> : node.text}
        </text>
      );
    case "value":
      return (
        <text fg={fg} {...uiTextStyle(context.palette, node.style)}>
          {terminalSafeText(
            String(values[node.field] ?? ""),
            node.maxLength ?? 2000,
          )}
        </text>
      );
    case "button":
      return (
        <box {...uiBoxStyle(context.palette, node.style)}>
          <DialogAction
            label={`${node.label}${node.hotkey ? ` [${node.hotkey}]` : ""}`}
            tone={node.tone}
            palette={context.palette}
            active={focused}
            disabled={!context.interactive || node.disabled}
            onSelect={() => {
              focus();
              dispatch();
            }}
          />
        </box>
      );
    case "input":
      return (
        <ExtensionInput
          id={`extension-${item.key}-${nodeKey}${instance.endsWith(":main") ? "" : `/${instance}`}`}
          identity={`${context.binding}/${targetId}`}
          drafts={context.drafts}
          node={node}
          focused={focused}
          focus={focus}
          emit={emit}
          palette={context.palette}
          interactive={context.interactive}
        />
      );
    case "select":
      return (
        // biome-ignore lint/a11y/noStaticElementInteractions: Alt+U and Tab focus the same native select.
        <box
          minWidth={0}
          flexShrink={0}
          {...uiBoxStyle(context.palette, node.style)}
          onMouseDown={focus}
        >
          <text fg={focused ? context.palette.accent : context.palette.muted}>
            {node.label}
          </text>
          <select
            id={`extension-${item.key}-${nodeKey}/${instance}`}
            height={Math.min(6, node.options.length * 2)}
            width="100%"
            focused={focused && !node.disabled}
            options={node.options.map((o) => ({
              name: o.label,
              description: o.description ?? "",
              value: o.value,
            }))}
            selectedIndex={Math.max(
              0,
              node.options.findIndex((o) => o.value === node.value),
            )}
            textColor={context.palette.text}
            backgroundColor={context.palette.surface}
            focusedBackgroundColor={context.palette.raised}
            selectedTextColor={context.palette.accent}
            onSelect={(index, option) => {
              if (option && !node.disabled)
                emit({ type: "select", value: String(option.value), index });
            }}
          />
        </box>
      );
    case "markdown":
      return <ExtensionMarkdown node={node} palette={context.palette} />;
    case "code":
      return <ExtensionCode node={node} palette={context.palette} />;
    case "image":
      return (
        <ExtensionImage
          id={`extension-${item.key}-${nodeKey}/${instance}`}
          node={node}
          palette={context.palette}
        />
      );
    case "canvas":
      return (
        // biome-ignore lint/a11y/noStaticElementInteractions: The region also accepts keyboard events after Alt+U/Tab.
        <box
          id={`extension-${item.key}-${nodeKey}/${instance}`}
          minWidth={0}
          flexShrink={0}
          {...uiBoxStyle(context.palette, node.style)}
          title={node.label}
          onMouseDown={(event) => {
            focus();
            const target = event.currentTarget as BoxRenderable;
            if (node.onPointer)
              emit({
                type: "pointer",
                x: Math.max(0, event.x - target.x),
                y: Math.max(0, event.y - target.y),
                button: event.button,
              });
          }}
        >
          {node.rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Canvas rows have coordinate identity.
            <text key={index} height={1}>
              {row.map((cell, column) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: Canvas cells have coordinate identity.
                  key={column}
                  fg={uiColor(context.palette, cell.fg)}
                  bg={uiColor(context.palette, cell.bg)}
                >
                  {cell.text}
                </span>
              ))}
            </text>
          ))}
        </box>
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
          borderStyle={node.border ? "rounded" : undefined}
          borderColor={node.border ? fg : undefined}
          {...uiBoxStyle(context.palette, node.style)}
        >
          {node.children.map((child, index) => (
            <UiElement
              // Unkeyed SDK nodes are positional slots; label updates must preserve their native child.
              key={child.key ?? (child.type === "native" ? "native" : index)}
              node={child}
              item={item}
              native={native}
              values={values}
              instance={instance}
              surface={surface}
            />
          ))}
        </box>
      );
  }
}

function ExtensionMarkdown({
  node,
  palette,
}: {
  node: Extract<UiNode, { type: "markdown" }>;
  palette: Palette;
}) {
  const ref = useRef<BoxRenderable>(null);
  const [width, setWidth] = useState(1);
  return (
    <box
      ref={ref}
      width="100%"
      minWidth={0}
      onSizeChange={() => {
        if (ref.current) setWidth(ref.current.width);
      }}
      {...uiBoxStyle(palette, node.style)}
    >
      <UiNativePresentation value={node.style ?? {}}>
        <FormattedMessage content={node.text} palette={palette} width={width} />
      </UiNativePresentation>
    </box>
  );
}
function ExtensionInput({
  id,
  identity,
  drafts,
  node,
  focused,
  focus,
  emit,
  palette,
  interactive,
}: {
  id: string;
  identity: string;
  drafts?: Composition["drafts"];
  node: Extract<UiNode, { type: "input" }>;
  focused: boolean;
  focus(): void;
  emit(event: UiInputEvent): void;
  palette: Palette;
  interactive?: boolean;
}) {
  const ref = useRef<InputRenderable>(null);
  const [value, setValue] = useState(
    drafts?.get(identity)?.value ?? node.value,
  );
  useEffect(() => {
    const saved = drafts?.get(identity);
    if (
      !saved ||
      (!focused && saved.source !== node.value && saved.value !== node.value)
    ) {
      setValue(node.value);
      drafts?.delete(identity);
    } else {
      setValue(saved.value);
      saved.source = node.value;
    }
  }, [node.value, focused, identity, drafts]);
  useLayoutEffect(() => {
    const saved = drafts?.get(identity);
    if (focused && ref.current && saved)
      ref.current.cursorOffset = Math.min(
        saved.cursor,
        ref.current.plainText.length,
      );
  }, [focused, identity, drafts]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Alt+U and Tab also focus this native input.
    <box
      minWidth={0}
      flexShrink={0}
      {...uiBoxStyle(palette, node.style)}
      onMouseDown={focus}
    >
      <text fg={focused ? palette.accent : palette.muted}>{node.label}</text>
      <input
        id={id}
        ref={ref}
        width="100%"
        value={value}
        maxLength={node.maxLength ?? 20000}
        placeholder={node.placeholder}
        focused={focused && !node.disabled && interactive}
        textColor={uiColor(palette, node.style?.fg) ?? palette.text}
        backgroundColor={uiColor(palette, node.style?.bg) ?? palette.surface}
        focusedBackgroundColor={palette.raised}
        cursorColor={palette.accent}
        onInput={(next) => {
          setValue(next);
          if (!focused) return;
          drafts?.set(identity, {
            value: next,
            source: node.value,
            cursor: ref.current?.cursorOffset ?? next.length,
          });
          if (node.onChange) emit({ type: "change", value: next });
        }}
        onCursorChange={() => {
          const saved = drafts?.get(identity);
          if (saved && ref.current) saved.cursor = ref.current.cursorOffset;
        }}
        onSubmit={() => {
          if (node.onSubmit)
            emit({ type: "submit", value: ref.current?.value ?? value });
        }}
      />
    </box>
  );
}
function ExtensionCode({
  node,
  palette,
}: {
  node: Extract<UiNode, { type: "code" }>;
  palette: Palette;
}) {
  const syntaxStyle = useMemo(
    () =>
      SyntaxStyle.fromStyles({
        default: { fg: palette.text },
        keyword: { fg: palette.accent },
        string: { fg: palette.green },
        comment: { fg: palette.muted },
        number: { fg: palette.yellow },
      }),
    [palette],
  );
  useEffect(() => () => syntaxStyle.destroy(), [syntaxStyle]);
  return (
    <code
      content={node.text}
      filetype={node.language}
      syntaxStyle={syntaxStyle}
      drawUnstyledText
      fg={uiColor(palette, node.style?.fg) ?? palette.text}
      width="100%"
      {...uiBoxStyle(palette, node.style)}
    />
  );
}
function ExtensionImage({
  id,
  node,
  palette,
}: {
  id: string;
  node: Extract<UiNode, { type: "image" }>;
  palette: Palette;
}) {
  const source = useMemo(() => {
    try {
      const bytes = Buffer.from(node.data, "base64");
      const info = imageInfo(bytes);
      return info.width > 0 &&
        info.height > 0 &&
        info.width * info.height <= 1_048_576
        ? bytes
        : undefined;
    } catch {
      return undefined;
    }
  }, [node.data]);
  const [failed, setFailed] = useState<string>();
  return !source || failed === node.data ? (
    <text fg={palette.muted}>{node.alt} · изображение недоступно</text>
  ) : (
    <image
      id={id}
      source={source}
      width={node.style?.width ?? "100%"}
      height={node.style?.height ?? 8}
      fit={node.fit ?? "fit"}
      onError={() => setFailed(node.data)}
    />
  );
}
