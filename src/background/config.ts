import { z } from "zod";

export const BACKGROUND_LIMITS = Object.freeze({
  activePerOwner: 2,
  activePerApplication: 4,
  queuedPerOwner: 8,
  acceptedPerOwner: 256,
  batchMs: 600_000,
  batchCeilingMs: 7_200_000,
  serviceMs: 3_600_000,
  serviceCeilingMs: 28_800_000,
  outputBytes: 16 * 1024 * 1024,
  ownerBytes: 128 * 1024 * 1024,
  applicationBytes: 512 * 1024 * 1024,
  pageBytes: 32 * 1024,
  inlineBytes: 8 * 1024,
  waitMs: 30_000,
  cleanupMs: 10_000,
  history: 100,
  retentionDays: 7,
  commandBytes: 16 * 1024,
});
export const BackgroundConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxActive: z.number().int().min(1).max(2).default(2),
    batchDeadlineMs: z
      .number()
      .int()
      .min(1000)
      .max(BACKGROUND_LIMITS.batchCeilingMs)
      .default(BACKGROUND_LIMITS.batchMs),
    serviceDeadlineMs: z
      .number()
      .int()
      .min(1000)
      .max(BACKGROUND_LIMITS.serviceCeilingMs)
      .default(BACKGROUND_LIMITS.serviceMs),
    outputBytes: z
      .number()
      .int()
      .min(1024)
      .max(BACKGROUND_LIMITS.outputBytes)
      .default(BACKGROUND_LIMITS.outputBytes),
    retentionDays: z.number().int().min(1).max(7).default(7),
  })
  .strict();
export type BackgroundConfig = z.infer<typeof BackgroundConfigSchema>;
export const ProjectBackgroundConfigSchema = z
  .object({
    enabled: BackgroundConfigSchema.shape.enabled.unwrap().optional(),
    maxActive: BackgroundConfigSchema.shape.maxActive.unwrap().optional(),
    batchDeadlineMs: BackgroundConfigSchema.shape.batchDeadlineMs
      .unwrap()
      .optional(),
    serviceDeadlineMs: BackgroundConfigSchema.shape.serviceDeadlineMs
      .unwrap()
      .optional(),
    outputBytes: BackgroundConfigSchema.shape.outputBytes.unwrap().optional(),
    retentionDays: BackgroundConfigSchema.shape.retentionDays
      .unwrap()
      .optional(),
  })
  .strict();
export type ProjectBackgroundConfig = z.infer<
  typeof ProjectBackgroundConfigSchema
>;
export function effectiveBackgroundConfig(
  global?: BackgroundConfig,
  project?: ProjectBackgroundConfig,
): BackgroundConfig {
  const base = BackgroundConfigSchema.parse(global ?? {});
  return {
    enabled: base.enabled && project?.enabled !== false,
    maxActive: Math.min(base.maxActive, project?.maxActive ?? base.maxActive),
    batchDeadlineMs: Math.min(
      base.batchDeadlineMs,
      project?.batchDeadlineMs ?? base.batchDeadlineMs,
    ),
    serviceDeadlineMs: Math.min(
      base.serviceDeadlineMs,
      project?.serviceDeadlineMs ?? base.serviceDeadlineMs,
    ),
    outputBytes: Math.min(
      base.outputBytes,
      project?.outputBytes ?? base.outputBytes,
    ),
    retentionDays: Math.min(
      base.retentionDays,
      project?.retentionDays ?? base.retentionDays,
    ),
  };
}
