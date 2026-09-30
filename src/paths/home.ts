import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Per-user ChiselCode data and installed binary on Windows. */
export function chiselHomeDir(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA?.trim();
    if (local) return join(local, "ChiselCode");
    return join(
      process.env.USERPROFILE ?? process.cwd(),
      "AppData",
      "Local",
      "ChiselCode",
    );
  }
  const data =
    process.env.XDG_DATA_HOME?.trim() ||
    join(process.env.HOME ?? process.cwd(), ".local", "share");
  return join(data, "chiselcode");
}

export const skillsRootDir = (): string => join(chiselHomeDir(), "skills");
export const bundledSkillsDir = (): string => join(skillsRootDir(), "bundled");
export const userSkillsDir = (): string => join(skillsRootDir(), "user");
export const sessionsRootDir = (): string => join(chiselHomeDir(), "sessions");
export const sessionProjectsDir = (): string =>
  join(sessionsRootDir(), "projects");

export const providersRootDir = (): string =>
  join(chiselHomeDir(), "providers");
export async function ensureChiselHomeLayout(): Promise<void> {
  for (const dir of [
    sessionsRootDir(),
    userSkillsDir(),
    bundledSkillsDir(),
    providersRootDir(),
  ])
    await mkdir(dir, { recursive: true, mode: 0o700 });
}
