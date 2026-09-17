import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalConfigPath } from "../config/load.js";
import { SLASH_COMMANDS } from "../ui/commands.js";
import { isInstalledBinary } from "./update.js";

/**
 * Свои slash-команды из markdown-файлов.
 *
 * Источники в порядке приоритета (первый найденный побеждает):
 * 1. `<проект>/.chisel/commands/*.md` — командa команды, можно коммитить;
 * 2. `<конфиг>/commands/*.md` — личные, рядом с config.json и сессиями;
 * 3. `commands/*.md` рядом с бинарником (из установщика) или в репо (dev).
 *
 * Формат файла: имя = имя файла `[a-z0-9-_]`; необязательный frontmatter
 * `---\ndescription: ...\n---`; дальше тело — шаблон промпта, `$ARGUMENTS`
 * заменяется аргументами после команды. Встроенные команды (`/settings`…)
 * перекрыть нельзя — они проверяются первыми.
 */

export type CustomCommandSource = "project" | "global" | "bundled";

export interface CustomCommand {
  /** Без слэша: `review` для `/review`. */
  name: string;
  description: string;
  prompt: string;
  source: CustomCommandSource;
}

export interface CustomCommandLocations {
  projectDir?: string;
  globalDir?: string;
  bundledDir?: string;
}

/** Имя файла команды: латиница, цифры, дефис, подчёркивание. */
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const MAX_COMMANDS_PER_DIR = 100;
const MAX_COMMAND_FILE_BYTES = 64 * 1024;

const BUILT_IN_NAMES = new Set(SLASH_COMMANDS.map((c) => c.name.slice(1)));

export function resolveCustomCommandDirs(
  cwd: string,
  overrides: CustomCommandLocations = {},
): { dir: string; source: CustomCommandSource }[] {
  // Порядок = приоритет: проектный перекрывает глобальный, глобальный —
  // встроенный. Первое найденное имя побеждает (см. loadCustomCommands).
  return [
    {
      dir: overrides.projectDir ?? join(cwd, ".chisel", "commands"),
      source: "project",
    },
    { dir: overrides.globalDir ?? defaultGlobalDir(), source: "global" },
    { dir: overrides.bundledDir ?? defaultBundledDir(), source: "bundled" },
  ];
}

function defaultBundledDir(): string {
  // Установленный бинарник везёт commands/ рядом с собой; в dev-режиме —
  // папка commands/ в корне репозитория.
  if (isInstalledBinary()) return join(dirname(process.execPath), "commands");
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "..", "commands");
  } catch {
    return "";
  }
}

function defaultGlobalDir(): string {
  try {
    return join(dirname(globalConfigPath()), "commands");
  } catch {
    return "";
  }
}

export function loadCustomCommands(
  cwd: string,
  overrides: CustomCommandLocations = {},
): CustomCommand[] {
  const found = new Map<string, CustomCommand>();
  for (const { dir, source } of resolveCustomCommandDirs(cwd, overrides)) {
    if (!dir) continue;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files.slice(0, MAX_COMMANDS_PER_DIR)) {
      if (!file.toLowerCase().endsWith(".md")) continue;
      const name = file.slice(0, -".md".length).toLowerCase();
      if (!COMMAND_NAME_RE.test(name)) continue;
      // Встроенные команды неперекрываемы; первое найденное (проектное)
      // важнее — остальные источники пропускаем.
      if (BUILT_IN_NAMES.has(name) || found.has(name)) continue;
      let text: string;
      try {
        text = readFileSync(join(dir, file), "utf8");
      } catch {
        continue;
      }
      if (text.length > MAX_COMMAND_FILE_BYTES) continue;
      const parsed = parseCommandFile(name, text);
      if (parsed) found.set(name, { ...parsed, source });
    }
  }
  // Порядок стабилен: сначала проектные (перекрывающие), потом остальные.
  const order: Record<CustomCommandSource, number> = {
    project: 0,
    global: 1,
    bundled: 2,
  };
  return [...found.values()].sort((a, b) => order[a.source] - order[b.source]);
}

export function parseCommandFile(
  name: string,
  text: string,
): { name: string; description: string; prompt: string } | undefined {
  let rest = text.replace(/^\uFEFF/, "");
  let description = "";
  if (rest.startsWith("---")) {
    const fence = rest.indexOf("\n---", 3);
    if (fence !== -1) {
      const header = rest.slice(3, fence);
      rest = rest.slice(fence + "\n---".length);
      const match = /^description\s*:\s*(.+)$/im.exec(header);
      if (match?.[1]) description = match[1].trim();
    }
  }
  const prompt = rest.trim();
  if (!prompt) return undefined;
  if (!description) {
    const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
    description =
      firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  }
  return { name, description, prompt };
}

/**
 * Подставляет аргументы в шаблон. `$ARGUMENTS` заменяется как есть;
 * если плейсхолдера нет, аргументы дописываются с новой строки.
 */
export function expandCustomCommand(
  command: CustomCommand,
  args: string,
): string {
  const trimmed = args.trim();
  if (command.prompt.includes("$ARGUMENTS"))
    return command.prompt.split("$ARGUMENTS").join(trimmed);
  if (!trimmed) return command.prompt;
  return `${command.prompt}\n\n${trimmed}`;
}
