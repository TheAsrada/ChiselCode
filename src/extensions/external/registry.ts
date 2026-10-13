import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { withLock } from "../../sessions/lock.js";
import { atomicPackageJson, boundedJson } from "../packages/storage.js";
import { EXTERNAL_LIMITS, ExternalIdSchema } from "./manifest.js";
import {
  canonicalPath,
  extensionsDirectory,
  type InspectedPackage,
  inspectPackage,
} from "./package.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ExtensionRecordSchema = z.strictObject({
  id: ExternalIdSchema,
  version: z.string().max(80),
  apiVersion: z.literal(1),
  entry: z.string().min(1).max(512),
  location: z.string().min(1).max(4096),
  digest,
  enabled: z.boolean(),
  approvedAt: z.iso.datetime().optional(),
});
export type ExtensionRecord = z.infer<typeof ExtensionRecordSchema>;
export const InstalledVersionSchema = z
  .strictObject({
    key: z
      .string()
      .max(160)
      .regex(/^(?:[a-f0-9]{64}|legacy:[a-f0-9]{64}:[a-f0-9]{64})$/),
    id: ExternalIdSchema,
    version: z.string().max(80),
    apiVersion: z.literal(1),
    entry: z.string().min(1).max(512),
    location: z.string().min(1).max(4096),
    digest,
    approvedAt: z.iso.datetime().optional(),
    kind: z.enum(["legacy", "managed"]),
    bytes: z.number().int().min(0).max(EXTERNAL_LIMITS.bytes),
    files: z.number().int().min(0).max(EXTERNAL_LIMITS.files),
    installedAt: z.iso.datetime(),
    operationId: z.uuid().optional(),
    name: z.string().max(120).optional(),
    source: z.string().max(4096).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "managed" && (!v.operationId || v.key !== v.digest))
      ctx.addIssue({
        code: "custom",
        message: "Нет проверяемого владельца managed version.",
      });
  });
export type InstalledVersion = z.infer<typeof InstalledVersionSchema>;
export const ManagedRecordSchema = z
  .strictObject({
    id: ExternalIdSchema,
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    selected: z.string().max(160).optional(),
    removedAt: z.iso.datetime().optional(),
    lastOperationId: z.uuid().optional(),
    versions: z.array(InstalledVersionSchema).max(64),
  })
  .superRefine((v, ctx) => {
    if (
      new Set(v.versions.map((x) => x.key)).size !== v.versions.length ||
      v.versions.some((x) => x.id !== v.id) ||
      (v.selected && !v.versions.some((x) => x.key === v.selected)) ||
      (v.enabled && (!v.selected || v.removedAt))
    )
      ctx.addIssue({
        code: "custom",
        message: "Некорректный выбор/версии пакета.",
      });
  });
export type ManagedRecord = z.infer<typeof ManagedRecordSchema>;
export const ExtensionRegistrySchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    revision: z.number().int().nonnegative(),
    records: z.array(ManagedRecordSchema).max(EXTERNAL_LIMITS.packages),
    commits: z
      .array(
        z.strictObject({
          operationId: z.uuid(),
          id: ExternalIdSchema,
          digest,
          enabled: z.boolean(),
          trusted: z.boolean(),
          location: z.string().max(4096),
          bytes: z.number().int().nonnegative().max(EXTERNAL_LIMITS.bytes),
        }),
      )
      .max(1024)
      .default([]),
  })
  .refine(
    (v) => new Set(v.records.map((x) => x.id)).size === v.records.length,
    "Повторный id в реестре расширений.",
  );
export type ExtensionRegistry = z.infer<typeof ExtensionRegistrySchema>;
const legacySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    records: z
      .array(ExtensionRecordSchema.extend({ approvedAt: z.iso.datetime() }))
      .max(EXTERNAL_LIMITS.packages),
  })
  .refine(
    (v) => new Set(v.records.map((x) => x.id)).size === v.records.length,
    "Повторный id в реестре расширений.",
  );
export function selectedVersion(
  record: ManagedRecord,
): InstalledVersion | undefined {
  return record.versions.find((v) => v.key === record.selected);
}
export function runtimeRecord(
  record: ManagedRecord,
): ExtensionRecord | undefined {
  const v = selectedVersion(record);
  if (!v || record.removedAt) return;
  return ExtensionRecordSchema.parse({
    id: v.id,
    version: v.version,
    apiVersion: v.apiVersion,
    entry: v.entry,
    location: v.location,
    digest: v.digest,
    enabled: record.enabled,
    ...(v.approvedAt ? { approvedAt: v.approvedAt } : {}),
  });
}
export async function registryPath(): Promise<string> {
  return join(await extensionsDirectory(), "registry.json");
}
export async function readExtensionRegistry(): Promise<ExtensionRegistry> {
  let raw: unknown;
  try {
    raw = await boundedJson(await registryPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { schemaVersion: 2, revision: 0, records: [], commits: [] };
  }
  if ((raw as { schemaVersion?: unknown })?.schemaVersion !== 1)
    return ExtensionRegistrySchema.parse(raw);
  const prior = legacySchema.parse(raw);
  return ExtensionRegistrySchema.parse({
    schemaVersion: 2,
    revision: prior.revision,
    records: prior.records.map((v) => ({
      id: v.id,
      revision: prior.revision,
      enabled: v.enabled,
      selected: legacyVersionKey(v.location, v.digest),
      versions: [
        {
          ...v,
          enabled: undefined,
          key: legacyVersionKey(v.location, v.digest),
          kind: "legacy",
          installedAt: v.approvedAt,
          bytes: 0,
          files: 0,
        },
      ].map(({ enabled: _enabled, ...version }) => version),
    })),
  });
}
export function legacyVersionKey(location: string, hash: string): string {
  return `legacy:${hash}:${createHash("sha256").update(canonicalPath(location)).digest("hex")}`;
}
export async function withExtensionRegistry<T>(
  action: (
    state: ExtensionRegistry,
    assertOwned: () => Promise<void>,
    save: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const path = await registryPath();
  return withLock(path, async (assertOwned) => {
    const state = await readExtensionRegistry();
    return action(state, assertOwned, async () => {
      const validated = ExtensionRegistrySchema.parse(state);
      if (Buffer.byteLength(JSON.stringify(validated)) > 2 * 1024 * 1024)
        throw new Error(
          "Лимит метаданных registry 2 MiB исчерпан; текущий выбор сохранён.",
        );
      await atomicPackageJson(path, validated, assertOwned);
    });
  });
}
export async function extensionRecords(): Promise<readonly ExtensionRecord[]> {
  return (await readExtensionRegistry()).records.flatMap((v) => {
    const record = runtimeRecord(v);
    return record ? [Object.freeze(record)] : [];
  });
}
export function receiptMatches(
  record: ExtensionRecord,
  candidate: InspectedPackage,
): boolean {
  return (
    !!record.approvedAt &&
    record.id === candidate.manifest.id &&
    record.version === candidate.manifest.version &&
    record.apiVersion === candidate.manifest.apiVersion &&
    record.entry === candidate.manifest.entry &&
    canonicalPath(record.location) === canonicalPath(candidate.location) &&
    record.digest === candidate.digest
  );
}
/** Existing bootstrap receipt remains exact; a different location requires managed prepare/commit. */
export async function approvePackage(
  path: string,
  id: string,
  hash: string,
  enabled = false,
): Promise<ExtensionRecord> {
  const candidate = await inspectPackage(path);
  if (
    candidate.manifest.id !== id ||
    candidate.digest !== hash ||
    candidate.incompatible
  )
    throw new Error(
      "Пакет изменился или несовместим; выполните inspect заново.",
    );
  return withExtensionRegistry(async (state, assertOwned, save) => {
    const fresh = await inspectPackage(path),
      prior = state.records.find((x) => x.id === id),
      current = prior && selectedVersion(prior);
    if (
      fresh.digest !== hash ||
      canonicalPath(fresh.location) !== canonicalPath(candidate.location)
    )
      throw new Error("Пакет изменился во время подтверждения.");
    if (
      current &&
      canonicalPath(current.location) !== canonicalPath(candidate.location)
    )
      throw new Error(
        "Этот id уже привязан к другому пути. Используйте update/rollback.",
      );
    if (current?.kind === "managed" && current.digest !== hash)
      throw new Error(
        "Immutable installed version изменена; trust не исправляет повреждённый store. Используйте новый source через update.",
      );
    const now = new Date().toISOString();
    const version: InstalledVersion =
      current?.kind === "managed"
        ? { ...current, approvedAt: now }
        : {
            id,
            version: candidate.manifest.version,
            apiVersion: 1,
            entry: candidate.manifest.entry,
            location: candidate.location,
            digest: hash,
            key: legacyVersionKey(candidate.location, hash),
            approvedAt: now,
            kind: "legacy",
            bytes: 0,
            files: 0,
            installedAt: now,
          };
    const row: ManagedRecord = {
      id,
      revision: (prior?.revision ?? 0) + 1,
      selected: version.key,
      enabled,
      versions: [
        ...(prior?.versions.filter((v) => v.key !== version.key) ?? []),
        version,
      ],
    };
    state.records = [...state.records.filter((x) => x.id !== id), row];
    state.revision++;
    await assertOwned();
    await save();
    return runtimeRecord(row)!;
  });
}
