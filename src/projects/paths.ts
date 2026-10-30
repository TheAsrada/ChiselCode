import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isInstalledBinary } from "../commands/update.js";
import { globalConfigPath } from "../paths/config.js";
import { chiselHomeDir } from "../paths/home.js";
import { credentialDirectory } from "../security/credentials.js";

export interface ApplicationPaths {
  readonly home: string;
  readonly privateRoots: readonly string[];
}
const privateConfigurations = new Set<string>();
export async function registerApplicationPrivatePath(
  path: string,
): Promise<void> {
  privateConfigurations.add(await canonicalApplicationPath(path));
}

export function pathIdentity(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function pathContains(parent: string, candidate: string): boolean {
  const rel = relative(pathIdentity(parent), pathIdentity(candidate));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** Resolve existing ancestors too: a not-yet-created private child may have an alias. */
export async function canonicalApplicationPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return resolve(
      await canonicalApplicationPath(parent),
      relative(parent, absolute),
    );
  }
}

/** Application-owned locations only; never the whole user or executable search directory. */
export async function applicationPaths(
  configPath?: string,
): Promise<ApplicationPaths> {
  const home = await canonicalApplicationPath(chiselHomeDir());
  const roots = [home, credentialDirectory(), globalConfigPath()];
  if (configPath)
    privateConfigurations.add(await canonicalApplicationPath(configPath));
  roots.push(...privateConfigurations);
  if (isInstalledBinary()) {
    roots.push(
      process.execPath,
      join(dirname(process.execPath), "skills", "bundled"),
    );
    // Linux/macOS packages share /usr/bin or /usr/local/bin with other tools.
    // Only Windows' own installer layout identifies a dedicated install folder.
    if (
      process.platform === "win32" &&
      (
        await stat(join(dirname(process.execPath), "Uninstall.exe")).catch(
          () => undefined,
        )
      )?.isFile()
    )
      roots.push(dirname(process.execPath));
  }
  return Object.freeze({
    home,
    privateRoots: Object.freeze([
      ...new Set(await Promise.all(roots.map(canonicalApplicationPath))),
    ]),
  });
}

export function isPrivatePath(paths: ApplicationPaths, path: string): boolean {
  return (
    paths.privateRoots.some((root) => pathContains(root, path)) ||
    [...privateConfigurations].some((root) => pathContains(root, path))
  );
}

/** Metadata classification only; execution still requires Git/registry admission. */
export function managedWorkspaceCandidate(home: string, root: string): boolean {
  const trees = join(home, "worktrees");
  if (!pathContains(trees, root)) return false;
  const parts = relative(pathIdentity(trees), pathIdentity(root)).split(sep);
  return (
    parts.length === 3 &&
    /^[a-f0-9]{64}$/i.test(parts[0] ?? "") &&
    parts[1] === "trees" &&
    /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(parts[2] ?? "")
  );
}
