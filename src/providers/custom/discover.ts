import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderDiagnostic, RegisteredProvider } from "../contracts.js";
import type { DriverRegistry } from "../drivers/index.js";
import { loadCustomProvider } from "./load.js";
export async function discoverCustomProviders(
  root: string,
  drivers: DriverRegistry,
): Promise<{
  providers: RegisteredProvider[];
  diagnostics: ProviderDiagnostic[];
}> {
  const providers: RegisteredProvider[] = [];
  const diagnostics: ProviderDiagnostic[] = [];
  try {
    if ((await lstat(root)).isSymbolicLink())
      return {
        providers,
        diagnostics: [
          {
            severity: "error",
            code: "unsafe_symlink",
            path: root,
            message: "Provider root must not be a symlink.",
          },
        ],
      };
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const directory = join(root, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          severity: "error",
          code: "unsafe_symlink",
          path: directory,
          message: "Symlink/junction provider directories are disabled.",
        });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const result = await loadCustomProvider(directory, drivers);
      if (result.provider) providers.push(result.provider);
      diagnostics.push(...result.diagnostics);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      diagnostics.push({
        severity: "error",
        code: "manifest_invalid",
        path: root,
        message: "Cannot read providers directory.",
      });
  }
  return { providers, diagnostics };
}
