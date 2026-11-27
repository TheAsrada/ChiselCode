import { isMap, parseDocument } from "yaml";

export class SkillFrontmatterError extends Error {}

/** SKILL.md may omit the header in the local library for legacy compatibility. */
export function splitFrontmatter(text: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const normalized = text.replace(/^\uFEFF/, "");
  const lines = normalized.split("\n");
  if (!/^---(?:[ \t]+#.*)?$/.test(lines[0]?.trim() ?? ""))
    return { data: {}, body: normalized };
  const end = lines.findIndex(
    (line, index) =>
      index > 0 && /^(?:---|\.\.\.)(?:[ \t]+#.*)?[ \t]*\r?$/.test(line),
  );
  if (end < 0) throw new SkillFrontmatterError("YAML-шапка не закрыта.");

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(`${lines.slice(1, end).join("\n")}\n`, {
      uniqueKeys: true,
      merge: true,
    });
  } catch {
    throw new SkillFrontmatterError("Не удалось разобрать YAML-шапку.");
  }
  if (document.errors.length || document.warnings.length)
    throw new SkillFrontmatterError(
      "Некорректная YAML-шапка. Проверьте синтаксис и повторяющиеся ключи.",
    );
  if (document.contents && !isMap(document.contents))
    throw new SkillFrontmatterError("YAML-шапка должна быть объектом.");
  try {
    return {
      data: document.toJS({ maxAliasCount: 50 }) ?? {},
      body: lines.slice(end + 1).join("\n"),
    };
  } catch {
    throw new SkillFrontmatterError("Не удалось раскрыть YAML-ссылки в шапке.");
  }
}

export function skillString(
  data: Record<string, unknown>,
  key: string,
): string {
  const value = Object.hasOwn(data, key) ? data[key] : undefined;
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  throw new SkillFrontmatterError(`Поле ${key} должно быть строкой.`);
}

export function invocationFlag(
  data: Record<string, unknown>,
  key: "user-invocable" | "disable-model-invocation",
): boolean | undefined {
  if (!Object.hasOwn(data, key)) return;
  const value = data[key];
  if (typeof value === "boolean") return value;
  // Older ChiselCode accepted quoted booleans in existing skills.
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "false")
      return normalized === "true";
  }
  throw new SkillFrontmatterError(`Поле ${key} должно быть true или false.`);
}
