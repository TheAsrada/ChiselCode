import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  atomicPackageJson,
  boundedJson,
  packageDirectory,
} from "../extensions/packages/storage.js";
import { CredentialStore } from "../security/credentials.js";
import { withLock } from "../sessions/lock.js";

const DraftSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  reference: z.string().max(256),
});
const identity = (root: string, sessionId?: string) =>
  createHash("sha256")
    .update(JSON.stringify([root, sessionId ?? "home"]))
    .digest("hex");
/** A composer is UI state, never model history. Content stays in protected storage. */
export async function loadTerminalDraft(
  root: string,
  sessionId?: string,
): Promise<string | undefined> {
  const key = identity(root, sessionId),
    path = join(await packageDirectory(".terminal-drafts"), `${key}.json`);
  try {
    const data = DraftSchema.parse(await boundedJson(path, 1024));
    return new CredentialStore().get(data.reference);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function saveTerminalDraft(
  root: string,
  sessionId: string | undefined,
  text: string,
): Promise<void> {
  const key = identity(root, sessionId),
    path = join(await packageDirectory(".terminal-drafts"), `${key}.json`);
  if (text.length > 256000)
    throw new Error("Черновик слишком большой для сохранения.");
  await withLock(path, async (assertOwned) => {
    let revision = 0;
    try {
      revision = DraftSchema.parse(await boundedJson(path, 1024)).revision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const reference = `terminal-draft:${key}`;
    await new CredentialStore().set(reference, text);
    await atomicPackageJson(
      path,
      { revision: revision + 1, reference },
      assertOwned,
    );
  });
}
