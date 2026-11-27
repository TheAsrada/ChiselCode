import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  atomicPackageJson,
  boundedJson,
  packageDirectory,
} from "../extensions/packages/storage.js";
import {
  IMAGE_LIMIT,
  type ImageAttachment,
  ImageAttachmentSchema,
  protectImages,
} from "../media/image-attachment.js";
import { CredentialStore } from "../security/credentials.js";
import { withLock } from "../sessions/lock.js";

const DraftSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  reference: z.string().max(256),
  applicationId: z.uuid().optional(),
  pid: z.number().int().positive().optional(),
  updatedAt: z.number().optional(),
  closed: z.boolean().optional(),
  images: z.array(ImageAttachmentSchema).max(IMAGE_LIMIT).optional(),
});
export type TerminalDraftIdentity = string | { applicationId: string };
const revisions = new Map<string, number>();
const restoredText = (text: string | undefined) =>
  text?.trim() === "/cwd" ? "" : text;
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
export async function loadTerminalComposerDraft(
  root: TerminalDraftIdentity,
  sessionId?: string,
): Promise<ComposerDraft | undefined> {
  const key = identity(root, sessionId),
    path = join(await packageDirectory(".terminal-drafts"), `${key}.json`);
  return withLock(path, async () => {
    try {
      const data = DraftSchema.parse(await boundedJson(path, 8192));
      revisions.set(key, data.revision);
      return readDraft(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        revisions.set(key, 0);
        return undefined;
      }
      throw error;
    }
  });
}
export interface ComposerDraft {
  text: string;
  images: readonly ImageAttachment[];
}

async function readDraft(
  data: z.infer<typeof DraftSchema>,
): Promise<ComposerDraft | undefined> {
  const text = restoredText(await new CredentialStore().get(data.reference));
  return text === undefined && !data.images?.length
    ? undefined
    : { text: text ?? "", images: data.images ?? [] };
}

export async function loadTerminalDraft(
  root: TerminalDraftIdentity,
  sessionId?: string,
): Promise<string | undefined> {
  return (await loadTerminalComposerDraft(root, sessionId))?.text;
}

export async function saveTerminalDraft(
  root: TerminalDraftIdentity,
  sessionId: string | undefined,
  text: string,
  options: { closed?: boolean; images?: readonly ImageAttachment[] } = {},
): Promise<void> {
  protectImages(options.images ?? []);
  const key = identity(root, sessionId),
    path = join(await packageDirectory(".terminal-drafts"), `${key}.json`);
  if (text.length > 256000)
    throw new Error("Черновик слишком большой для сохранения.");
  await withLock(path, async (assertOwned) => {
    let revision = 0;
    let priorReference: string | undefined;
    try {
      const previous = DraftSchema.parse(await boundedJson(path, 8192));
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
        { closed: true, images: options.images },
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
        ...(options.images?.length ? { images: options.images } : {}),
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
export async function loadApplicationComposerDraft(): Promise<
  ComposerDraft | undefined
> {
  const directory = await packageDirectory(".terminal-drafts");
  const candidates: Array<z.infer<typeof DraftSchema>> = [];
  for (const name of (await readdir(directory))
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .slice(-500)) {
    try {
      const data = DraftSchema.parse(
        await boundedJson(join(directory, name), 8192),
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
  return latest ? readDraft(latest) : undefined;
}

export async function loadApplicationDraft(): Promise<string | undefined> {
  return (await loadApplicationComposerDraft())?.text;
}
