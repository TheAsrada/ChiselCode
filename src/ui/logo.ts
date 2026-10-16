/**
 * ASCII-арт логотип `<i>ChiselCode`, шрифт Coder Mini с TAAG
 * (patorjk, figlet.js). Встроен буквально: пробелы значимы.
 *
 * Только пробелы и half-блоки `█▀▄`: есть в шрифтах conhost, ширина —
 * ровно клетка. Цвет применяет renderer; здесь нет ANSI-последовательностей.
 * Coder Mini: Loic Cressot, MIT, patorjk/figlet.js/fonts/Coder Mini.flf.
 * Чистый модуль для шапки TUI и тестов.
 */
const LOGO_ART_LINES: string[] = [
  "                 ▄▄▄▄▄▄▄ ▄▄                    ▄▄  ▄▄▄▄▄▄▄          ▄▄",
  "   ▄▄ ▀▀  ▄▄    ███▀▀▀▀▀ ██    ▀▀              ██ ███▀▀▀▀▀          ██",
  " ▄█▀  ██   ▀█▄  ███      ████▄ ██  ▄█▀▀▀ ▄█▀█▄ ██ ███      ▄███▄ ▄████ ▄█▀█▄",
  "▀█▄   ██    ▄█▀ ███      ██ ██ ██  ▀███▄ ██▄█▀ ██ ███      ██ ██ ██ ██ ██▄█▀",
  "  ▀█▄ ██▄ ▄█▀   ▀███████ ██ ██ ██▄ ▄▄▄█▀ ▀█▄▄▄ ██ ▀███████ ▀███▀ ▀████ ▀█▄▄▄",
];

/** Строки логотипа для терминала (копия массива, мутировать нельзя). */
export function renderLogoRows(): string[] {
  return [...LOGO_ART_LINES];
}

/** Ширина логотипа в клетках (максимум по строкам). */
export const LOGO_WIDTH: number = Math.max(
  ...LOGO_ART_LINES.map((line) => [...line].length),
);

/** Высота логотипа в строках терминала. */
export const LOGO_TERM_ROWS: number = LOGO_ART_LINES.length;

/** Compact signature for the home screen. */
export const COMPACT_LOGO = [
  "▄▀▀ █▄█ █ ▄▀▀ ██▀ █   ▄▀▀ ▄▀▄ ▄▀▄ ██▀",
  "▀▄▄ █ █ █ ▄██ █▄▄ █▄▄ ▄██ ▀▄▀ █▄▀ █▄▄",
];
