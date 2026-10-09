import { z } from "zod";

export const SUBAGENT_LIMITS = Object.freeze({
  depth: 1,
  activePerOwner: 2,
  activePerApplication: 4,
  queuedPerOwner: 8,
  acceptedPerOwner: 32,
  deadlineMs: 600_000,
  iterations: 12,
  attempts: 24,
  toolInvocations: 100,
  inputTokens: 16_000,
  outputTokens: 2_048,
  childTokens: 100_000,
  ownerTokens: 200_000,
  taskBytes: 8 * 1024,
  handoffBytes: 64 * 1024,
  inlineResultBytes: 16 * 1024,
  resultBytes: 64 * 1024,
  progressEntries: 256,
  waitMs: 30_000,
  shutdownMs: 10_000,
});
export const SubagentConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxActive: z.number().int().min(1).max(2).default(2),
    deadlineMs: z
      .number()
      .int()
      .min(1000)
      .max(SUBAGENT_LIMITS.deadlineMs)
      .default(SUBAGENT_LIMITS.deadlineMs),
    childTokens: z
      .number()
      .int()
      .min(1024)
      .max(SUBAGENT_LIMITS.childTokens)
      .default(SUBAGENT_LIMITS.childTokens),
    ownerTokens: z
      .number()
      .int()
      .min(1024)
      .max(SUBAGENT_LIMITS.ownerTokens)
      .default(SUBAGENT_LIMITS.ownerTokens),
  })
  .strict();
export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;
// A missing project field inherits the global value; global defaults must not materialize here.
export const ProjectSubagentConfigSchema = z
  .object({
    enabled: SubagentConfigSchema.shape.enabled.unwrap().optional(),
    maxActive: SubagentConfigSchema.shape.maxActive.unwrap().optional(),
    deadlineMs: SubagentConfigSchema.shape.deadlineMs.unwrap().optional(),
    childTokens: SubagentConfigSchema.shape.childTokens.unwrap().optional(),
    ownerTokens: SubagentConfigSchema.shape.ownerTokens.unwrap().optional(),
  })
  .strict();
export type ProjectSubagentConfig = z.infer<typeof ProjectSubagentConfigSchema>;
export function effectiveSubagentConfig(
  global?: SubagentConfig,
  project?: ProjectSubagentConfig,
): SubagentConfig {
  const base = SubagentConfigSchema.parse(global ?? {});
  return {
    enabled: base.enabled && project?.enabled !== false,
    maxActive: Math.min(base.maxActive, project?.maxActive ?? base.maxActive),
    deadlineMs: Math.min(
      base.deadlineMs,
      project?.deadlineMs ?? base.deadlineMs,
    ),
    childTokens: Math.min(
      base.childTokens,
      project?.childTokens ?? base.childTokens,
    ),
    ownerTokens: Math.min(
      base.ownerTokens,
      project?.ownerTokens ?? base.ownerTokens,
    ),
  };
}
