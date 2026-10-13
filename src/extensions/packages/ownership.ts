import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalPath, inspectPackage } from "../external/package.js";
import type { InstalledVersion } from "../external/registry.js";
import { atomicPackageJson, boundedJson, packageDirectory } from "./storage.js";
export const OwnershipSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().max(128),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.uuid(),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});
export async function managedLocation(
  id: string,
  digest: string,
): Promise<string> {
  return join(await packageDirectory("packages", id), digest);
}
export async function ownershipPath(
  id: string,
  digest: string,
): Promise<string> {
  return join(
    await packageDirectory(".management", "versions", id),
    digest + ".json",
  );
}
export async function writeOwnership(
  v: InstalledVersion,
  assertOwned: () => Promise<void>,
): Promise<void> {
  await atomicPackageJson(
    await ownershipPath(v.id, v.digest),
    OwnershipSchema.parse({
      schemaVersion: 1,
      id: v.id,
      digest: v.digest,
      operationId: v.operationId,
      bytes: v.bytes,
      files: v.files,
    }),
    assertOwned,
  );
}
export async function verifyOwnedVersion(v: InstalledVersion): Promise<void> {
  if (
    v.kind !== "managed" ||
    canonicalPath(v.location) !==
      canonicalPath(await managedLocation(v.id, v.digest))
  )
    throw new Error("Версия не имеет managed ownership.");
  const info = await lstat(v.location);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Managed destination изменился.");
  const owner = OwnershipSchema.parse(
    await boundedJson(await ownershipPath(v.id, v.digest), 2048),
  );
  if (
    owner.id !== v.id ||
    owner.digest !== v.digest ||
    owner.operationId !== v.operationId ||
    owner.bytes !== v.bytes ||
    owner.files !== v.files
  )
    throw new Error("Managed ownership marker не совпадает.");
  const candidate = await inspectPackage(v.location);
  if (
    candidate.digest !== v.digest ||
    candidate.manifest.id !== v.id ||
    candidate.bytes !== v.bytes ||
    candidate.files !== v.files
  )
    throw new Error("Managed bytes повреждены; удаление не подтверждено.");
}
