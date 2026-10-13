import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalConfigV2Schema } from "../../src/config/schema.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ThemeCatalog, validateTheme } from "../../src/themes/catalog.js";
import { THEMES } from "../../src/ui/appearance.js";

const { label, description, ...colors } = THEMES.obsidian;
const theme = {
  id: "night",
  name: "Ночь",
  description,
  variant: "dark" as const,
  colors: { ...colors },
};
test("themes validate complete RGB palettes and contrast of text, selection, errors and permissions", () => {
  expect(validateTheme(theme).colors.text).toBe(colors.text);
  for (const token of ["text", "muted", "accent", "red", "yellow", "green"]) {
    expect(() =>
      validateTheme({
        ...theme,
        colors: { ...colors, [token]: colors.raised },
      }),
    ).toThrow();
  }
  expect(() =>
    validateTheme({ ...theme, colors: { ...colors, bg: "red" } }),
  ).toThrow();
  expect(() =>
    validateTheme({ ...theme, colors: { ...colors, surface: undefined } }),
  ).toThrow();
  expect(() =>
    validateTheme({ ...theme, colors: { ...colors, css: "display:none" } }),
  ).toThrow();
  expect(() => validateTheme({ ...theme, variant: "light" })).toThrow();
  expect(() =>
    validateTheme({ ...theme, colors: { ...colors, raised: colors.surface } }),
  ).toThrow();
  expect(() =>
    validateTheme({ ...theme, colors: { ...colors, border: colors.surface } }),
  ).toThrow();
  expect(() =>
    validateTheme({ ...theme, name: "\u001b]52;clipboard" }),
  ).toThrow();
});
test("catalog isolates invalid themes, freezes definitions, namespaces identity and preserves accent override", () => {
  const catalog = new ThemeCatalog();
  const input: import("../../src/themes/contracts.js").ThemeContribution & {
    colors: Record<import("../../src/themes/contracts.js").ThemeToken, string>;
  } = structuredClone(theme);
  catalog.accept("author.first", [
    input,
    { ...theme, id: "bad", colors: { ...colors, red: colors.bg } },
  ]);
  input.colors.text = "#000000";
  catalog.accept("author.second", [theme]);
  expect(catalog.list()).toHaveLength(6);
  expect(catalog.diagnostics).toHaveLength(1);
  expect(catalog.get("extension:author.first:night")?.colors.text).toBe(
    colors.text,
  );
  expect(
    Object.isFrozen(catalog.get("extension:author.first:night")?.colors),
  ).toBe(true);
  expect(
    catalog.palette("extension:author.first:night", "#123456").accent,
  ).toBe("#123456");
  expect(catalog.palette("extension:missing:night").bg).toBe(
    THEMES.obsidian.bg,
  );
  catalog.dispose();
});
test("application themes survive workspace close and selection uses backward compatible settings", async () => {
  let activations = 0;
  const root = await mkdtemp(join(tmpdir(), "chisel-theme-host-"));
  const host = new ExtensionHost([
    {
      id: "linked.themes",
      themes: [theme],
      activate() {
        activations++;
      },
    },
  ]);
  try {
    expect(host.themes.get("extension:linked.themes:night")).toBeDefined();
    expect(activations).toBe(0);
    await host.open(root);
    await host.closeWorkspace(root);
    expect(host.themes.get("extension:linked.themes:night")).toBeDefined();
    expect(activations).toBe(1);
    for (const selected of [
      "obsidian",
      "paper",
      "extension:linked.themes:night",
    ]) {
      expect(
        GlobalConfigV2Schema.parse({
          schemaVersion: 2,
          profiles: {},
          ui: { theme: selected },
        }).ui?.theme,
      ).toBe(selected);
    }
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
