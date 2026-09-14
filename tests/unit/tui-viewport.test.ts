import { describe, expect, test } from "bun:test";
import { normalizeViewport, resolveTerminalSize } from "../../src/ui/tui.js";

describe("resolveTerminalSize", () => {
  test("takes stdout size when it is sane", () => {
    expect(resolveTerminalSize({ stdoutColumns: 120, stdoutRows: 40 })).toEqual(
      { columns: 120, rows: 40 },
    );
  });

  test("rejects conhost buffer height and falls through", () => {
    // 3000 — высота буфера, а не видимого окна.
    expect(
      resolveTerminalSize({ stdoutColumns: 120, stdoutRows: 3000 }),
    ).toEqual({ columns: 120, rows: undefined });
    expect(
      resolveTerminalSize({
        stdoutColumns: 120,
        stdoutRows: 3000,
        windowRows: 40,
      }),
    ).toEqual({ columns: 120, rows: 40 });
  });

  test("keeps live TTY size over console fallback (no header offset)", () => {
    // Переоценка размера уводила шапку за верхний край: Console больше
    // не перекрывает живой размер TTY даже с preferConsole.
    expect(
      resolveTerminalSize(
        {
          stdoutColumns: 80,
          stdoutRows: 24,
          consoleColumns: 236,
          consoleRows: 62,
        },
        { preferConsole: true },
      ),
    ).toEqual({ columns: 80, rows: 24 });
  });

  test("uses console sources only when everything else is missing", () => {
    expect(
      resolveTerminalSize({
        consoleColumns: 236,
        consoleRows: 62,
      }),
    ).toEqual({ columns: 236, rows: 62 });
  });

  test("prefers env and ink over console fallback", () => {
    expect(
      resolveTerminalSize({
        envColumns: "100",
        envRows: "30",
        inkColumns: 90,
        inkRows: 25,
        consoleColumns: 236,
        consoleRows: 62,
      }),
    ).toEqual({ columns: 100, rows: 30 });
  });

  test("falls back to env and then ink", () => {
    expect(resolveTerminalSize({ envColumns: "100", envRows: "30" })).toEqual({
      columns: 100,
      rows: 30,
    });
    expect(resolveTerminalSize({ inkColumns: 90, inkRows: 25 })).toEqual({
      columns: 90,
      rows: 25,
    });
  });

  test("rejects zeros, negatives and garbage", () => {
    expect(
      resolveTerminalSize({
        stdoutColumns: 0,
        stdoutRows: -5,
        windowColumns: Number.NaN,
        envColumns: "wide",
      }),
    ).toEqual({ columns: undefined, rows: undefined });
    // Пустота нормализуется в классический fallback.
    expect(normalizeViewport(resolveTerminalSize({}))).toEqual({
      columns: 80,
      rows: 24,
    });
  });
});
