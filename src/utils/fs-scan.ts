/**
 * Кросс-рантайм замена `Bun.Glob().scan()`: только `node:fs` + `node:path`.
 *
 * Под Bun работает как раньше, под Node 22+ — тоже (дверь к переезду
 * с Bun открыта, рантайм-специфичного кода в проекте больше нет).
 *
 * Семантика как у Bun.Glob по умолчанию:
 * - `*` и `?` не матчат dotfiles (имена с точки);
 * - несуществующая стартовая папка бросает ENOENT (однократно, как раньше);
 * - симлинки резолвятся следом (stat вместо lstat).
 */
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface ScanGlobOptions {
  /** Папка, от которой считаются относительные пути. */
  cwd: string;
  /** Возвращать абсолютные пути (иначе — относительно cwd). */
  absolute?: boolean;
  /** Только файлы; папки всё равно обходятся при `**`. */
  onlyFiles?: boolean;
}

/** Один сегмент пути (`*`/`?`, без `/` и `**`). */
function segmentToRegExp(segment: string): RegExp {
  const expression = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]");
  return new RegExp(`^${expression}$`);
}

/**
 * Матчит относительный путь против шаблона со `*`, `?` и `**`.
 * `**` покрывает ноль и более сегментов, поэтому шаблон с двойной
 * звездой находит и файлы в корне, а не только во вложенных папках.
 */
function matchGlob(relativePath: string, pattern: string): boolean {
  const pathSegments = relativePath.replaceAll("\\", "/").split("/");
  const patternSegments = pattern.replaceAll("\\", "/").split("/");
  return matchSegments(pathSegments, patternSegments);
}

function matchSegments(
  pathSegments: string[],
  patternSegments: string[],
): boolean {
  const head = patternSegments[0];
  if (head === undefined) return pathSegments.length === 0;
  if (head === "**") {
    for (let skip = 0; skip <= pathSegments.length; skip += 1) {
      if (matchSegments(pathSegments.slice(skip), patternSegments.slice(1)))
        return true;
    }
    return false;
  }
  const first = pathSegments[0];
  if (first === undefined) return false;
  if (!segmentToRegExp(head).test(first)) return false;
  return matchSegments(pathSegments.slice(1), patternSegments.slice(1));
}

export async function* scanGlob(
  pattern: string,
  options: ScanGlobOptions,
): AsyncGenerator<string, void, unknown> {
  const root = resolve(options.cwd);
  if (pattern.includes("**")) {
    yield* scanRecursive(root, root, pattern, options);
    return;
  }
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      // Как Bun.Glob: отсутствующая папка — ENOENT наружу.
      throw error;
    }
    throw error;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const absolute = join(root, name);
    const info = await stat(absolute).catch(() => undefined);
    if (!info) continue;
    if (options.onlyFiles && !info.isFile()) continue;
    if (!matchGlob(name, pattern)) continue;
    yield options.absolute ? absolute : name;
  }
}

async function* scanRecursive(
  root: string,
  current: string,
  pattern: string,
  options: ScanGlobOptions,
): AsyncGenerator<string, void, unknown> {
  let names: string[];
  try {
    names = await readdir(current);
  } catch (error) {
    if (current === root) throw error;
    // Папка исчезла прямо во время обхода — пропускаем поддерево.
    return;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const absolute = join(current, name);
    const info = await stat(absolute).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) {
      if (!options.onlyFiles) {
        const rel = relative(root, absolute);
        if (matchGlob(rel, pattern)) {
          yield options.absolute ? absolute : rel;
        }
      }
      yield* scanRecursive(root, absolute, pattern, options);
      continue;
    }
    if (!info.isFile()) continue;
    const rel = relative(root, absolute);
    if (!matchGlob(rel, pattern)) continue;
    yield options.absolute ? absolute : rel;
  }
}
