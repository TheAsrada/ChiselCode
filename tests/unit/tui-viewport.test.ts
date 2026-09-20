import { describe, expect, test } from "bun:test";
import {
  describeTerminalSize,
  formatTerminalSizeLine,
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
      // Тихий путь (emitResize=false): поля обновляются, но resize не
      // эмитится — эмит посреди React-рендера давал ре-entrant рендер Ink.
      (stdout as Record<string, unknown>).columns = 80;
      (stdout as Record<string, unknown>).rows = 24;
      const fromRender = syncTerminalSizeToStdout(false);
      expect(fromRender).toEqual({ columns: 197, rows: 53 });
      expect(stdout.columns).toBe(197);
      expect(stdout.rows).toBe(53);
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

  test("describeTerminalSize exposes raw sources for doctor", () => {
    // Классика conhost: rows равен высоте буфера, а не окна.
    const stdout = process.stdout as unknown as {
      columns?: unknown;
      rows?: unknown;
      isTTY?: unknown;
      getWindowSize?: () => [number, number];
    };
    const originalColumns = stdout.columns;
    const originalRows = stdout.rows;
    const originalGetWindowSize = stdout.getWindowSize;
    try {
      (stdout as Record<string, unknown>).columns = 237;
      (stdout as Record<string, unknown>).rows = 3000;
      stdout.getWindowSize = () => [237, 63];
      const report = describeTerminalSize();
      expect(report.stdoutColumns).toBe(237);
      expect(report.stdoutRows).toBe(3000);
      expect(report.windowColumns).toBe(237);
      expect(report.windowRows).toBe(63);
      expect(report.hasGetWindowSize).toBe(true);
      // Live берёт ширину окна и отбрасывает высоту буфера.
      expect(report.liveColumns).toBe(237);
      expect(report.liveRows).toBe(63);
      const line = formatTerminalSizeLine(report);
      expect(line).toContain("237x63");
      expect(line).toContain("3000");
    } finally {
      if (originalGetWindowSize === undefined)
        delete (stdout as Record<string, unknown>).getWindowSize;
      else stdout.getWindowSize = originalGetWindowSize;
      (stdout as Record<string, unknown>).columns = originalColumns;
      (stdout as Record<string, unknown>).rows = originalRows;
    }
  });

  test("formatTerminalSizeLine marks missing size explicitly", () => {
    const line = formatTerminalSizeLine({
      stdoutColumns: undefined,
      stdoutRows: undefined,
      windowColumns: undefined,
      windowRows: undefined,
      hasGetWindowSize: false,
      envColumns: undefined,
      envRows: undefined,
      liveColumns: undefined,
      liveRows: undefined,
      isTTY: false,
    });
    expect(line).toContain("не определён");
    expect(line).toContain("нет метода");
  });
});
