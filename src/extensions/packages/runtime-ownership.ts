import type { Stats } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalPath, inspectPackage } from "../external/package.js";
import {
  type InstalledVersion,
  withExtensionRegistry,
} from "../external/registry.js";
import { atomicPackageJson, boundedJson, packageDirectory } from "./storage.js";

const RuntimeOwner = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().max(128),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  leaseToken: z.uuid(),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024 * 1024),
});
async function marker(digest: string): Promise<string> {
  return join(
    await packageDirectory(".management", "runtime"),
    digest + ".json",
  );
}
export async function markRuntimeSnapshot(
  id: string,
  digest: string,
  bytes: number,
  leaseToken: string,
): Promise<void> {
  await withExtensionRegistry(async (_state, assertOwned) => {
    await atomicPackageJson(
      await marker(digest),
      RuntimeOwner.parse({ schemaVersion: 1, id, digest, bytes, leaseToken }),
      assertOwned,
    );
  });
}
/** Caller holds registry lock and has proved no live/unknown version use. Legacy unowned caches remain. */
export async function deleteOwnedRuntime(
  version: InstalledVersion,
  assertOwned: () => Promise<void>,
): Promise<void> {
  const file = await marker(version.digest);
  let owner: z.infer<typeof RuntimeOwner>;
  try {
    owner = RuntimeOwner.parse(await boundedJson(file, 2048));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (owner.id !== version.id || owner.digest !== version.digest)
    throw new Error("Runtime ownership не подтверждён.");
  const path = join(await packageDirectory(".runtime"), version.digest);
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await assertOwned();
    await rm(file);
    return;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    owner.id !== version.id ||
    owner.digest !== version.digest
  )
    throw new Error("Runtime ownership не подтверждён.");
  const candidate = await inspectPackage(path);
  if (
    candidate.digest !== version.digest ||
    candidate.bytes !== owner.bytes ||
    canonicalPath(candidate.location) !== canonicalPath(path)
  )
    throw new Error("Runtime snapshot изменился; bytes сохранены.");
  await assertOwned();
  await rm(path, { recursive: true });
  await assertOwned();
  await rm(file);
}
