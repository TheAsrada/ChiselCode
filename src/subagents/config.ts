import { z } from "zod";

export const SUBAGENT_PRESENTATION = Object.freeze({
  inlineResultBytes: 16 * 1024,
  resultBytes: 64 * 1024,
  progressEntries: 256,
});
export const SUBAGENT_WAIT_MS = 30_000;
export const SUBAGENT_SHUTDOWN_MS = 10_000;
const SubagentFieldsSchema = z
  .object({
    enabled: z.boolean().default(true),
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
    "maxActive",
    "deadlineMs",
    "iterations",
    "attempts",
    "tools",
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
  };
}
