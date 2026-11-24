/** Compatibility entry for existing UI consumers; palettes are owned by core. */

export type {
  BuiltinThemeName,
  Palette,
  ThemeName,
} from "../themes/palettes.js";
export {
  DEFAULT_THEME,
  isThemeName,
  THEME_NAMES,
  THEMES,
  themePalette,
} from "../themes/palettes.js";
