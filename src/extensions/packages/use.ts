import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalPath } from "../external/package.js";
import type { ExtensionRecord } from "../external/registry.js";
import { runtimeRecord, withExtensionRegistry } from "../external/registry.js";
import { PackageManagementError } from "./errors.js";
import { currentProcessIdentity, identityState } from "./process-identity.js";
import { checkPackageQuota } from "./quota.js";
import { atomicPackageJson, boundedJson, packageDirectory } from "./storage.js";
export const UseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  token: z.uuid(),
  applicationId: z.uuid(),
  id: z.string().max(128),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  location: z.string().max(4096),
  host: z.string().max(512),
  pid: z.number().int().positive(),
  start: z.string().max(256).optional(),
  phase: z.enum(["loading", "loaded", "shutdown_pending_exit", "recovery"]),
  createdAt: z.iso.datetime(),
  reservedBytes: z
    .number()
    .int()
    .nonnegative()
    .max(128 * 1024 * 1024),
});
export type VersionUse = z.infer<typeof UseSchema> & {
  confidence: "live" | "dead" | "unknown";
};
export async function versionUses(
  id?: string,
  digest?: string,
): Promise<readonly VersionUse[]> {
  const directory = await packageDirectory(".management", "uses"),
    result: VersionUse[] = [];
  const entries = await readdir(directory);
  if (entries.length > 1024)
    throw new PackageManagementError(
      "PACKAGE_RECOVERY_REQUIRED",
      "Слишком много use leases; требуется recovery.",
    );
  const confidence = new Map<string, Promise<"live" | "dead" | "unknown">>();
  for (const entry of entries) {
    if (!/^[a-f0-9-]{36}\.json$/.test(entry))
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Неизвестная запись use lease; данные не удалены.",
      );
    let use: z.infer<typeof UseSchema>;
    try {
      use = UseSchema.parse(await boundedJson(join(directory, entry), 8192));
    } catch {
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Повреждённый use lease; bytes сохранены.",
      );
    }
    if (use.token !== entry.slice(0, -5))
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Use lease filename/identity не совпадают.",
      );
    if ((!id || use.id === id) && (!digest || use.digest === digest)) {
      const key = JSON.stringify([use.host, use.pid, use.start]);
      let state = confidence.get(key);
      if (!state) {
        state = identityState(use);
        confidence.set(key, state);
      }
      const identity = await state;
      result.push({
        ...use,
        confidence:
          identity === "dead" && use.phase !== "shutdown_pending_exit"
            ? "unknown"
            : identity,
      });
    }
  }
  if (result.length > 1024)
    throw new PackageManagementError(
      "PACKAGE_RECOVERY_REQUIRED",
      "Слишком много use leases; требуется recovery.",
    );
  return result;
}
export interface PackageUseLease {
  token: string;
  loaded(): Promise<void>;
  failedBeforeImport(): Promise<void>;
  shutdown(cleanupConfirmed?: boolean): Promise<void>;
}
/** Registry lock is held by the caller. Crash/unknown records are never reclaimed by PID alone. */
export async function releaseStoppedUses(
  assertOwned: () => Promise<void>,
): Promise<void> {
  for (const use of await versionUses())
    if (use.confidence === "dead" && use.phase === "shutdown_pending_exit") {
      await assertOwned();
      await rm(
        join(
          await packageDirectory(".management", "uses"),
          use.token + ".json",
        ),
      );
    }
}
export async function acquireVersionUse(
  record: ExtensionRecord,
  applicationId: string,
  bytes: number,
): Promise<PackageUseLease> {
  const token = randomUUID(),
    file = join(await packageDirectory(".management", "uses"), token + ".json"),
    identity = await currentProcessIdentity();
  let use = UseSchema.parse({
    schemaVersion: 1,
    token,
    applicationId,
    ...identity,
    id: record.id,
    digest: record.digest,
    location: record.location,
    phase: "loading",
    createdAt: new Date().toISOString(),
    reservedBytes: Math.min(128 * 1024 * 1024, bytes * 2),
  });
  await withExtensionRegistry(async (state, assertOwned) => {
    const row = state.records.find((x) => x.id === record.id),
      selected = row && runtimeRecord(row);
    if (
      !selected ||
      !selected.enabled ||
      selected.digest !== record.digest ||
      selected.version !== record.version ||
      selected.apiVersion !== record.apiVersion ||
      selected.entry !== record.entry ||
      selected.approvedAt !== record.approvedAt ||
      canonicalPath(selected.location) !== canonicalPath(record.location)
    )
      throw new PackageManagementError(
        "PACKAGE_CONFLICT",
        "Desired package изменился до import; перезапустите ChiselCode.",
      );
    await releaseStoppedUses(assertOwned);
    if (
      (await readdir(await packageDirectory(".management", "uses"))).length >=
      1024
    )
      throw new PackageManagementError(
        "PACKAGE_QUOTA",
        "Лимит use leases исчерпан; неизвестные владельцы сохраняют bytes.",
      );
    await checkPackageQuota(use.reservedBytes);
    await atomicPackageJson(file, use, assertOwned);
  });
  const update = (phase: typeof use.phase, reservedBytes: number) =>
    withExtensionRegistry(async (_state, assertOwned) => {
      const prior = UseSchema.parse(await boundedJson(file, 8192));
      if (prior.token !== token || prior.applicationId !== applicationId)
        throw new PackageManagementError(
          "PACKAGE_RECOVERY_REQUIRED",
          "Use lease ownership изменился.",
        );
      use = { ...prior, phase, reservedBytes };
      await atomicPackageJson(file, use, assertOwned);
    });
  return {
    token,
    loaded: () => update("loaded", 0),
    failedBeforeImport: () =>
      withExtensionRegistry(async (_state, assertOwned) => {
        const prior = UseSchema.parse(await boundedJson(file, 8192));
        if (prior.token !== token || prior.phase !== "loading")
          throw new Error("Нельзя снять live import lease.");
        await assertOwned();
        await rm(file);
      }),
    shutdown: (cleanupConfirmed = true) =>
      update(cleanupConfirmed ? "shutdown_pending_exit" : "recovery", 0),
  };
}
