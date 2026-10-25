import { z } from "zod";
import { RuntimeError } from "../runtime/errors.js";

export const SkillSourceInput = z.object({
  source: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .describe(
      "Public skill URL, owner/repo or a pasted npx skills add command. The command is parsed as data, never executed.",
    ),
  skill: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .nullish()
    .describe(
      "Optional exact skill name or folder path. Omit or use null if unspecified. A full path can refine the same name in a pasted command.",
    ),
  revision: z
    .string()
    .trim()
    .regex(
      /^[a-fA-F0-9]{40}$/,
      "revision: нужен настоящий SHA коммита из 40 hex-символов. Если пользователь не задавал коммит, уберите revision или передайте null: клиент определит его сам.",
    )
    .refine(
      (value) => value !== "0".repeat(40),
      "revision: 40 нулей — заглушка, а не коммит. Если пользователь не задавал коммит, уберите revision или передайте null. Не придумывайте SHA; используйте revision из результата inspect_skills.",
    )
    .nullish()
    .describe(
      "Optional real GitHub commit SHA, only if explicitly supplied by the user or returned by inspect_skills. For the first call normally OMIT this field or use null; the client resolves the commit. Never invent a SHA or use all zeros. An explicit user pin must not be silently replaced.",
    ),
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
  let selector = input.skill ?? undefined;
  let commandSelector: string | undefined;
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
        if (
          !value ||
          value.startsWith("-") ||
          (commandSelector && commandSelector !== value)
        )
          throw new Error("Укажите один навык через --skill.");
        commandSelector = value;
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
  if (selector && commandSelector && selector !== commandSelector) {
    const folder = selector.replace(/\/SKILL\.md$/, "");
    if (
      commandSelector.includes("/") ||
      folder.split("/").at(-1) !== commandSelector
    )
      throw new Error(
        "skill противоречит --skill в команде. Укажите одно имя или полный путь к этому же навыку.",
      );
  }
  selector ??= commandSelector;
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
    const selectedRef = raw ? kind : ref;
    if (
      input.revision &&
      selectedRef &&
      /^[a-fA-F0-9]{40}$/.test(selectedRef) &&
      input.revision.toLowerCase() !== selectedRef.toLowerCase()
    )
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        "revision противоречит коммиту в source. Сохраните версию, указанную пользователем; не подменяйте её другим SHA.",
      );
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
