/** Compatibility entry for existing UI consumers; palettes are owned by core. */

export type {
  BuiltinThemeName,
  Palette,
  ThemeName,
} from "../themes/palettes.js";
export {
  isThemeName,
  THEME_NAMES,
  THEMES,
  themePalette,
} from "../themes/palettes.js";
