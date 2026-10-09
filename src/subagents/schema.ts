import { z } from "zod";
import { ModelSpendSchema, SessionUsageSchema } from "../models/schema.js";
import { SUBAGENT_STATES } from "./contracts.js";

const text = (bytes: number) =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= bytes);
export const SubagentDescriptorSchema = z.object({
  id: z.uuid(),
  rootOwnerId: z.uuid(),
  parentSessionId: z.uuid(),
  parentConversationId: z.string().min(1).max(128),
  parentGeneration: z.number().int().nonnegative(),
  parentRoot: z.string(),
  parentTurnId: z.string(),
  invocationId: z.string(),
  extensionId: z.string().max(128),
  depth: z.literal(1),
  ordinal: z.number().int().min(1).max(32),
  label: text(512),
  task: text(8192),
  mode: z.enum(["readonly", "coding"]),
  status: z.enum(SUBAGENT_STATES),
  providerId: z.string(),
  profileId: z.string(),
  model: z.string(),
  sessionId: z.uuid().optional(),
  root: z.string().optional(),
  worktree: z
    .object({
      id: z.uuid(),
      path: z.string(),
      label: z.string(),
      base: z.string(),
      origin: z.string(),
    })
    .optional(),
  acceptedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  revision: z.number().int().nonnegative(),
  context: z.object({
    capturedAt: z.iso.datetime(),
    sourceMessageCount: z.number().int().nonnegative(),
    summaryId: z.string().optional(),
    includedMessageRanges: z.array(
      z.object({
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
      }),
    ),
    sources: z.array(z.string()),
    truncated: z.boolean(),
    estimatedTokens: z.number().nonnegative(),
    accounting: z.enum(["estimated", "count_tokens"]),
  }),
  step: text(1024),
  text: text(65536),
  textTruncated: z.boolean(),
  progress: z
    .array(
      z.object({
        sequence: z.number().int().nonnegative(),
        at: z.iso.datetime(),
        type: z.enum(["state", "tool", "text"]),
        text: text(4096),
        tool: z.string().optional(),
        outcome: z.enum(["completed", "failed"]).optional(),
      }),
    )
    .max(256),
  spend: ModelSpendSchema,
  attempts: z
    .array(
      z.object({
        id: z.string(),
        purpose: z.enum(["generation", "compaction", "count_tokens"]),
        reserved: z.number().nonnegative(),
        accounted: z.number().nonnegative(),
        usage: SessionUsageSchema.optional(),
        usageSource: z.enum(["observed", "partial", "unknown"]),
        completed: z.boolean(),
      }),
    )
    .max(24),
  consumption: z.object({
    accountedTokens: z.number().nonnegative(),
    tools: z.number().int().nonnegative(),
    iterations: z.number().int().nonnegative(),
  }),
  limits: z.object({
    deadlineMs: z.number().int().min(1).max(600000),
    tokens: z.number().int().min(1).max(100000),
    iterations: z.number().int().min(1).max(12),
    attempts: z.number().int().min(1).max(24),
    tools: z.number().int().min(1).max(100),
  }),
  cleanup: z.object({
    quiescent: z.boolean(),
    incomplete: z.boolean().optional(),
    recoveryRequired: z.boolean().optional(),
  }),
  error: z
    .object({ code: z.string().max(128), message: text(2048) })
    .optional(),
  artifact: z.object({ uri: z.string(), tokens: z.number() }).optional(),
  persistenceError: text(2048).optional(),
});
export const ChildReceiptSchema = z.object({
  revision: z.number().int().nonnegative(),
  child: SubagentDescriptorSchema,
  spend: ModelSpendSchema,
});
export const SubagentRecordSchema = SubagentDescriptorSchema.extend({
  schemaVersion: z.literal(1),
  operationKey: z.string().min(1),
  process: z
    .object({
      pid: z.number().int().positive(),
      host: z.string(),
      start: z.string().optional(),
      token: z.uuid(),
      heartbeat: z.iso.datetime(),
    })
    .optional(),
});
export const SubagentOwnerRecordsSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  ownerId: z.uuid(),
  records: z.array(SubagentRecordSchema).max(32),
});
