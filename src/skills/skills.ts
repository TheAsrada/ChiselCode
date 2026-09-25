import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInstalledBinary } from "../commands/update.js";
import { globalConfigPath } from "../config/load.js";
import {
  bundledSkillsDir,
  chiselHomeDir,
  skillsRootDir,
  userSkillsDir,
} from "../paths/home.js";
import { SLASH_COMMANDS } from "../ui/commands.js";

/**
 * Скиллы в духе Claude Code и открытого стандарта Agent Skills
 * (agentskills.io): папка с обязательным `SKILL.md` (YAML-frontmatter
 * с `name`/`description` + markdown-инструкции) и необязательными
 * `scripts/`, `references/`, `assets/`.
 *
 * Прогрессивное раскрытие: в системный промпт попадает только каталог
 * (имя + описание ~100 токенов на скилл), полный SKILL.md агент читает
 * сам через load_skill по имени, когда задача совпадает с описанием.
 * Вручную скилл вызывается как /имя.
 *
 * Живые источники: ChiselCode Home/skills/bundled и /skills/user.
 * Старые project/personal/global каталоги используются только для
 * недеструктивной миграции в /skills/user.
 *
 * Встроенные slash-команды (`/settings`…) перекрыть нельзя.
 */

export type SkillSource = "user" | "bundled";

export interface Skill {
  /** Без слэша: `code-review` для `/code-review`. Совпадает с папкой. */
  name: string;
  /** Когда вызывать: триггер для агента и строка в /skills и подсказках. */
  description: string;
  /** Тело SKILL.md после frontmatter — инструкции для агента. */
  instructions: string;
  /** Предодобренные инструменты скилла (experimental, из frontmatter). */
  allowedTools?: string[];
  /**
   * Можно ли вызывать как /имя. `user-invocable: false` прячет скилл из
   * slash-команд, но не из каталога для агента.
   */
  userInvocable?: boolean;
  /** Ручной вызов разрешён, но автоматическая загрузка моделью запрещена. */
  disableModelInvocation?: boolean;
  source: SkillSource;
  /** Папка скилла: там же scripts/, references/, assets/. */
  dir: string;
}

export interface SkillLocations {
  /** Test/portable override; the application uses chiselHomeDir(). */
  homeDir?: string;
  /** Source files shipped with the app, copied into home/skills/bundled. */
  bundledSourceDir?: string;
  /** Override legacy sources for isolated migration tests. */
  legacyDirs?: string[];
  onDiagnostic?: (message: string) => void;
}

/** Имя скилла по спеке: латиница/цифры/дефис, без висячих и двойных дефисов. */
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_SKILLS_PER_DIR = 100;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const SKILL_FILENAME = "SKILL.md";
export const RESERVED_BUNDLED_SKILL_NAMES = new Set([
  "skill-creator",
  "code-review",
]);

const BUILT_IN_NAMES = new Set(SLASH_COMMANDS.map((c) => c.name.slice(1)));
export function isReservedSkillName(name: string): boolean {
  return RESERVED_BUNDLED_SKILL_NAMES.has(name) || BUILT_IN_NAMES.has(name);
}

function bundledSourceDir(): string {
  if (isInstalledBinary())
    return join(dirname(process.execPath), "skills", "bundled");
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "..", "skills", "bundled");
  } catch {
    return "";
  }
}

export function loadSkills(
  cwd: string,
  overrides: SkillLocations = {},
): Skill[] {
  const home = overrides.homeDir ?? chiselHomeDir();
  const root = overrides.homeDir ? join(home, "skills") : skillsRootDir();
  const bundled = overrides.homeDir
    ? join(root, "bundled")
    : bundledSkillsDir();
  const user = overrides.homeDir ? join(root, "user") : userSkillsDir();
  const diagnostic = overrides.onDiagnostic ?? reportSkillDiagnostic;
  ensureSkillDirs(home, root, bundled, user);
  installBundledSkills(
    overrides.bundledSourceDir ?? bundledSourceDir(),
    bundled,
    diagnostic,
  );
  migrateLegacySkills(cwd, user, root, overrides.legacyDirs, diagnostic);
  const found = new Map<string, Skill>();
  for (const { dir, source } of [
    { dir: user, source: "user" },
    { dir: bundled, source: "bundled" },
  ] as const) {
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
        const info = lstatSync(skillDir);
        isDirectory = info.isDirectory() && !info.isSymbolicLink();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      const name = entry.toLowerCase();
      if (!SKILL_NAME_RE.test(name) || BUILT_IN_NAMES.has(name)) continue;
      if (source === "user" && RESERVED_BUNDLED_SKILL_NAMES.has(name)) {
        diagnostic(
          `Пользовательский скилл «${name}» игнорируется: имя зарезервировано встроенным скиллом.`,
        );
        continue;
      }
      if (found.has(name)) continue;
      let text: string;
      try {
        const info = lstatSync(join(skillDir, SKILL_FILENAME));
        if (!info.isFile() || info.isSymbolicLink()) continue;
        text = readFileSync(join(skillDir, SKILL_FILENAME), "utf8");
      } catch {
        continue;
      }
      if (text.length > MAX_SKILL_FILE_BYTES) continue;
      const parsed = parseSkillFile(name, text);
      if (parsed) found.set(name, { ...parsed, source, dir: skillDir });
    }
  }
  return [...found.values()];
}

const reportedDiagnostics = new Set<string>();
function reportSkillDiagnostic(message: string): void {
  if (reportedDiagnostics.has(message)) return;
  reportedDiagnostics.add(message);
  process.stderr.write(`ChiselCode: ${message}\n`);
}

function ensureSkillDirs(...paths: string[]): void {
  for (const path of paths) {
    mkdirSync(path, { recursive: true });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Unsafe ChiselCode skills directory: ${path}`);
  }
}

function installBundledSkills(
  source: string,
  destination: string,
  diagnostic: (message: string) => void,
): void {
  if (source === destination) return;
  if (!existsSync(source)) return;
  for (const name of RESERVED_BUNDLED_SKILL_NAMES) {
    const from = join(source, name, SKILL_FILENAME);
    const toDir = join(destination, name);
    const to = join(toDir, SKILL_FILENAME);
    try {
      if (!lstatSync(from).isFile()) continue;
      ensureSkillDirs(toDir);
      const text = readFileSync(from, "utf8");
      if (pathExistsNoFollowSync(to)) {
        const info = lstatSync(to);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error(`Unsafe bundled skill file: ${to}`);
        if (readFileSync(to, "utf8") === text) continue;
      }
      const temporary = join(toDir, `.SKILL-${randomUUID()}.tmp`);
      writeFileSync(temporary, text, { flag: "wx" });
      renameSync(temporary, to);
    } catch (error) {
      diagnostic(
        `Не удалось обновить встроенный скилл «${name}»: ${String(error)}`,
      );
    }
  }
}

/** Copy legacy user skills once into the central user directory; originals stay put. */
function migrateLegacySkills(
  cwd: string,
  destination: string,
  legacyPersonalRoot: string,
  overrideDirs: string[] | undefined,
  diagnostic: (message: string) => void,
): void {
  const sources = overrideDirs ?? [
    join(cwd, ".chisel", "skills"),
    join(cwd, ".agents", "skills"),
    legacyPersonalRoot,
    join(dirname(globalConfigPath()), "skills"),
    join(dirname(process.execPath), "skills"),
  ];
  for (const source of new Set(sources)) {
    const markerDir = join(dirname(destination), ".migrations");
    const sourceKey = resolve(source);
    const marker = join(
      markerDir,
      createHash("sha256")
        .update(
          process.platform === "win32" ? sourceKey.toLowerCase() : sourceKey,
        )
        .digest("hex"),
    );
    if (pathExistsNoFollowSync(marker)) continue;
    let entries: string[];
    try {
      const info = lstatSync(source);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      entries = readdirSync(source);
    } catch {
      continue;
    }
    let sawCandidate = false;
    let complete = true;
    for (const entry of entries) {
      const name = entry.toLowerCase();
      if (!SKILL_NAME_RE.test(name) || entry === "user" || entry === "bundled")
        continue;
      sawCandidate = true;
      const from = join(source, entry);
      const to = join(destination, name);
      if (BUILT_IN_NAMES.has(name)) {
        complete = false;
        diagnostic(
          `Старый скилл «${name}» из ${source} не перенесён: имя занято встроенной командой.`,
        );
        continue;
      }
      if (RESERVED_BUNDLED_SKILL_NAMES.has(name)) {
        if (
          source !== legacyPersonalRoot &&
          source !== join(dirname(process.execPath), "skills")
        ) {
          complete = false;
          diagnostic(
            `Старый скилл «${name}» из ${source} не перенесён: имя зарезервировано встроенным скиллом.`,
          );
        }
        continue;
      }
      if (pathExistsNoFollowSync(to)) {
        try {
          if (
            readFileSync(join(from, SKILL_FILENAME), "utf8") ===
            readFileSync(join(to, SKILL_FILENAME), "utf8")
          )
            continue;
        } catch {
          /* Keep the conflict diagnostic below. */
        }
        complete = false;
        diagnostic(
          `Старый скилл «${name}» из ${source} оставлен на месте: ${to} уже существует.`,
        );
        continue;
      }
      try {
        assertRegularSkillTree(from);
        if (
          !parseSkillFile(
            name,
            readFileSync(join(from, SKILL_FILENAME), "utf8"),
          )
        ) {
          complete = false;
          diagnostic(
            `Старый скилл «${name}» из ${source} не перенесён: некорректный SKILL.md.`,
          );
          continue;
        }
        const temporary = join(destination, `.migration-${randomUUID()}`);
        try {
          copySkillTree(from, temporary);
          if (!pathExistsNoFollowSync(to)) renameSync(temporary, to);
        } finally {
          if (existsSync(temporary))
            rmSync(temporary, { recursive: true, force: true });
        }
      } catch (error) {
        complete = false;
        diagnostic(
          `Не удалось перенести скилл «${name}» из ${source}: ${String(error)}. Исходные файлы сохранены.`,
        );
      }
    }
    if (complete && sawCandidate) {
      ensureSkillDirs(markerDir);
      try {
        writeFileSync(marker, `${source}\n`, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
}

function assertRegularSkillTree(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
    throw new Error(`Unsupported link or file: ${path}`);
  if (info.isDirectory())
    for (const entry of readdirSync(path))
      assertRegularSkillTree(join(path, entry));
}

function copySkillTree(source: string, destination: string): void {
  if (lstatSync(source).isDirectory()) {
    mkdirSync(destination);
    for (const entry of readdirSync(source))
      copySkillTree(join(source, entry), join(destination, entry));
  } else copyFileSync(source, destination);
}

function pathExistsNoFollowSync(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface ParsedSkill {
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string[];
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}

/** Скиллы, доступные как /команды (без `user-invocable: false`). */
export function invocableSkills(skills: Skill[]): Skill[] {
  return skills.filter((skill) => skill.userInvocable !== false);
}

/** Скиллы, доступные модели через каталог и load_skill. */
export function modelInvocableSkills(skills: Skill[]): Skill[] {
  return skills.filter((skill) => skill.disableModelInvocation !== true);
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
  const modelInvocationRaw = String(data["disable-model-invocation"] ?? "")
    .trim()
    .toLowerCase();
  const disableModelInvocation =
    modelInvocationRaw === "true"
      ? true
      : modelInvocationRaw === "false"
        ? false
        : undefined;
  return {
    name,
    description,
    instructions,
    ...(allowedTools?.length ? { allowedTools } : {}),
    ...(userInvocable === false ? { userInvocable } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
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
 * раскрытия): только имя + описание. Тело загружается по имени через load_skill.
 */
export function skillsCatalogPrompt(skills: Skill[]): string {
  const available = modelInvocableSkills(skills);
  if (available.length === 0) return "";
  const escapeXml = (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return [
    "<available_skills>",
    ...available.map(
      (skill) =>
        `  <skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description></skill>`,
    ),
    "</available_skills>",
  ].join("\n");
}
