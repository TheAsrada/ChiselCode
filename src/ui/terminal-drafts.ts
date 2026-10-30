import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
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
  applicationId: z.uuid().optional(),
  pid: z.number().int().positive().optional(),
  updatedAt: z.number().optional(),
  closed: z.boolean().optional(),
});
export type TerminalDraftIdentity = string | { applicationId: string };
const revisions = new Map<string, number>();
const identity = (root: TerminalDraftIdentity, sessionId?: string) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        typeof root === "string"
          ? [root, sessionId ?? "home"]
          : ["application", z.uuid().parse(root.applicationId)],
      ),
    )
    .digest("hex");
/** A composer is UI state, never model history. Content stays in protected storage. */
export async function loadTerminalDraft(
  root: TerminalDraftIdentity,
  sessionId?: string,
): Promise<string | undefined> {
  const key = identity(root, sessionId),
    path = join(await packageDirectory(".terminal-drafts"), `${key}.json`);
  return withLock(path, async () => {
    try {
      const data = DraftSchema.parse(await boundedJson(path, 1024));
      revisions.set(key, data.revision);
      return await new CredentialStore().get(data.reference);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        revisions.set(key, 0);
        return undefined;
      }
      throw error;
    }
  });
}
export async function saveTerminalDraft(
  root: TerminalDraftIdentity,
  sessionId: string | undefined,
  text: string,
  options: { closed?: boolean } = {},
): Promise<void> {
  const key = identity(root, sessionId),
    path = join(await packageDirectory(".terminal-drafts"), `${key}.json`);
  if (text.length > 256000)
    throw new Error("Черновик слишком большой для сохранения.");
  await withLock(path, async (assertOwned) => {
    let revision = 0;
    let priorReference: string | undefined;
    try {
      const previous = DraftSchema.parse(await boundedJson(path, 1024));
      revision = previous.revision;
      priorReference = previous.reference;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const expected = revisions.get(key) ?? 0;
    if (revision !== expected) {
      // Preserve both writers: a fresh application identity has its own metadata/payload.
      await saveTerminalDraft(
        { applicationId: randomUUID() },
        undefined,
        text,
        { closed: true },
      );
      throw new Error(
        "Черновик изменён другим экземпляром. Оба текста сохранены отдельно.",
      );
    }
    const reference = `terminal-draft:${key}:${revision + 1}:${randomUUID()}`;
    await new CredentialStore().set(reference, text);
    await atomicPackageJson(
      path,
      {
        revision: revision + 1,
        reference,
        ...(typeof root === "string"
          ? {}
          : {
              applicationId: root.applicationId,
              pid: process.pid,
              closed: options.closed ?? false,
            }),
        updatedAt: Date.now(),
      },
      assertOwned,
    );
    revisions.set(key, revision + 1);
    // Metadata publication is confirmed; readers use this same lock. Old payload
    // cleanup is optional and can never turn the successful publication into loss.
    if (priorReference && priorReference !== reference)
      await new CredentialStore().delete(priorReference).catch(() => {});
  });
}

/** Restore a closed instance by copying its text into a new, independently owned UUID. */
export async function loadApplicationDraft(): Promise<string | undefined> {
  const directory = await packageDirectory(".terminal-drafts");
  const candidates: Array<z.infer<typeof DraftSchema>> = [];
  for (const name of (await readdir(directory))
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .slice(-500)) {
    try {
      const data = DraftSchema.parse(
        await boundedJson(join(directory, name), 1024),
      );
      if (!data.applicationId || !data.pid) continue;
      if (!data.closed) {
        try {
          process.kill(data.pid, 0);
          continue;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") continue;
        }
      }
      candidates.push(data);
    } catch {
      /* Damaged metadata never grants ownership or overwrites another draft. */
    }
  }
  const latest = candidates.sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  )[0];
  return latest ? new CredentialStore().get(latest.reference) : undefined;
}
