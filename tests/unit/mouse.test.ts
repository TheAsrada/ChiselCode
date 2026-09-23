import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SCROLL_SPEED,
  parseSGRMouse,
  resolveScrollSpeed,
  SGR_DISABLE,
  SGR_ENABLE,
  shouldEnableMouse,
} from "../../src/ui/mouse.js";

describe("sgr mouse", () => {
  test("parses wheel events with modifiers", () => {
    // Ink отдаёт SGR целой строкой без ведущего ESC (см. strip в use-input).
    expect(parseSGRMouse("[<64;10;20M")).toEqual({
      kind: "wheel-up",
      shift: false,
    });
    expect(parseSGRMouse("[<65;10;20M")).toEqual({
      kind: "wheel-down",
      shift: false,
    });
    // Shift+колесо: +4 к кнопке — рывок вместо построчного скролла.
    expect(parseSGRMouse("[<68;10;20M")).toEqual({
      kind: "wheel-up",
      shift: true,
    });
    expect(parseSGRMouse("[<69;10;20m")).toEqual({
      kind: "wheel-down",
      shift: true,
    });
    // Клики/отпускания глотаются (не мусор в ввод), но не скроллят.
    expect(parseSGRMouse("[<0;10;20M")).toEqual({
      kind: "other",
      shift: false,
    });
    expect(parseSGRMouse("[<0;10;20m")).toEqual({
      kind: "other",
      shift: false,
    });
    // Не-мышь — undefined: обычный ввод едет дальше в редактор.
    expect(parseSGRMouse("a")).toBeUndefined();
    expect(parseSGRMouse("[<64;10;20")).toBeUndefined();
    expect(parseSGRMouse("")).toBeUndefined();
    expect(parseSGRMouse("[5~")).toBeUndefined();
  });

  test("enable/disable pairs are ordered for clean teardown", () => {
    // Включаем press+wheel (1000) и SGR-расширение (1006),
    // гасим строго наоборот — иначе рваный teardown как у Claude.
    expect(SGR_ENABLE).toBe("\x1b[?1000h\x1b[?1006h");
    expect(SGR_DISABLE).toBe("\x1b[?1006l\x1b[?1000l");
  });

  test("scroll speed clamps to 1..20 with default 3", () => {
    expect(resolveScrollSpeed(undefined)).toBe(DEFAULT_SCROLL_SPEED);
    expect(resolveScrollSpeed("")).toBe(DEFAULT_SCROLL_SPEED);
    expect(resolveScrollSpeed("5")).toBe(5);
    expect(resolveScrollSpeed("0")).toBe(DEFAULT_SCROLL_SPEED);
    expect(resolveScrollSpeed("-3")).toBe(DEFAULT_SCROLL_SPEED);
    expect(resolveScrollSpeed("99")).toBe(20);
    expect(resolveScrollSpeed("мусор")).toBe(DEFAULT_SCROLL_SPEED);
  });

  test("mouse capture has a keyboard-only escape hatch", () => {
    expect(shouldEnableMouse({})).toBe(true);
    expect(shouldEnableMouse({ CHISEL_NO_MOUSE: "1" })).toBe(false);
    expect(shouldEnableMouse({ CHISEL_DISABLE_MOUSE: "1" })).toBe(false);
  });
});
