import type { ChiselExtension } from "../extensions/contracts.js";

/** Loader-only metadata bridge, never a public callback contribution. */
const sources = new WeakMap<
  ChiselExtension,
  () => { themes: readonly unknown[]; name: string } | undefined
>();
export function setThemeSource(
  definition: ChiselExtension,
  source: () => { themes: readonly unknown[]; name: string } | undefined,
): void {
  sources.set(definition, source);
}
export function themeSource(definition: ChiselExtension) {
  return sources.get(definition)?.();
}
export function inheritThemeSource(
  from: ChiselExtension,
  to: ChiselExtension,
): void {
  const source = sources.get(from);
  if (source) sources.set(to, source);
}
