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

/**
 * Резолвит путь из чата (команда /cwd) в корень проекта.
 * Принимает папку или файл (тогда проектом считается его папка),
 * относительные пути резолвятся от текущей папки проекта.
 */
export async function resolveProjectDir(
  input: string,
  currentCwd: string,
): Promise<string> {
  const trimmed = input
    .trim()
    .replace(/^["'](.+)["']$/, "$1")
    .trim();
  if (!trimmed) throw new Error("Укажите путь: /cwd <путь к папке или файлу>");
  const absolute = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(currentCwd, trimmed);
  let target = absolute;
  try {
    const info = await stat(absolute);
    if (!info.isDirectory()) target = dirname(absolute);
  } catch {
    throw new Error(`Путь не найден: ${trimmed}`);
  }
  try {
    return await realpath(target);
  } catch {
    return target;
  }
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
