/** Terminal palettes. Obsidian is deliberately black, independent of terminal settings. */
export const THEMES = {
  obsidian: {
    label: "Obsidian",
    description: "чёрный · мятный акцент",
    bg: "#080a0b",
    surface: "#121719",
    raised: "#1b2224",
    border: "#334044",
    text: "#e9f0ee",
    muted: "#8e9f9c",
    accent: "#7ce3c3",
    green: "#83d4a3",
    red: "#f18d94",
    yellow: "#eac782",
  },
  graphite: {
    label: "Graphite",
    description: "угольный · голубой акцент",
    bg: "#11151c",
    surface: "#1b222c",
    raised: "#26313d",
    border: "#405061",
    text: "#e8edf4",
    muted: "#a3b0c0",
    accent: "#88c9ed",
    green: "#91d5ac",
    red: "#f1979a",
    yellow: "#eac986",
  },
  ember: {
    label: "Ember",
    description: "тёплый · янтарный акцент",
    bg: "#120e0c",
    surface: "#221916",
    raised: "#30231d",
    border: "#61483a",
    text: "#f5e9db",
    muted: "#baa897",
    accent: "#f3aa70",
    green: "#a9cd92",
    red: "#f18d82",
    yellow: "#efca79",
  },
  paper: {
    label: "Paper",
    description: "светлый · индиго акцент",
    bg: "#f3f1e9",
    surface: "#e7e5dd",
    raised: "#dcdcd3",
    border: "#b6bbb6",
    text: "#222b32",
    muted: "#52626b",
    accent: "#405fb6",
    green: "#277d59",
    red: "#ae4653",
    yellow: "#9c6e28",
  },
} as const;

export type ThemeName = keyof typeof THEMES;
export type Palette = { [K in keyof (typeof THEMES)["obsidian"]]: string };
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export function isThemeName(value: string): value is ThemeName {
  return value in THEMES;
}

export function themePalette(name: ThemeName, accent?: string): Palette {
  return {
    ...THEMES[name],
    ...(accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? { accent } : {}),
  };
}
