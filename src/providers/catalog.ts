import { ensureChiselHomeLayout, providersRootDir } from "../paths/home.js";
import type { ProviderDiagnostic } from "./contracts.js";
import { discoverCustomProviders } from "./custom/discover.js";
import { builtinDefinitions } from "./definitions/index.js";
import { createDriverRegistry, type DriverRegistry } from "./drivers/index.js";
import { ProviderRegistry } from "./registry.js";
export async function createProviderCatalog(
  options: { root?: string; drivers?: DriverRegistry } = {},
) {
  const drivers = options.drivers ?? createDriverRegistry();
  if (!options.root) await ensureChiselHomeLayout();
  const root = options.root ?? providersRootDir();
  const registry = new ProviderRegistry(drivers);
  for (const d of builtinDefinitions) registry.register(d);
  const discovered = await discoverCustomProviders(root, drivers);
  const diagnostics: ProviderDiagnostic[] = [...discovered.diagnostics];
  const groups = new Map<string, typeof discovered.providers>();
  for (const entry of discovered.providers) {
    const group = groups.get(entry.definition.id) ?? [];
    group.push(entry);
    groups.set(entry.definition.id, group);
  }
  for (const [id, entries] of groups) {
    if (entries.length > 1) {
      for (const entry of entries)
        diagnostics.push({
          severity: "error",
          code: "duplicate_id",
          providerId: id,
          path:
            entry.source.type === "user-manifest"
              ? entry.source.manifestPath
              : undefined,
          message: `Duplicate custom ID "${id}"; all conflicting packages are disabled.`,
        });
      continue;
    }
    const entry = entries[0];
    if (entry) registry.register(entry.definition, entry.source);
  }
  return { registry, drivers, diagnostics, root };
}
let startupCatalog: ReturnType<typeof createProviderCatalog> | undefined;
export function getProviderCatalog(): ReturnType<typeof createProviderCatalog> {
  startupCatalog ??= createProviderCatalog();
  return startupCatalog;
}
