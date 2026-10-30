import { stat } from "node:fs/promises";
import { pathIdentity } from "./paths.js";

const managedRoots = new Map<string, { dev: number; ino: number }>();
/** Internal attestation, written only after the existing Git/registry ownership checks. */
export async function recordVerifiedManagedRoot(root: string): Promise<void> {
  const info = await stat(root);
  managedRoots.set(pathIdentity(root), { dev: info.dev, ino: info.ino });
}
export async function isVerifiedManagedRoot(root: string): Promise<boolean> {
  const expected = managedRoots.get(pathIdentity(root));
  if (!expected) return false;
  const info = await stat(root);
  return (
    info.isDirectory() && expected.dev === info.dev && expected.ino === info.ino
  );
}
