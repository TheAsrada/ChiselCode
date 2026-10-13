import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { withLock } from "../../sessions/lock.js";
import { EXTERNAL_LIMITS, ExternalIdSchema } from "./manifest.js";
import {
  canonicalPath,
  extensionsDirectory,
  type InspectedPackage,
  inspectPackage,
} from "./package.js";

export const ExtensionRecordSchema = z
  .object({
    id: ExternalIdSchema,
    version: z.string().max(80),
    apiVersion: z.literal(1),
    entry: z.string().min(1).max(512),
    location: z.string().min(1).max(4096),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    enabled: z.boolean(),
    approvedAt: z.iso.datetime(),
  })
  .strict();
export type ExtensionRecord = z.infer<typeof ExtensionRecordSchema>;
const registrySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    records: z.array(ExtensionRecordSchema).max(EXTERNAL_LIMITS.packages),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.records.map((record) => record.id)).size ===
      value.records.length,
    "Повторный id в реестре расширений.",
  );
async function readRegistry(
  path: string,
): Promise<z.infer<typeof registrySchema>> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
      throw new Error("Небезопасный или слишком большой реестр расширений.");
    return registrySchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { schemaVersion: 1, revision: 0, records: [] };
  }
}
export async function extensionRecords(): Promise<readonly ExtensionRecord[]> {
  return (
    await readRegistry(join(await extensionsDirectory(), "registry.json"))
  ).records;
}
export function receiptMatches(
  record: ExtensionRecord,
  candidate: InspectedPackage,
): boolean {
  return (
    record.id === candidate.manifest.id &&
    record.version === candidate.manifest.version &&
    record.apiVersion === candidate.manifest.apiVersion &&
    record.entry === candidate.manifest.entry &&
    canonicalPath(record.location) === canonicalPath(candidate.location) &&
    record.digest === candidate.digest
  );
}
/** Exact candidate acknowledgement. Disabled is the safe default; no folder-wide trust. */
export async function approvePackage(
  path: string,
  id: string,
  digest: string,
  enabled = false,
): Promise<ExtensionRecord> {
  const candidate = await inspectPackage(path);
  if (
    candidate.manifest.id !== id ||
    candidate.digest !== digest ||
    candidate.incompatible
  )
    throw new Error(
      "Пакет изменился или несовместим; выполните inspect заново.",
    );
  const target = join(await extensionsDirectory(), "registry.json");
  return withLock(target, async (assertOwned) => {
    const current = await readRegistry(target),
      fresh = await inspectPackage(path);
    if (
      fresh.digest !== digest ||
      canonicalPath(fresh.location) !== canonicalPath(candidate.location)
    )
      throw new Error("Пакет изменился во время подтверждения.");
    const prior = current.records.find((record) => record.id === id);
    if (
      prior &&
      canonicalPath(prior.location) !== canonicalPath(candidate.location)
    )
      throw new Error("Этот id уже привязан к другому пути.");
    const record = ExtensionRecordSchema.parse({
      id,
      version: candidate.manifest.version,
      apiVersion: 1,
      entry: candidate.manifest.entry,
      location: candidate.location,
      digest,
      enabled,
      approvedAt: new Date().toISOString(),
    });
    current.records = [
      ...current.records.filter((item) => item.id !== id),
      record,
    ];
    current.revision++;
    const bytes = JSON.stringify(registrySchema.parse(current), null, 2) + "\n",
      temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await assertOwned();
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return Object.freeze(record);
  });
}
