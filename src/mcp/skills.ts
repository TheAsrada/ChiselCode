import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { RuntimeError } from "../runtime/errors.js";

export const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
export const skillSlug = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const skillName = new RegExp(`^${skillSlug}$`);
const maxBytes = 16 * 1024 * 1024;

const SkillResource = z.object({
  uri: z.string().min(1).max(4096),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.number().int().min(0).max(maxBytes),
});
const SkillEntry = z.object({
  uri: z.string().min(1).max(4096),
  frontmatter: z
    .object({
      name: z
        .string()
        .regex(skillName)
        .refine((name) => !name.includes("--")),
      description: z
        .string()
        .min(1)
        .max(1024)
        .refine((value) => Boolean(value.trim())),
      "user-invocable": z.boolean().optional(),
    })
    .catchall(z.json()),
  resources: z.union([
    z.array(SkillResource).min(1).max(512),
    z.literal("dynamic"),
  ]),
});
export const McpSkillListResult = z.object({
  resultType: z.literal("complete").optional(),
  skills: z.array(z.unknown()).max(1000),
  nextCursor: z.string().min(1).max(4096).optional(),
});
export const McpSkillGetResult = z.object({
  resultType: z.literal("complete").optional(),
  skill: SkillEntry,
});

export type McpSkillEntry = z.infer<typeof SkillEntry>;
type Resource = z.infer<typeof SkillResource>;
export function invalidMcpSkill(message: string): RuntimeError {
  return new RuntimeError("MCP_PROTOCOL_ERROR", message, { retryable: false });
}

export function parseMcpSkillEntry(input: unknown): McpSkillEntry | undefined {
  const parsed = SkillEntry.safeParse(input);
  if (!parsed.success) return;
  const entry = parsed.data;
  if (entry.resources === "dynamic") return;
  const uri = URL.parse(entry.uri);
  if (
    !uri ||
    uri.search ||
    uri.hash ||
    uri.username ||
    uri.password ||
    (!uri.pathname.endsWith(`/${entry.frontmatter.name}/SKILL.md`) &&
      !(
        uri.pathname === "/SKILL.md" && uri.hostname === entry.frontmatter.name
      ))
  )
    return;
  const root = new URL(".", uri);
  const seen = new Set<string>();
  let size = 0;
  for (const resource of entry.resources) {
    const candidate = URL.parse(resource.uri);
    if (
      !candidate ||
      candidate.search ||
      candidate.hash ||
      !candidate.href.startsWith(root.href) ||
      seen.has(candidate.href)
    )
      return;
    seen.add(candidate.href);
    size += resource.size;
  }
  if (
    size > maxBytes ||
    !entry.resources.some((file) => file.uri === entry.uri)
  )
    return;
  return entry;
}

export function mcpSkillFile(entry: McpSkillEntry, path?: string): Resource {
  const files = entry.resources;
  if (files === "dynamic")
    throw invalidMcpSkill("У MCP-навыка нет манифеста файлов.");
  // Resolve only normalized relative paths into the retained manifest.
  const segments = path?.split("/");
  if (
    segments?.some(
      (part) =>
        !part || part === "." || part === ".." || /[\\:\p{Cc}]/u.test(part),
    )
  )
    throw invalidMcpSkill("Укажите относительный путь к файлу MCP-навыка.");
  const uri = segments
    ? new URL(segments.map(encodeURIComponent).join("/"), entry.uri).href
    : entry.uri;
  const file = files.find((resource) =>
    segments ? new URL(resource.uri).href === uri : resource.uri === uri,
  );
  if (!file) throw invalidMcpSkill("Файл отсутствует в манифесте MCP-навыка.");
  return file;
}

export function verifiedMcpSkillText(
  file: Resource,
  contents: readonly { uri: string; text?: string; blob?: string }[],
): string {
  const matches = contents.filter((content) => content.uri === file.uri);
  const content = matches.length === 1 ? matches[0] : undefined;
  const bytes =
    content?.text !== undefined
      ? Buffer.from(content.text, "utf8")
      : typeof content?.blob === "string"
        ? Buffer.from(content.blob, "base64")
        : undefined;
  if (
    !bytes ||
    bytes.length !== file.size ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.digest
  )
    throw invalidMcpSkill(
      "Файл MCP-навыка изменился или не совпадает с манифестом. Обновите каталог и повторите вызов.",
    );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidMcpSkill("Файл MCP-навыка должен быть текстом UTF-8.");
  }
}

export function mcpSkillInstructions(
  entry: McpSkillEntry,
  text: string,
): string {
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    text,
  );
  if (!frontmatter?.[1])
    throw invalidMcpSkill("В SKILL.md отсутствует YAML-шапка.");
  let data: unknown;
  try {
    data = Bun.YAML.parse(frontmatter[1]);
  } catch {
    throw invalidMcpSkill("Некорректная YAML-шапка SKILL.md.");
  }
  if (!isDeepStrictEqual(data, entry.frontmatter))
    throw invalidMcpSkill(
      "YAML-шапка SKILL.md не совпадает с метаданными MCP-навыка.",
    );
  const body = text.slice(frontmatter[0].length).trim();
  if (!body) throw invalidMcpSkill("В SKILL.md отсутствуют инструкции.");
  return body;
}
