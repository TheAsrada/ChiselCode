/** @jsxImportSource @opentui/react */
import type { InputRenderable } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { useLayoutEffect, useRef } from "react";
import type { Palette } from "./appearance.js";
import { clipText } from "./terminal-text.js";

export const cleanSettingsInput = (value: string) =>
  clipText(
    [...value]
      .filter((char) => {
        const code = char.codePointAt(0) ?? 0;
        return (
          code >= 32 &&
          (code < 127 || code > 159) &&
          !(code >= 0xd800 && code <= 0xdfff)
        );
      })
      .join(""),
    4096,
  );

/** OpenTUI 0.5.12 has no password input: its native buffer receives only bullets. */
export function SettingsSecretInput({
  value,
  onChange,
  onSubmit,
  palette,
  active = true,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  palette: Palette;
  active?: boolean;
}) {
  const input = useRef<InputRenderable>(null);
  const secret = useRef(value);
  secret.current = value;
  const undo = useRef<Array<{ value: string; cursor: number }>>([]);
  const redo = useRef<Array<{ value: string; cursor: number }>>([]);
  const snapshot = () => ({
    value: secret.current,
    cursor: input.current?.cursorOffset ?? [...secret.current].length,
  });
  const update = (next: string, cursor: number, remember = true) => {
    if (remember) {
      undo.current.push(snapshot());
      if (undo.current.length > 100) undo.current.shift();
      redo.current = [];
    }
    secret.current = next;
    if (input.current) {
      input.current.value = "*".repeat([...next].length);
      input.current.clearSelection();
      input.current.cursorOffset = cursor;
    }
    onChange(next);
  };
  useLayoutEffect(() => {
    const editor = input.current;
    if (!editor) return;
    const mask = "*".repeat([...value].length);
    if (editor.value !== mask) editor.value = mask;
  }, [value]);
  const insert = (text: string) => {
    const chars = [...secret.current];
    const selection = input.current?.getSelection();
    const cursor =
      selection?.start ?? input.current?.cursorOffset ?? chars.length;
    if (selection)
      chars.splice(selection.start, selection.end - selection.start);
    const added = [...cleanSettingsInput(text)].slice(0, 4096 - chars.length);
    chars.splice(cursor, 0, ...added);
    update(chars.join(""), cursor + added.length);
  };
  usePaste((event) => {
    if (!active) return;
    event.preventDefault();
    insert(new TextDecoder().decode(event.bytes));
  });
  useKeyboard((key) => {
    if (!active) return;
    if (key.ctrl && key.name === "c") return;
    const chars = [...secret.current];
    const cursor = input.current?.cursorOffset ?? chars.length;
    if (key.ctrl && (key.name === "z" || key.name === "y")) {
      key.preventDefault();
      const forward = key.name === "y" || key.shift;
      const from = forward ? redo : undo;
      const to = forward ? undo : redo;
      const previous = from.current.pop();
      if (previous) {
        to.current.push(snapshot());
        update(previous.value, previous.cursor, false);
      }
    } else if (
      key.name === "backspace" ||
      key.name === "delete" ||
      (key.ctrl && (key.name === "h" || key.name === "d" || key.name === "w"))
    ) {
      key.preventDefault();
      const selection = input.current?.getSelection();
      if (selection) {
        chars.splice(selection.start, selection.end - selection.start);
        update(chars.join(""), selection.start);
        return;
      }
      const backward =
        key.name === "backspace" || key.name === "h" || key.name === "w";
      if (
        key.meta ||
        (key.ctrl &&
          (key.name === "backspace" ||
            key.name === "delete" ||
            key.name === "w"))
      ) {
        const at = backward
          ? [
              ...chars
                .slice(0, cursor)
                .join("")
                .replace(/\s*\S+\s*$/, ""),
            ].length
          : cursor;
        const end = backward
          ? cursor
          : cursor +
            [
              ...(chars
                .slice(cursor)
                .join("")
                .match(/^\s*\S+\s*/)?.[0] ?? ""),
            ].length;
        chars.splice(at, end - at);
        update(chars.join(""), at);
        return;
      }
      const at = backward ? cursor - 1 : cursor;
      if (at >= 0 && at < chars.length) {
        chars.splice(at, 1);
        update(chars.join(""), backward ? Math.max(0, cursor - 1) : cursor);
      }
    } else if (key.ctrl && key.name === "u") {
      key.preventDefault();
      update(chars.slice(cursor).join(""), 0);
    } else if (key.ctrl && key.name === "k") {
      key.preventDefault();
      update(chars.slice(0, cursor).join(""), cursor);
    } else if (
      !key.ctrl &&
      !key.meta &&
      [...key.sequence].length === 1 &&
      cleanSettingsInput(key.sequence)
    ) {
      key.preventDefault();
      insert(key.sequence);
    }
  });
  return (
    <input
      id="settings-secret"
      ref={input}
      value={"*".repeat([...value].length)}
      focused={active}
      placeholder="Вставьте API-ключ..."
      backgroundColor={palette.raised}
      focusedBackgroundColor={palette.raised}
      textColor={palette.text}
      focusedTextColor={palette.text}
      placeholderColor={palette.muted}
      onSubmit={onSubmit}
    />
  );
}
