import { z } from "zod";
import { BACKGROUND_LIMITS } from "./config.js";
export const ShellInputSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <= BACKGROUND_LIMITS.commandBytes,
      ),
    cwd: z.string().optional(),
    timeout: z.number().int().min(1000).max(600000).optional(),
    background: z.boolean().optional(),
    taskKind: z.enum(["batch", "service"]).optional(),
    label: z.string().trim().min(1).max(120).optional(),
    deadlineMs: z
      .number()
      .int()
      .min(1000)
      .max(BACKGROUND_LIMITS.serviceCeilingMs)
      .optional(),
    outputBytes: z
      .number()
      .int()
      .min(1024)
      .max(BACKGROUND_LIMITS.outputBytes)
      .optional(),
    readySignal: z.string().min(1).max(240).optional(),
    targetWorktreeId: z.uuid().optional(),
    retryOf: z.uuid().optional(),
  })
  .strict();
export type ShellInput = z.infer<typeof ShellInputSchema>;
export interface ShellData extends ShellInput {
  cwd: string;
  timeout: number;
  actualRoot: string;
  worktree?: { id: string; label: string; base: string };
}
