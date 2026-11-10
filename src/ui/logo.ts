/**
 * ASCII-арт логотип `<i>ChiselCode`, шрифт Coder Mini с TAAG
 * (patorjk, figlet.js). Встроен буквально: пробелы значимы.
 *
 * Только пробелы и блоки `█▀▄`, ширина — ровно клетка.
 * Цвет применяет renderer; здесь нет ANSI-последовательностей.
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

/**
 * Сплошные блоки заливаются фоном ячейки. Полублоки вырезают пустую
 * половину противоположным глифом: фон краски доходит до границы строки,
 * даже если шрифт оставляет зазор между глифами в Linux-терминале.
 */
export function renderLogoRuns(row: string) {
  return [...row.matchAll(/█+|[▀▄]+|[^█▀▄]+/g)].map((match) => {
    const text = match[0];
    const kind =
      text[0] === "█" ? "solid" : /[▀▄]/.test(text) ? "half" : "space";
    return {
      column: match.index,
      kind,
      text:
        kind === "half"
          ? text.replace(/[▀▄]/g, (c) => (c === "▀" ? "▄" : "▀"))
          : text,
    };
  });
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
