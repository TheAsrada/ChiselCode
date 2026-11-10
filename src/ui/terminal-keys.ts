import type { KeyEvent } from "@opentui/core";

/** Match Ctrl+C through Kitty's base layout too; callers own other modifiers. */
export function isCtrlC(key: KeyEvent): boolean {
  // Non-Latin layouts report the physical C position separately. ASCII layouts
  // keep their typed identity (e.g. Dvorak Ctrl+J must remain Ctrl+J).
  const baseC =
    (key.baseCode === 99 || key.baseCode === 67) &&
    [...key.name].length === 1 &&
    (key.name.codePointAt(0) ?? 0) > 127;
  return key.ctrl && (key.name === "c" || baseC);
}
