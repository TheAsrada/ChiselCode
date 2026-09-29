export function readLiveTerminalSize(): { columns?: number; rows?: number } {
  const stdout = process.stdout;
  let size: [number, number] | undefined;
  try {
    size = stdout.getWindowSize?.();
  } catch {
    /* no TTY */
  }
  const dimension = (value: unknown, max: number): number | undefined => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= max
      ? Math.floor(number)
      : undefined;
  };
  return {
    columns:
      dimension(size?.[0], 1000) ??
      dimension(stdout.columns, 1000) ??
      dimension(process.env.COLUMNS, 1000),
    rows:
      dimension(size?.[1], 400) ??
      dimension(stdout.rows, 400) ??
      dimension(process.env.LINES, 400),
  };
}

export interface TerminalSizeReport {
  stdoutColumns: unknown;
  stdoutRows: unknown;
  windowColumns: unknown;
  windowRows: unknown;
  hasGetWindowSize: boolean;
  envColumns: unknown;
  envRows: unknown;
  liveColumns?: number;
  liveRows?: number;
  isTTY: boolean;
}

/**
 * Сырые источники размера для диагностики (`chisel doctor`).
 * Показывает, врёт ли рантайм: классика conhost — stdout.rows равен высоте
 * БУФЕРА (3000), а не окна; тогда live.rows пуст и TUI едет по высоте.
 */
export function describeTerminalSize(): TerminalSizeReport {
  let stdoutColumns: unknown;
  let stdoutRows: unknown;
  let windowColumns: unknown;
  let windowRows: unknown;
  let hasGetWindowSize = false;
  let isTTY = false;
  try {
    const stdout = process.stdout as unknown as {
      columns?: unknown;
      rows?: unknown;
      isTTY?: unknown;
      getWindowSize?: () => [number, number];
    };
    stdoutColumns = stdout?.columns;
    stdoutRows = stdout?.rows;
    isTTY = stdout?.isTTY === true;
    if (typeof stdout?.getWindowSize === "function") {
      hasGetWindowSize = true;
      try {
        const size = stdout.getWindowSize();
        windowColumns = size?.[0];
        windowRows = size?.[1];
      } catch {
        // Сисколл недоступен — ниже будет помечено отсутствием значений.
      }
    }
  } catch {
    // Нет TTY — все поля останутся undefined.
  }
  const live = readLiveTerminalSize();
  return {
    stdoutColumns,
    stdoutRows,
    windowColumns,
    windowRows,
    hasGetWindowSize,
    envColumns: process.env.COLUMNS,
    envRows: process.env.LINES,
    liveColumns: live.columns,
    liveRows: live.rows,
    isTTY,
  };
}

/** Одна строка для `chisel doctor`: всё про размер терминала сразу. */
export function formatTerminalSizeLine(report: TerminalSizeReport): string {
  const show = (value: unknown): string =>
    value === undefined || value === null || value === "" ? "—" : String(value);
  const live =
    report.liveColumns !== undefined || report.liveRows !== undefined
      ? `${show(report.liveColumns)}x${show(report.liveRows)}`
      : "не определён (fallback 80x24)";
  return (
    `Терминал: live ${live} · ` +
    `stdout ${show(report.stdoutColumns)}x${show(report.stdoutRows)} · ` +
    `getWindowSize ${report.hasGetWindowSize ? `${show(report.windowColumns)}x${show(report.windowRows)}` : "нет метода"} · ` +
    `TTY ${report.isTTY ? "да" : "нет"}`
  );
}
