import { z } from "zod";
export const SessionUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheCreationTokens: z.number().nonnegative().optional(),
});
export const ModelSpendSchema = z.object({
  usage: SessionUsageSchema,
  knownCost: z.number().finite().nonnegative(),
  unknownCost: z.boolean(),
  unknownUsage: z.boolean(),
});
