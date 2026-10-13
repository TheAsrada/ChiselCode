import { join } from "node:path";
import { z } from "zod";
import { InstalledVersionSchema } from "../external/registry.js";
import { atomicPackageJson, boundedJson, packageDirectory } from "./storage.js";

export const PackageOutcomeSchema = z.strictObject({
  operationId: z.uuid(),
  id: z.string().max(128),
  outcome: z.enum(["committed", "no-op"]),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  enabled: z.boolean(),
  trusted: z.boolean(),
  restartRequired: z.boolean(),
  deferred: z.boolean(),
  retainedBytes: z.number().int().nonnegative(),
  location: z.string().max(4096).optional(),
  warning: z.string().max(2000).optional(),
});
export type PackageOutcome = z.infer<typeof PackageOutcomeSchema>;
export const JournalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
  kind: z.enum(["install", "update"]),
  phase: z.enum([
    "preparing",
    "ready",
    "publishing",
    "committed",
    "aborted",
    "recovery_required",
  ]),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  host: z.string().max(512),
  pid: z.number().int().positive(),
  start: z.string().max(256).optional(),
  reservedBytes: z
    .number()
    .int()
    .nonnegative()
    .max(128 * 1024 * 1024),
  expected: z
    .strictObject({
      id: z.string().max(128),
      revision: z.number().int().nonnegative(),
      selected: z.string().max(160).optional(),
      enabled: z.boolean(),
    })
    .optional(),
  candidate: InstalledVersionSchema.optional(),
  incompatible: z.string().max(2000).optional(),
  sourceKind: z.enum(["directory", "zip"]).optional(),
  allowDowngrade: z.boolean().optional(),
  result: PackageOutcomeSchema.optional(),
  reason: z.string().max(2000).optional(),
});
export type PackageJournal = z.infer<typeof JournalSchema>;
export async function journalPath(id: string): Promise<string> {
  z.uuid().parse(id);
  return join(
    await packageDirectory(".management", "operations"),
    id + ".json",
  );
}
export async function readJournal(id: string): Promise<PackageJournal> {
  const record = JournalSchema.parse(
    await boundedJson(await journalPath(id), 32 * 1024),
  );
  if (record.operationId !== id)
    throw new Error("Journal ownership изменился.");
  return record;
}
export async function writeJournal(
  record: PackageJournal,
  assertOwned: () => Promise<void>,
): Promise<void> {
  await atomicPackageJson(
    await journalPath(record.operationId),
    JournalSchema.parse(record),
    assertOwned,
  );
}
