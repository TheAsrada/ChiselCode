import { z } from "zod";
import { frozenClone } from "../extensions/lifecycle.js";
import { SecretRedactor } from "../security/redaction.js";
import { THEME_TOKENS, type ThemeContribution } from "./contracts.js";
import { type Palette, THEMES, type ThemeName } from "./palettes.js";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const plain = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
export const ThemeContributionSchema = z.strictObject({
  id: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9_-]*$/),
  name: plain(120),
  description: plain(2000),
  variant: z.enum(["light", "dark"]),
  colors: z.strictObject(
    Object.fromEntries(THEME_TOKENS.map((key) => [key, color])) as Record<
      (typeof THEME_TOKENS)[number],
      typeof color
    >,
  ),
});
function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
export function contrast(first: string, second: string): number {
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function validateTheme(value: unknown): ThemeContribution {
  const theme = ThemeContributionSchema.parse(value);
  for (const background of ["bg", "surface", "raised"] as const) {
    for (const [foreground, minimum] of [
      ["text", 4.5],
      ["muted", 3],
      ["accent", 3],
      ["red", 3],
      ["yellow", 3],
      ["green", 3],
    ] as const)
      if (
        contrast(theme.colors[foreground], theme.colors[background]) < minimum
      )
        throw new Error(`Недостаточный контраст ${foreground}/${background}.`);
  }
  if (
    contrast(theme.colors.surface, theme.colors.raised) < 1.05 ||
    contrast(theme.colors.border, theme.colors.surface) < 1.5
  )
    throw new Error("Выделение и границы должны различаться.");
  const lightBackground = luminance(theme.colors.bg) > 0.5;
  if ((theme.variant === "light") !== lightBackground)
    throw new Error("Вариант темы не соответствует фону.");
  const redactor = new SecretRedactor();
  return frozenClone({
    ...theme,
    name: redactor.text(theme.name),
    description: redactor.text(theme.description),
  });
}
export interface CatalogTheme extends ThemeContribution {
  readonly key: ThemeName;
  readonly extensionId?: string;
  readonly source: string;
}
/** Application-owned cache. Closing a workspace never removes its immutable themes. */
export class ThemeCatalog {
  private readonly themes = new Map<ThemeName, CatalogTheme>();
  private readonly listeners = new Set<() => void>();
  readonly diagnostics: string[] = [];
  constructor() {
    for (const [id, palette] of Object.entries(THEMES)) {
      const colors = Object.fromEntries(
        THEME_TOKENS.map((key) => [key, palette[key]]),
      ) as ThemeContribution["colors"];
      this.themes.set(
        id as ThemeName,
        frozenClone({
          id,
          key: id as ThemeName,
          name: palette.label,
          description: palette.description,
          variant: id === "paper" ? "light" : "dark",
          colors,
          source: "ChiselCode",
        }),
      );
    }
  }
  accept(
    extensionId: string,
    definitions: readonly unknown[],
    source = extensionId,
  ): void {
    if (
      !Array.isArray(definitions) ||
      definitions.length > 16 ||
      this.themes.size + definitions.length > 260
    ) {
      this.diagnostics.push(`Темы ${extensionId}: превышен лимит каталога.`);
      return;
    }
    const seen = new Set<string>();
    let changed = false;
    for (const definition of definitions) {
      try {
        const theme = validateTheme(definition);
        if (seen.has(theme.id))
          throw new Error("Повторяющийся идентификатор темы.");
        seen.add(theme.id);
        const key: ThemeName = `extension:${extensionId}:${theme.id}`;
        if (this.themes.has(key)) continue;
        this.themes.set(
          key,
          frozenClone({
            ...theme,
            key,
            extensionId,
            source: new SecretRedactor()
              .text(source)
              .replace(/[\p{Cc}\p{Cf}]/gu, " ")
              .slice(0, 120),
          }),
        );
        changed = true;
      } catch {
        this.diagnostics.push(
          `Тема ${extensionId} отклонена: некорректная палитра или недостаточный контраст.`,
        );
      }
    }
    if (changed) for (const listener of this.listeners) listener();
  }
  list(): readonly CatalogTheme[] {
    return [...this.themes.values()];
  }
  get(key: string): CatalogTheme | undefined {
    return this.themes.get(key as ThemeName);
  }
  palette(key: ThemeName, accent?: string): Palette {
    const theme = this.get(key) ?? this.get("obsidian")!;
    return {
      ...theme.colors,
      label: theme.name,
      description: theme.description,
      variant: theme.variant,
      ...(accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? { accent } : {}),
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose(): void {
    this.listeners.clear();
    this.themes.clear();
  }
}
