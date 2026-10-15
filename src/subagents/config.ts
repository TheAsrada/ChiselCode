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
  taskBytes: 8 * 1024,
  inlineResultBytes: 16 * 1024,
  resultBytes: 64 * 1024,
  progressEntries: 256,
  waitMs: 30_000,
  shutdownMs: 10_000,
});
const SubagentFieldsSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxActive: z.number().int().min(1).max(2).default(2),
    deadlineMs: z
      .number()
      .int()
      .min(1000)
      .max(SUBAGENT_LIMITS.deadlineMs)
      .default(SUBAGENT_LIMITS.deadlineMs),
  })
  .strict();
// Lazy migration: deprecated quotas are discarded before strict validation.
function migrateSubagentConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value } as Record<string, unknown>;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "childTokens",
    "ownerTokens",
  ])
    delete result[key];
  return result;
}
export const SubagentConfigSchema = z.preprocess(
  migrateSubagentConfig,
  SubagentFieldsSchema,
);
export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;
// A missing project field inherits the global value; global defaults must not materialize here.
const ProjectSubagentFieldsSchema = z
  .object({
    enabled: SubagentFieldsSchema.shape.enabled.unwrap().optional(),
    maxActive: SubagentFieldsSchema.shape.maxActive.unwrap().optional(),
    deadlineMs: SubagentFieldsSchema.shape.deadlineMs.unwrap().optional(),
  })
  .strict();
export const ProjectSubagentConfigSchema = z.preprocess(
  migrateSubagentConfig,
  ProjectSubagentFieldsSchema,
);
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
  };
}
