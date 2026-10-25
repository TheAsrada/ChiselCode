import { z } from "zod";

export const SkillSourceInput = z.object({
  source: z.string().trim().min(1).max(4096),
  skill: z.string().trim().min(1).max(512).optional(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
});
export type SkillSourceInput = z.infer<typeof SkillSourceInput>;
export type SkillSource =
  | {
      kind: "github";
      repository: string;
      ref?: string;
      path: string;
      skill?: string;
    }
  | { kind: "markdown"; url: string; skill?: string };

// Parse a small data format, never a shell command. Reject shell expansion even
// inside quotes, so a pasted command cannot acquire an executable interpretation.
function tokens(command: string): string[] {
  if (/[\r\n`$;&|<>]/.test(command) || command.includes(String.fromCharCode(0)))
    throw new Error(
      "Передайте одну ссылку или команду skills add без shell-операторов.",
    );
  const parts: string[] = [];
  let current = "",
    quote = "";
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else current += char;
  }
  if (quote) throw new Error("Незакрытая кавычка в источнике навыка.");
  if (current) parts.push(current);
  return parts;
}

export function parseSkillSource(input: SkillSourceInput): SkillSource {
  const args = tokens(input.source);
  let source: string | undefined;
  let selector = input.skill;
  if (args.at(0) === "npx") {
    args.shift();
    if (args[0] === "--yes" || args[0] === "-y") args.shift();
    if (args.shift() !== "skills" || args.shift() !== "add")
      throw new Error(
        "Поддерживается npx skills add <источник> --skill <имя>.",
      );
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!arg) throw new Error("Пустой аргумент источника.");
      if (["--yes", "-y", "--global", "-g"].includes(arg)) continue;
      if (arg === "--skill" || arg === "-s") {
        const value = args[++i];
        if (!value || value.startsWith("-") || (selector && selector !== value))
          throw new Error("Укажите один навык через --skill.");
        selector = value;
      } else if (arg === "--agent" || arg === "-a") {
        if (args[++i] !== "chiselcode")
          throw new Error(
            "Установка доступна только в библиотеку ChiselCode; уберите --agent.",
          );
      } else if (arg.startsWith("-") || source)
        throw new Error(`Неподдерживаемый аргумент skills add: ${arg}`);
      else source = arg;
    }
  } else if (args.length === 1) source = args[0];
  if (!source)
    throw new Error(
      "Нужна ссылка на GitHub, owner/repo или публичный SKILL.md.",
    );
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source))
    source = `https://github.com/${source}`;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("Некорректная ссылка на источник навыка.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Нужна публичная HTTPS-ссылка без credentials, query и fragment.",
    );
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (
    parts.some(
      (part) =>
        /[\\\p{Cc}\p{Cf}]/u.test(part) ||
        part === "." ||
        part === ".." ||
        part.includes("/"),
    )
  )
    throw new Error("Недопустимый путь источника навыка.");
  if (
    url.hostname === "github.com" ||
    url.hostname === "raw.githubusercontent.com"
  ) {
    const [owner, repository, kind, ref, ...rest] = parts;
    if (
      !owner ||
      !repository ||
      !/^[A-Za-z0-9_.-]+$/.test(owner) ||
      !/^[A-Za-z0-9_.-]+$/.test(repository)
    )
      throw new Error("Укажите GitHub owner/repo.");
    const raw = url.hostname === "raw.githubusercontent.com";
    if (!raw && kind && kind !== "tree" && kind !== "blob")
      throw new Error(
        "Поддерживается ссылка на репозиторий, tree или blob SKILL.md.",
      );
    if ((raw && !kind) || (!raw && kind && !ref))
      throw new Error("В ссылке отсутствует Git ref.");
    const fileParts = raw
      ? [ref, ...rest].filter((part): part is string => !!part)
      : rest;
    if ((raw || kind === "blob") && fileParts.at(-1) !== "SKILL.md")
      throw new Error("Передайте ссылку на SKILL.md или папку навыка.");
    if (fileParts.at(-1) === "SKILL.md") fileParts.pop();
    return {
      kind: "github",
      repository: `${owner}/${repository.replace(/\.git$/, "")}`,
      path: fileParts.join("/"),
      ...(raw ? { ref: kind } : ref ? { ref } : {}),
      ...(selector ? { skill: selector } : {}),
    };
  }
  if (parts.at(-1) !== "SKILL.md")
    throw new Error(
      "Этот источник пока не поддерживается. Передайте GitHub-репозиторий или прямую HTTPS-ссылку на SKILL.md.",
    );
  if (input.revision) throw new Error("revision применим только к GitHub.");
  return {
    kind: "markdown",
    url: url.toString(),
    ...(selector ? { skill: selector } : {}),
  };
}

export function skillSourceUrl(source: SkillSource): string {
  return source.kind === "github"
    ? `https://api.github.com/repos/${source.repository}/commits?per_page=1${source.ref ? `&sha=${encodeURIComponent(source.ref)}` : ""}`
    : source.url;
}
