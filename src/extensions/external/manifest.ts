import { z } from "zod";
import { VERSION } from "../../version.js";
import { SettingsSchemaValidator } from "../settings-schema.js";

export const EXTENSION_MANIFEST = "chisel-extension.json";
export const EXTERNAL_LIMITS = Object.freeze({
  manifest: 65536,
  bytes: 64 * 1024 * 1024,
  files: 1024,
  entry: 8 * 1024 * 1024,
  packages: 32,
  budgetMs: 10000,
});
export const ExternalIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
  .refine(
    (id) => !id.startsWith("builtin.") && !id.startsWith("core."),
    "Зарезервированное имя расширения.",
  );
const version = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/)
  .max(80);
export const ExtensionManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ExternalIdSchema,
    version,
    apiVersion: z.literal(1),
    kind: z.enum(["standard", "ui"]).optional(),
    entry: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (path) =>
          path.endsWith(".mjs") &&
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !path.includes(":") &&
          !path.includes(String.fromCharCode(0)) &&
          path
            .split("/")
            .every((part) => !!part && part !== "." && part !== ".."),
        "entry должен быть относительным путём к .mjs внутри пакета.",
      ),
    displayName: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    chiselVersion: z.string().max(120).optional(),
    settings: SettingsSchemaValidator.optional(),
    platforms: z
      .array(z.enum(["win32", "darwin", "linux"]))
      .min(1)
      .max(3)
      .optional(),
  })
  .strict();
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

function compare(a: string, b: string): number {
  const aa = a.split("-")[0]!.split(".").map(Number),
    bb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (aa[i] !== bb[i]) return aa[i]! > bb[i]! ? 1 : -1;
  return 0;
}
/** Deliberately bounded range grammar: exact, ^, ~ or comparator conjunction. */
export function compatibleRange(range: string, current = VERSION): boolean {
  const parts = range.trim().split(/\s+/);
  if (!parts.length || parts.length > 4)
    throw new Error("Неподдерживаемый диапазон chiselVersion.");
  return parts
    .map((part) => {
      const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)$/.exec(part);
      if (!match) throw new Error("Неподдерживаемый диапазон chiselVersion.");
      const v = match[2]!,
        n = compare(current, v),
        op = match[1] ?? "=";
      if (op === "^") {
        const [major, minor, patch] = v.split(".").map(Number);
        const upper = major
          ? `${major + 1}.0.0`
          : minor
            ? `0.${minor + 1}.0`
            : `0.0.${patch! + 1}`;
        return n >= 0 && compare(current, upper) < 0;
      }
      if (op === "~") {
        const [major, minor] = v.split(".").map(Number);
        return n >= 0 && compare(current, `${major}.${minor! + 1}.0`) < 0;
      }
      return op === ">="
        ? n >= 0
        : op === "<="
          ? n <= 0
          : op === ">"
            ? n > 0
            : op === "<"
              ? n < 0
              : n === 0;
    })
    .every(Boolean);
}
export function compatibility(manifest: ExtensionManifest): string | undefined {
  if (
    manifest.platforms &&
    !manifest.platforms.includes(process.platform as "win32")
  )
    return "Эта платформа не поддерживается пакетом.";
  if (manifest.chiselVersion && !compatibleRange(manifest.chiselVersion))
    return "Версия ChiselCode не подходит пакету.";
  return undefined;
}
