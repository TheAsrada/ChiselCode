import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalPath } from "../external/package.js";
export function inside(parent: string, path: string): boolean {
  const rel = relative(
    canonicalPath(resolve(parent)),
    canonicalPath(resolve(path)),
  );
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
export function packageRelativePath(value: string, directory = false): string {
  if (
    value.length > 512 ||
    /[\\:\p{Cc}\p{Cf}]/u.test(value) ||
    value.startsWith("/") ||
    value.includes("\u0000")
  )
    throw new Error("Недопустимый путь файла пакета.");
  const result = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = result.split("/");
  if (
    !result ||
    parts.length > 32 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("Путь пакета содержит escape, ADS или reserved name.");
  return result;
}
