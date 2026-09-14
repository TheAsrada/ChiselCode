import { describe, expect, test } from "bun:test";
import {
  clampViewportToTerminal,
  normalizeViewport,
  readLiveTerminalSize,
  resolveTerminalSize,
  syncTerminalSizeToStdout,
} from "../../src/ui/tui.js";

describe("resolveTerminalSize", () => {
  test("takes stdout size when it is sane", () => {
    expect(resolveTerminalSize({ stdoutColumns: 120, stdoutRows: 40 })).toEqual(
      { columns: 120, rows: 40 },
    );
  });

  test("prefers live getWindowSize over stale stdout cache", () => {
    // Полный экран на Windows: stdout.columns застрял на 80x24, а живой
    // сисколл getWindowSize() уже отдал 200x60 — кадр обязан вырасти сразу,
    // а не после ввода текста.
    expect(
      resolveTerminalSize({
        stdoutColumns: 80,
        stdoutRows: 24,
        windowColumns: 200,
        windowRows: 60,
      }),
    ).toEqual({ columns: 200, rows: 60 });
    // Сужение наоборот: живой маленький размер важнее stale-большого,
    // иначе переходный кадр шире окна и терминал ломает счётчик строк Ink.
    expect(
      resolveTerminalSize({
        stdoutColumns: 120,
        stdoutRows: 40,
        windowColumns: 80,
        windowRows: 20,
      }),
    ).toEqual({ columns: 80, rows: 20 });
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

describe("clampViewportToTerminal", () => {
  test("never renders wider or taller than the live window", () => {
    // Окно сузили 120x40 → 80x20, а состояние вьюпорта ещё старое:
    // кадр обязан ужаться до живого размера, иначе терминал перенесёт
    // длинные строки сам и счётчик строк Ink рассинхронизируется.
    expect(
      clampViewportToTerminal(
        { columns: 120, rows: 40 },
        { columns: 80, rows: 20 },
      ),
    ).toEqual({ columns: 80, rows: 20 });
  });

  test("stays narrower while the window grows", () => {
    // Окно расширили, состояние ещё старое: уже — безопасно,
    // следующий кадр подтянется опросом/событием resize.
    expect(
      clampViewportToTerminal(
        { columns: 80, rows: 24 },
        { columns: 200, rows: 60 },
      ),
    ).toEqual({ columns: 80, rows: 24 });
  });

  test("keeps the viewport when the live size is unavailable", () => {
    expect(
      clampViewportToTerminal(
        { columns: 100, rows: 30 },
        { columns: undefined, rows: undefined },
      ),
    ).toEqual({ columns: 100, rows: 30 });
  });

  test("ignores insane live values outside the visible window", () => {
    // Высота буфера conhost (3000) — не экран: не даём ей раздуть кадр.
    expect(
      clampViewportToTerminal(
        { columns: 100, rows: 30 },
        { columns: 120, rows: 3000 },
      ),
    ).toEqual({ columns: 100, rows: 30 });
  });
});

describe("syncTerminalSizeToStdout", () => {
  test("pushes live getWindowSize into stdout cache and emits resize", () => {
    // Ink читает только stdout.columns/rows: без синхрона Yoga-корень
    // застревает на 80 и полноэкранный кадр остаётся узким.
    const stdout = process.stdout as unknown as {
      columns?: unknown;
      rows?: unknown;
      getWindowSize?: () => [number, number];
      on?: (event: string, listener: () => void) => void;
      off?: (event: string, listener: () => void) => void;
    };
    const originalColumns = stdout.columns;
    const originalRows = stdout.rows;
    const originalGetWindowSize = stdout.getWindowSize;
    let resized = 0;
    const onResize = (): void => {
      resized += 1;
    };
    stdout.on?.("resize", onResize);
    try {
      (stdout as Record<string, unknown>).columns = 80;
      (stdout as Record<string, unknown>).rows = 24;
      stdout.getWindowSize = () => [197, 53];
      const live = syncTerminalSizeToStdout();
      expect(live).toEqual({ columns: 197, rows: 53 });
      // Живой размер виден и через обычный опрос, и в кэше для Ink.
      expect(readLiveTerminalSize()).toEqual({ columns: 197, rows: 53 });
      expect(stdout.columns).toBe(197);
      expect(stdout.rows).toBe(53);
      expect(resized).toBe(1);
      // Повторный синхрон без изменений не спамит resize.
      const again = syncTerminalSizeToStdout();
      expect(again).toEqual({ columns: 197, rows: 53 });
      expect(resized).toBe(1);
    } finally {
      stdout.off?.("resize", onResize);
      if (originalGetWindowSize === undefined)
        delete (stdout as Record<string, unknown>).getWindowSize;
      else stdout.getWindowSize = originalGetWindowSize;
      (stdout as Record<string, unknown>).columns = originalColumns;
      (stdout as Record<string, unknown>).rows = originalRows;
    }
  });
});
