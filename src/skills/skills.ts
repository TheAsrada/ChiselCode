import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isInstalledBinary } from "../commands/update.js";
import { globalConfigPath } from "../config/load.js";
import { SLASH_COMMANDS } from "../ui/commands.js";

/**
 * Скиллы в духе Claude Code и открытого стандарта Agent Skills
 * (agentskills.io): папка с обязательным `SKILL.md` (YAML-frontmatter
 * с `name`/`description` + markdown-инструкции) и необязательными
 * `scripts/`, `references/`, `assets/`.
 *
 * Прогрессивное раскрытие: в системный промпт попадает только каталог
 * (имя + описание ~100 токенов на скилл), полный SKILL.md агент читает
 * сам через read_file, когда задача совпадает с описанием, а вложенные
 * файлы — по мере необходимости. Вручную скилл вызывается как /имя.
 *
 * Источники в порядке приоритета (первый найденный побеждает):
 * 1. `<проект>/.chisel/skills/<имя>/SKILL.md` — свои, можно коммитить;
 * 2. `<проект>/.agents/skills/<имя>/SKILL.md` — кросс-клиентский стандарт,
 *    те же скиллы подхватывают другие агенты;
 * 3. личная папка (`%LOCALAPPDATA%\ChiselCode\skills` на Windows) — для всех
 *    проектов; ВСЕ новые скиллы сохраняются только сюда;
 * 4. `<конфиг>/skills/<имя>/SKILL.md` — legacy-личные, рядом с config.json;
 * 5. `skills/<имя>/SKILL.md` рядом с бинарником (из установщика)
 *    или в репо (dev) — встроенные из коробки.
 *
 * Встроенные slash-команды (`/settings`…) перекрыть нельзя.
 */

export type SkillSource =
  | "project"
  | "shared"
  | "personal"
  | "global"
  | "bundled";

export interface Skill {
  /** Без слэша: `review` для `/review`. Совпадает с именем папки. */
  name: string;
  /** Когда вызывать: триггер для агента и строка в /skills и подсказках. */
  description: string;
  /** Тело SKILL.md после frontmatter — инструкции для агента. */
  instructions: string;
  /** Предодобренные инструменты скилла (experimental, из frontmatter). */
  allowedTools?: string[];
  /**
   * Можно ли вызывать как /имя. `user-invocable: false` прячет скилл из
   * slash-команд (как skill-creator): он остаётся в каталоге для агента
   * и в браузере /skills, где его можно задействовать.
   */
  userInvocable?: boolean;
  source: SkillSource;
  /** Папка скилла: там же scripts/, references/, assets/. */
  dir: string;
}

export interface SkillLocations {
  projectDir?: string;
  sharedDir?: string;
  personalDir?: string;
  globalDir?: string;
  bundledDir?: string;
}

/**
 * Личная папка скиллов для всех проектов — ЕДИНСТВЕННОЕ место, куда
 * сохраняются новые скиллы: `%LOCALAPPDATA%\ChiselCode\skills` на Windows,
 * `$XDG_DATA_HOME/chiselcode/skills` (или `~/.local/share/...`) elsewhere.
 */
export function personalSkillsDir(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA?.trim();
    if (local) return join(local, "ChiselCode", "skills");
    return join(
      process.env.USERPROFILE ?? process.cwd(),
      "AppData",
      "Local",
      "ChiselCode",
      "skills",
    );
  }
  const dataHome =
    process.env.XDG_DATA_HOME?.trim() ||
    join(process.env.HOME ?? process.cwd(), ".local", "share");
  return join(dataHome, "chiselcode", "skills");
}

/** Имя скилла по спеке: латиница/цифры/дефис, без висячих и двойных дефисов. */
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_SKILLS_PER_DIR = 100;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const SKILL_FILENAME = "SKILL.md";

const BUILT_IN_NAMES = new Set(SLASH_COMMANDS.map((c) => c.name.slice(1)));

export function resolveSkillDirs(
  cwd: string,
  overrides: SkillLocations = {},
): { dir: string; source: SkillSource }[] {
  return [
    {
      dir: overrides.projectDir ?? join(cwd, ".chisel", "skills"),
      source: "project",
    },
    {
      dir: overrides.sharedDir ?? join(cwd, ".agents", "skills"),
      source: "shared",
    },
    {
      dir: overrides.personalDir ?? personalSkillsDir(),
      source: "personal",
    },
    { dir: overrides.globalDir ?? defaultGlobalDir(), source: "global" },
    { dir: overrides.bundledDir ?? defaultBundledDir(), source: "bundled" },
  ];
}

function defaultBundledDir(): string {
  // Установленный бинарник везёт skills/ рядом с собой; в dev-режиме —
  // папка skills/ в корне репозитория.
  if (isInstalledBinary()) return join(dirname(process.execPath), "skills");
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "..", "skills");
  } catch {
    return "";
  }
}

function defaultGlobalDir(): string {
  try {
    return join(dirname(globalConfigPath()), "skills");
  } catch {
    return "";
  }
}

export function loadSkills(
  cwd: string,
  overrides: SkillLocations = {},
): Skill[] {
  const found = new Map<string, Skill>();
  for (const { dir, source } of resolveSkillDirs(cwd, overrides)) {
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, MAX_SKILLS_PER_DIR)) {
      if (entry.startsWith(".")) continue;
      const skillDir = join(dir, entry);
      let isDirectory = false;
      try {
        isDirectory = statSync(skillDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      const name = entry.toLowerCase();
      if (!SKILL_NAME_RE.test(name) || BUILT_IN_NAMES.has(name)) continue;
      if (found.has(name)) continue;
      let text: string;
      try {
        text = readFileSync(join(skillDir, SKILL_FILENAME), "utf8");
      } catch {
        continue;
      }
      if (text.length > MAX_SKILL_FILE_BYTES) continue;
      const parsed = parseSkillFile(name, text);
      if (parsed) found.set(name, { ...parsed, source, dir: skillDir });
    }
  }
  // Порядок стабилен: сначала проектные (перекрывающие), потом остальные.
  const order: Record<SkillSource, number> = {
    project: 0,
    shared: 1,
    personal: 2,
    global: 3,
    bundled: 4,
  };
  return [...found.values()].sort((a, b) => order[a.source] - order[b.source]);
}

export interface ParsedSkill {
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string[];
  userInvocable?: boolean;
}

/** Скиллы, доступные как /команды (без `user-invocable: false`). */
export function invocableSkills(skills: Skill[]): Skill[] {
  return skills.filter((skill) => skill.userInvocable !== false);
}

/**
 * Разбирает SKILL.md: YAML-frontmatter (`---`…`---`) + markdown-тело.
 * Мягкий режим: без frontmatter имя берётся из папки, описание — из первой
 * непустой строки тела. Пустые/битые скиллы отсекаются (undefined).
 */
export function parseSkillFile(
  dirName: string,
  text: string,
): ParsedSkill | undefined {
  const normalized = text.replace(/^\uFEFF/, "");
  const { data, body } = splitFrontmatter(normalized);
  const instructions = body.trim();
  if (!instructions) return undefined;
  const frontName = String(data.name ?? "")
    .trim()
    .toLowerCase();
  const fallbackName = dirName.trim().toLowerCase();
  // По спеке имя обязано совпадать с папкой: явное расхождение —
  // malformed-скилл, пропускаем, а не гадаем. Без имени — имя папки.
  if (frontName && frontName !== fallbackName) return undefined;
  const name = frontName || fallbackName;
  if (!SKILL_NAME_RE.test(name)) return undefined;
  const firstLine = instructions.split("\n", 1)[0]?.trim() ?? "";
  let description = String(data.description ?? "").trim();
  if (!description) description = firstLine;
  if (!description) return undefined;
  if (description.length > 1024) description = `${description.slice(0, 1023)}…`;
  const allowedRaw = String(data["allowed-tools"] ?? "").trim();
  const allowedTools = allowedRaw
    ? allowedRaw.split(/\s+/).filter(Boolean)
    : undefined;
  const invocableRaw = String(data["user-invocable"] ?? "")
    .trim()
    .toLowerCase();
  const userInvocable = invocableRaw === "false" ? false : undefined;
  return {
    name,
    description,
    instructions,
    ...(allowedTools?.length ? { allowedTools } : {}),
    ...(userInvocable === false ? { userInvocable } : {}),
  };
}

interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/**
 * Минимальный парсер YAML-подмножества из frontmatter: `key: value`
 * (кавычки снимаются), блочные скаляры `>`/`|` и один уровень вложенного
 * маппинга (для `metadata:`). Этого хватает на все поля спеки; полный YAML
 * сюда тащить нечем и незачем.
 */
export function splitFrontmatter(text: string): Frontmatter {
  const lines = text.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (first !== "---") return { data: {}, body: text };
  let fence = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (line === "---" || line === "...") {
      fence = i;
      break;
    }
  }
  if (fence === -1) return { data: {}, body: text };
  const data: Record<string, string> = {};
  const head = lines.slice(1, fence);
  let i = 0;
  while (i < head.length) {
    const line = head[i] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i += 1;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match?.[1]) {
      i += 1;
      continue;
    }
    const key = match[1];
    const rest = (match[2] ?? "").trim();
    if (/^[>|][+-]?$/.test(rest)) {
      // Блочный скаляр: забираем все строки с отступом.
      const chunk: string[] = [];
      i += 1;
      while (i < head.length && /^\s+\S/.test(head[i] ?? "")) {
        chunk.push((head[i] ?? "").replace(/^\s+/, ""));
        i += 1;
      }
      data[key] =
        rest[0] === ">"
          ? foldBlock(chunk)
          : chunk.join("\n").replace(/\n+$/, "");
      continue;
    }
    if (rest === "") {
      // Возможно вложенный маппинг (metadata:): собираем `sub: value`.
      const nested: string[] = [];
      let j = i + 1;
      while (j < head.length && /^\s+[A-Za-z0-9_-]+\s*:/.test(head[j] ?? "")) {
        nested.push((head[j] ?? "").trim());
        j += 1;
      }
      if (nested.length > 0) {
        data[key] = nested.join("\n");
        i = j;
        continue;
      }
    }
    data[key] = unquote(rest);
    i += 1;
  }
  return { data, body: lines.slice(fence + 1).join("\n") };
}

/** Схлопывание `>`-блока: строки в абзац через пробел, пустые — разрыв. */
function foldBlock(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) paragraphs.push(current.join(" "));
    current = [];
  };
  for (const line of lines) {
    if (!line.trim()) flush();
    else current.push(line.trim());
  }
  flush();
  return paragraphs.join("\n\n");
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'"))
      return value.slice(1, -1);
  }
  return value;
}

/**
 * Подставляет аргументы в инструкции. `$ARGUMENTS` заменяется как есть;
 * если плейсхолдера нет, аргументы дописываются с новой строки.
 */
export function expandSkill(skill: Skill, args: string): string {
  const trimmed = args.trim();
  if (skill.instructions.includes("$ARGUMENTS"))
    return skill.instructions.split("$ARGUMENTS").join(trimmed);
  if (!trimmed) return skill.instructions;
  return `${skill.instructions}\n\n${trimmed}`;
}

/** Маркер начала блока задействованных скиллов в запросе к агенту. */
export const ACTIVE_SKILLS_HEADER = "◈ Активные скиллы:";
/** Маркер конца блока: всё между ним и шапкой — инструкции, не задача. */
export const ACTIVE_SKILLS_FOOTER = "◈ Конец скиллов.";

/**
 * Прикладывает инструкции задействованных скиллов к запросу. Пустой список —
 * запрос как есть. Маркированный блок нужен, чтобы журнал при /resume мог
 * скрыть инструкции и показать только саму задачу.
 */
export function buildActiveSkillsPrompt(
  active: Skill[],
  prompt: string,
): string {
  if (active.length === 0) return prompt;
  const names = active.map((skill) => `/${skill.name}`).join(", ");
  const bodies = active
    .map((skill) => expandSkill(skill, ""))
    .join("\n\n---\n\n");
  return `${ACTIVE_SKILLS_HEADER} ${names}\n${bodies}\n${ACTIVE_SKILLS_FOOTER}\n\n${prompt}`;
}

/** Вырезает блок задействованных скиллов, оставляя саму задачу (для вида). */
export function stripActiveSkillsBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith(ACTIVE_SKILLS_HEADER),
  );
  const end = lines.findIndex((line) => line.startsWith(ACTIVE_SKILLS_FOOTER));
  if (start === -1 || end === -1 || end < start) return text;
  return lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "");
}

/**
 * Каталог скиллов для системного промпта (уровень 1 прогрессивного
 * раскрытия): только имя + описание + путь. Полный SKILL.md агент читает
 * сам через read_file, когда задача совпадает с описанием.
 */
export function skillsCatalogPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map(
    (skill) => `- /${skill.name} — ${skill.description} (файл: ${skill.dir})`,
  );
  return [
    "Доступные скиллы — специализированные инструкции под задачи:",
    ...lines,
    "Если задача пользователя совпадает с описанием скилла: прочитай его SKILL.md инструментом read_file и строго следуй инструкциям; вложенные файлы скилла (scripts/, references/, assets/) открывай по мере необходимости. Скилл можно также вызвать напрямую командой /имя.",
  ].join("\n");
}
