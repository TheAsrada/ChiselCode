import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";

export interface ProcessExecutionIdentity {
  taskId: string;
  ownerId: string;
  label: string;
  foreground: boolean;
  instance: string;
  token: string;
}
/** Private start-channel capability; never accepted from a tool or extension DTO. */
export interface ProcessProofGrant extends ProcessExecutionIdentity {
  path: string;
}
export const CleanupProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.uuid(),
    ownerId: z.uuid(),
    instance: z.uuid(),
    token: z.uuid(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    cleanup: z.boolean(),
    escaped: z.boolean(),
    ownerGone: z.boolean(),
    finishedAt: z.iso.datetime(),
  })
  .strict();
export type CleanupProof = z.infer<typeof CleanupProofSchema>;
export async function readCleanupProof(
  path: string,
  expected: Pick<
    ProcessExecutionIdentity,
    "taskId" | "ownerId" | "instance" | "token"
  >,
): Promise<CleanupProof | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return;
    const parsed = CleanupProofSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    if (!parsed.success) return;
    const proof = parsed.data;
    if (
      proof.taskId === expected.taskId &&
      proof.ownerId === expected.ownerId &&
      proof.instance === expected.instance &&
      proof.token === expected.token &&
      proof.cleanup &&
      !proof.escaped
    )
      return proof;
  } catch (error) {
    if (error instanceof SyntaxError) return;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
