/**
 * Пиксельный логотип `</> ChiselCode` для шапки TUI — как у топовых CLI
 * (блочный вордмарк вместо плоского текста).
 *
 * Шрифт 5×7 (`#` — залитый пиксель, `.` — пусто), марки `</>` — 5px
 * по центру 7px-ряда. Упаковка в строки терминала half-блоками:
 * один символ несёт два пикселя по вертикали (верх+низ):
 * оба — `█`, только верх — `▀`, только низ — `▄`, пусто — пробел.
 * Поэтому лого высотой 7px занимает ровно 4 строки терминала
 * и остаётся монохромным (дефолтный цвет терминала, без ANSI-цветов).
 *
 * Чистый модуль без зависимости от Ink: используется и в TUI,
 * и в тестах. Все глифы — Geometric Shapes + пробел: есть в conhost,
 * ширина — ровно клетка.
 */

const FILLED = "#";

/** Высота шрифта в пикселях. Последний ряд упаковывается с пустым низом. */
export const LOGO_PIXEL_ROWS = 7;

/** Глифы 5×7: ровно 7 строк, каждая — ровно 5 символов `#`/`.`. */
const GLYPHS_5X7: Record<string, string[]> = {
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  h: ["#....", "#....", "#.##.", "#...#", "#...#", "#...#", "#...#"],
  i: ["..#..", ".....", "..#..", "..#..", "..#..", "..#..", ".###."],
  s: [".###.", "#...#", "#....", ".###.", "....#", "#...#", ".###."],
  e: [".###.", "#...#", "#....", "#####", "#....", "#...#", ".###."],
  l: ["..#..", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  d: ["...#.", "...#.", "...#.", "..###", ".#..#", "#...#", ".###."],
};

/** Марки 5px высотой: в сетке центрируются пустым рядом сверху и снизу. */
const MARKS_5PX: Record<string, string[]> = {
  "<": ["...#", "..#.", "#...", "..#.", "...#"],
  "/": ["..#", "..#", ".#.", ".#.", "#.."],
  ">": ["#...", ".#..", "...#", ".#..", "#..."],
};

/** Марка 5px → 7 рядов: пустой ряд сверху и снизу для центрирования. */
function markRows(mark: string): string[] {
  const body = MARKS_5PX[mark] ?? [];
  const width = body[0]?.length ?? 0;
  const empty = ".".repeat(width);
  return [empty, ...body, empty];
}

/** Пиксельная сетка логотипа: 7 строк из `#`/`.`. */
export function logoPixelGrid(): string[] {
  const wordmark = "ChiselCode";
  const rows: string[] = Array.from({ length: LOGO_PIXEL_ROWS }, () => "");
  const append = (glyphRows: string[], gap: number): void => {
    for (let row = 0; row < LOGO_PIXEL_ROWS; row += 1) {
      const cell = glyphRows[row] ?? "";
      rows[row] += (rows[row] ? ".".repeat(gap) : "") + cell;
    }
  };
  append(markRows("<"), 0);
  append(markRows("/"), 1);
  append(markRows(">"), 1);
  let firstLetter = true;
  for (const char of wordmark) {
    const glyph = GLYPHS_5X7[char];
    if (!glyph) continue;
    // Отступ группы от вордмарка — 3px, между буквами — 1px.
    append(glyph, firstLetter ? 3 : 1);
    firstLetter = false;
  }
  return rows;
}

/**
 * Упаковка пары пиксельных рядов в одну строку терминала.
 * Чистая функция для тестов: (верх, низ) → `█`/`▀`/`▄`/пробел.
 */
export function packPixelPair(top: string, bottom: string): string {
  const width = Math.max(top.length, bottom.length);
  let line = "";
  for (let col = 0; col < width; col += 1) {
    const upper = top[col] === FILLED;
    const lower = bottom[col] === FILLED;
    line += upper && lower ? "█" : upper ? "▀" : lower ? "▄" : " ";
  }
  return line;
}

/**
 * Строки логотипа для терминала: 4 строки half-блоками.
 * Правые пробелы подрезаны (Ink их всё равно не красит),
 * поэтому ширина строк ≤ LOGO_WIDTH.
 */
export function renderLogoRows(): string[] {
  const grid = logoPixelGrid();
  const lines: string[] = [];
  for (let row = 0; row < LOGO_PIXEL_ROWS; row += 2) {
    const line = packPixelPair(grid[row] ?? "", grid[row + 1] ?? "");
    lines.push(line.replace(/ +$/, ""));
  }
  return lines;
}

/** Ширина логотипа в клетках (максимум по строкам, без правых пробелов). */
export const LOGO_WIDTH: number = Math.max(
  ...renderLogoRows().map((line) => [...line].length),
);

/** Высота логотипа в строках терминала. */
export const LOGO_TERM_ROWS: number = renderLogoRows().length;
