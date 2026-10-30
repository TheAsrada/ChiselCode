import { join } from "node:path";

/** Shared by configuration loading and workspace admission, including fallback environments. */
export function globalConfigPath(): string {
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ??
        join(process.env.USERPROFILE ?? process.cwd(), ".config"))
      : (process.env.XDG_CONFIG_HOME ??
        join(process.env.HOME ?? process.cwd(), ".config"));
  return join(base, "chiselcode", "config.json");
}
