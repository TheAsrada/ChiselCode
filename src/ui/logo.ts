// One character in this mask is one terminal cell. Filled cells are painted
// with backgrounds, so the logo does not depend on a font's block glyphs.
const LOGO_ART_LINES = [
  "  ## ## ##    ##### ##    ##             ##  #####          ##",
  " ##      ##   ##    ##       #####  #### ##  ##    ##### #####  ####",
  "##   ##   ##  ##    ##### ## ###   ##### ##  ##    ## ## ## ## #####",
  " ##  ##  ##   ##    ## ## ##   ### ##    ##  ##    ## ## ## ## ##",
  "  ## ## ##    ##### ## ## ## #####  #### ### ##### ##### #####  ####",
] as const;

export const LOGO_WORD_START = 14;
export const LOGO_WIDTH = Math.max(...LOGO_ART_LINES.map((row) => row.length));
export const LOGO_TERM_ROWS = LOGO_ART_LINES.length;

export function renderLogoRows(): readonly string[] {
  return LOGO_ART_LINES;
}

export function renderLogoRuns(row: string) {
  return [...row.matchAll(/#+/g)].map(({ 0: cells, index }) => ({
    column: index,
    width: cells.length,
  }));
}

/** Compact signature for the home screen. */
export const COMPACT_LOGO = [
  "▄▀▀ █▄█ █ ▄▀▀ ██▀ █   ▄▀▀ ▄▀▄ ▄▀▄ ██▀",
  "▀▄▄ █ █ █ ▄██ █▄▄ █▄▄ ▄██ ▀▄▀ █▄▀ █▄▄",
];
