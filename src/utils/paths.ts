import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

export async function resolveProjectPath(
  projectRoot: string,
  candidate: string,
): Promise<string> {
  const root = await realpath(projectRoot);
  const absolute = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(root, candidate);
  const existing = await exists(absolute);
  const resolved = existing ? await realpath(absolute) : absolute;
  assertWithinProject(root, resolved, candidate);

  if (existing) return resolved;

  const parent = await nearestExistingParent(absolute);
  const resolvedParent = await realpath(parent);
  assertWithinProject(root, resolvedParent, candidate);
  return absolute;
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function assertWithinProject(
  root: string,
  path: string,
  candidate: string,
): void {
  const relation = relative(root, path);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !isAbsolute(relation))
  )
    return;
  throw new PathSecurityError(`Path is outside the project root: ${candidate}`);
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = path;
  while (!(await exists(current))) {
    const parent = dirname(current);
    if (parent === current)
      throw new PathSecurityError(`Path is outside the project root: ${path}`);
    current = parent;
  }
  return current;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function matchesPattern(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedPattern = pattern.replaceAll("\\", "/");
  const expression = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", "(?:.*/)?")
    .replaceAll("**", ".*")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]");
  return new RegExp(`^${expression}$`).test(normalizedPath);
}

export function isIgnored(
  relativePath: string,
  ignorePatterns: string[],
): boolean {
  return ignorePatterns.some((pattern) =>
    matchesPattern(relativePath, pattern),
  );
}
