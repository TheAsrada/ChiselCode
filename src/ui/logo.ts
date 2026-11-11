import { NativeImage, RGBA } from "@opentui/core";

/**
 * ASCII-арт логотип `<i>ChiselCode`, шрифт Coder Mini с TAAG
 * (patorjk, figlet.js). Встроен буквально: пробелы значимы.
 *
 * Только пробелы и блоки `█▀▄`, ширина — ровно клетка.
 * Coder Mini: Loic Cressot, MIT, patorjk/figlet.js/fonts/Coder Mini.flf.
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

/**
 * Исходный полублок соответствует одному ряду пикселей. Границы
 * штрихов передаются OpenTUI как часть изображения.
 */
export function createLogoImage(
  accent: string,
  text: string,
  background: string,
) {
  const accentColor = RGBA.fromHex(accent).toInts();
  const textColor = RGBA.fromHex(text).toInts();
  const paper = RGBA.fromHex(background).toInts();
  const height = LOGO_TERM_ROWS * 2;
  const pixels = new Uint8Array(LOGO_WIDTH * height * 4);
  for (const [row, line] of LOGO_ART_LINES.entries()) {
    for (let col = 0; col < LOGO_WIDTH; col++) {
      const glyph = line[col];
      const ink = col < 15 ? accentColor : textColor;
      const offset = (row * 2 * LOGO_WIDTH + col) * 4;
      pixels.set(glyph === "█" || glyph === "▀" ? ink : paper, offset);
      pixels.set(
        glyph === "█" || glyph === "▄" ? ink : paper,
        offset + LOGO_WIDTH * 4,
      );
    }
  }
  return NativeImage.fromRgba(pixels, LOGO_WIDTH, height);
}

/** Compact signature for the home screen. */
export const COMPACT_LOGO = [
  "▄▀▀ █▄█ █ ▄▀▀ ██▀ █   ▄▀▀ ▄▀▄ ▄▀▄ ██▀",
  "▀▄▄ █ █ █ ▄██ █▄▄ █▄▄ ▄██ ▀▄▀ █▄▀ █▄▄",
];
