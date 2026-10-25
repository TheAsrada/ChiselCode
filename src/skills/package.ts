import { createHash } from "node:crypto";
import { packageRelativePath } from "../utils/package-path.js";
import {
  isReservedSkillName,
  type ParsedSkill,
  parseImportedSkill,
} from "./skills.js";

export const SKILL_PACKAGE_LIMITS = {
  files: 128,
  bytes: 8 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  instructionsBytes: 64 * 1024,
} as const;
export const SKILL_RECEIPT = ".chisel-source.json";
export interface SkillOrigin {
  url: string;
  revision?: string;
  path?: string;
}
export interface SkillPackage {
  metadata: ParsedSkill;
  files: Map<string, Uint8Array>;
  origin: SkillOrigin;
  digest: string;
}
export function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function validateSkillPackage(
  files: Map<string, Uint8Array>,
  fallbackName: string,
  origin: SkillOrigin,
): SkillPackage {
  if (!files.size || files.size > SKILL_PACKAGE_LIMITS.files)
    throw new Error(
      `Навык должен содержать от 1 до ${SKILL_PACKAGE_LIMITS.files} файлов.`,
    );
  const names = new Set<string>();
  const spellings = new Map<string, string>();
  let total = 0;
  for (const [name, bytes] of files) {
    packageRelativePath(name);
    const parts = name.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const folded = prefix.normalize("NFC").toLowerCase();
      const previous = spellings.get(folded);
      if (previous !== undefined && previous !== prefix)
        throw new Error(
          `Неоднозначный регистр или Unicode в пути навыка: ${prefix}`,
        );
      spellings.set(folded, prefix);
    }
    const key = name.normalize("NFC").toLowerCase();
    if (
      key === SKILL_RECEIPT ||
      key.startsWith(`${SKILL_RECEIPT}/`) ||
      names.has(key) ||
      key.endsWith("/skill.md")
    )
      throw new Error(`Конфликтующий или вложенный файл навыка: ${name}`);
    names.add(key);
    total += bytes.byteLength;
    if (
      bytes.byteLength > SKILL_PACKAGE_LIMITS.fileBytes ||
      total > SKILL_PACKAGE_LIMITS.bytes
    )
      throw new Error(
        "Пакет навыка превышает предел размера (1 MiB на файл, 8 MiB всего).",
      );
  }
  for (const name of names) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      if (names.has(parts.slice(0, i).join("/")))
        throw new Error("Пути файлов и каталогов навыка пересекаются.");
  }
  const instructions = files.get("SKILL.md");
  if (
    !instructions ||
    instructions.byteLength > SKILL_PACKAGE_LIMITS.instructionsBytes
  )
    throw new Error("Нужен SKILL.md не больше 64 KiB.");
  const metadata = parseImportedSkill(fallbackName, utf8(instructions));
  if (!metadata || isReservedSkillName(metadata.name))
    throw new Error(
      "SKILL.md содержит некорректное или зарезервированное имя навыка.",
    );
  const hash = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) =>
    a.localeCompare(b, "en"),
  ))
    hash.update(JSON.stringify([name, bytes.byteLength])).update(bytes);
  return { metadata, files, origin, digest: hash.digest("hex") };
}
