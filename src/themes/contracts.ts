/** Declarative application themes. No renderer, layout or executable styles. */
export const THEME_TOKENS = [
  "bg",
  "surface",
  "raised",
  "border",
  "text",
  "muted",
  "accent",
  "green",
  "red",
  "yellow",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];
export interface ThemeContribution {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly variant: "light" | "dark";
  readonly colors: Readonly<Record<ThemeToken, string>>;
}
