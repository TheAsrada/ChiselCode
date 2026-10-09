import { z } from "zod";
import { AGENT_MODES, DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import {
  APPROVAL_MODE_INPUTS,
  normalizeApprovalMode,
} from "../security/approval-mode.js";
export const FileRevisionSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});
export const StructuredSummarySchema = z.object({
  goal: z.string(),
  userConstraints: z.array(z.string()),
  relevantArchitecture: z.array(z.string()),
  decisions: z.array(z.string()),
  workCompleted: z.array(z.string()),
  changedFiles: z.record(z.string(), z.string()),
  verification: z.array(z.string()),
  failedAttempts: z.array(z.string()),
  openProblems: z.array(z.string()),
  importantReferences: z.array(z.string()),
  nextAction: z.string(),
});
const FileDiffSchema = z.object({
  path: z.string(),
  kind: z.enum(["create", "edit", "delete"]),
  patch: z.string(),
  additions: z.number(),
  deletions: z.number(),
});
export const ToolResultSchema = z.object({
  references: z
    .array(
      z.object({
        uri: z.string().max(4096),
        title: z.string().max(240).optional(),
        kind: z.enum(["opened", "search_result"]),
      }),
    )
    .max(10)
    .optional(),
  contentTrust: z.literal("untrusted_external").optional(),
  output: z.string(),
  isError: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  preview: z.string().optional(),
  fileDiff: FileDiffSchema.optional(),
  diffs: z.array(FileDiffSchema).optional(),
  errorCode: z.string().optional(),
  artifact: z.object({ uri: z.string(), tokens: z.number() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  sandboxed: z.boolean().optional(),
});
export const SessionRuntimeSchema = z.object({
  turnMode: z.enum(AGENT_MODES).optional(),
  turnApprovalMode: z
    .enum(APPROVAL_MODE_INPUTS)
    .transform(normalizeApprovalMode)
    .optional(),
  turnId: z.string().optional(),
  state: z
    .enum([
      "preparing_context",
      "calling_provider",
      "processing_response",
      "executing_tools",
      "awaiting_approval",
      "completed",
      "failed",
      "cancelled",
    ])
    .optional(),
  invocations: z.record(
    z.string(),
    z.object({
      id: z.string(),
      name: z.string(),
      toolSource: z
        .discriminatedUnion("type", [
          z.object({ type: z.literal("local") }),
          z.object({ type: z.literal("skill") }),
          z.object({
            type: z.literal("extension"),
            extensionId: z.string(),
            originalName: z.string(),
          }),
          z.object({
            type: z.literal("web"),
            operation: z.enum(["search", "fetch"]),
          }),
          z.object({
            type: z.literal("mcp"),
            serverId: z.string(),
            originalName: z.string(),
            serverTitle: z.string(),
            title: z.string().optional(),
            category: z.enum(["read", "write", "destructive", "unknown"]),
            classificationReason: z.string(),
            annotations: z
              .object({
                readOnlyHint: z.boolean().optional(),
                destructiveHint: z.boolean().optional(),
                idempotentHint: z.boolean().optional(),
                openWorldHint: z.boolean().optional(),
              })
              .optional(),
          }),
        ])
        .optional(),
      input: z.record(z.string(), z.unknown()),
      fingerprint: z.string(),
      state: z.enum([
        "queued",
        "prepared",
        "awaiting_approval",
        "running",
        "succeeded",
        "failed",
        "denied",
        "cancelled",
      ]),
      createdAt: z.string(),
      updatedAt: z.string(),
      result: ToolResultSchema.optional(),
      approvalPreview: z.string().optional(),
    }),
  ),
  workspaceObservations: z.record(z.string(), FileRevisionSchema),
  failedCalls: z
    .record(
      z.string(),
      z.object({
        count: z.number().int().nonnegative(),
        workspaceVersion: z.number().int().nonnegative(),
      }),
    )
    .default({}),
  workspaceVersion: z.number().int().nonnegative().optional(),
});
export const SessionContextSchema = z.object({
  activeCheckpoint: z
    .object({
      id: z.string(),
      summary: StructuredSummarySchema,
      throughMessageIndex: z.number().int().nonnegative(),
      createdAt: z.string(),
      estimatedTokens: z.number().nonnegative(),
      preservedUserMessageIndex: z.number().int().nonnegative().optional(),
      source: z.enum(["model", "evidence"]).optional(),
    })
    .optional(),
  compactions: z
    .array(
      z.object({
        id: z.string(),
        afterMessage: z.number().int().nonnegative(),
        beforeTokens: z.number().nonnegative(),
        afterTokens: z.number().nonnegative(),
        estimated: z.boolean(),
        durationMs: z.number().nonnegative(),
        reason: z.enum(["auto", "overflow"]),
        source: z.enum(["model", "evidence"]),
        createdAt: z.string(),
      }),
    )
    .optional(),
});

export const SessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const SessionTimestampSchema = z.iso.datetime({ offset: true });
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
export const SideQueryRecordSchema = z.object({
  operationId: SessionIdSchema,
  owner: z.object({
    extensionId: z.string().min(1).max(128),
    conversationId: z.string().min(1),
    sessionId: SessionIdSchema,
    workspaceRoot: z.string(),
    generation: z.number().int().nonnegative(),
  }),
  command: z.string().min(1).max(64),
  question: z
    .string()
    .refine((text) => Buffer.byteLength(text, "utf8") <= 8192),
  providerId: z.string().min(1),
  profileId: z.string().min(1),
  model: z.string(),
  status: z.enum([
    "accepted",
    "preparing",
    "receiving",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
    "truncated",
    "interrupted",
  ]),
  text: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= 65536),
  error: z
    .object({ code: z.string().max(100), message: z.string().max(1000) })
    .optional(),
  usage: SessionUsageSchema.optional(),
  usageSource: z.enum(["observed", "partial", "unknown"]),
  cost: z.object({
    usd: z.number().finite().nonnegative().optional(),
    source: z.enum(["provider", "estimated", "unknown"]),
  }),
  knownCost: z.number().finite().nonnegative(),
  context: z.object({
    capturedAt: SessionTimestampSchema,
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
    estimatedTokens: z.number().int().nonnegative(),
    accounting: z.enum(["estimated", "count_tokens"]),
  }),
  attempts: z.number().int().min(0).max(3),
  acceptedAt: SessionTimestampSchema,
  updatedAt: SessionTimestampSchema,
  finishedAt: SessionTimestampSchema.optional(),
  afterMessage: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  persistenceError: z.string().max(1000).optional(),
});
const contentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);
export const SessionV3Schema = z.looseObject({
  worktree: z
    .object({
      id: z.uuid(),
      label: z.string().max(120),
      base: z.string().regex(/^[a-f0-9]{40,64}$/),
      origin: z.string(),
    })
    .optional(),
  mainSpend: ModelSpendSchema.optional(),
  sideQueries: z.array(SideQueryRecordSchema).optional(),
  sideQuerySpend: z.record(SessionIdSchema, ModelSpendSchema).optional(),
  mode: z.enum(AGENT_MODES).default(DEFAULT_AGENT_MODE),
  approvalMode: z
    .enum(APPROVAL_MODE_INPUTS)
    .transform(normalizeApprovalMode)
    .optional(),
  schemaVersion: z.literal(3),
  runtime: SessionRuntimeSchema.optional(),
  context: SessionContextSchema.optional(),
  id: SessionIdSchema,
  title: z.string(),
  titleSource: z.enum(["auto", "user"]),
  createdAt: SessionTimestampSchema,
  updatedAt: SessionTimestampSchema,
  providerId: z.string().min(1),
  profileId: z.string().min(1),
  model: z.string(),
  gitBranch: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.array(contentSchema),
    }),
  ),
  requestTimings: z
    .array(
      z.object({
        afterMessage: z.number().int().nonnegative(),
        elapsedMs: z.number().finite().nonnegative(),
        status: z.enum([
          "completed",
          "approval_required",
          "failed",
          "cancelled",
        ]),
      }),
    )
    .optional(),
  totalTokens: SessionUsageSchema,
  contextSnapshot: z
    .object({
      model: z.string(),
      observedInputTokens: z.number().nonnegative(),
      contextWindow: z.number().positive().optional(),
      occupiedTokens: z.number().nonnegative().optional(),
      localTokens: z.number().nonnegative().optional(),
      connectionId: z.string().optional(),
      windowSource: z.enum(["provider", "catalog", "config"]).optional(),
      observedAt: SessionTimestampSchema,
      source: z.enum(["provider_usage", "count_tokens", "local_estimate"]),
      status: z.enum(["observed", "estimated"]),
    })
    .optional(),
  totalCost: z.number(),
  costEstimate: z
    .object({
      usd: z.number().nonnegative().optional(),
      source: z.enum(["provider", "estimated", "unknown"]),
    })
    .optional(),
  undoStack: z.array(
    z.object({
      path: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  fileDiffs: z
    .record(
      z.string(),
      z.object({
        path: z.string(),
        kind: z.enum(["create", "edit", "delete"]),
        patch: z.string(),
        additions: z.number(),
        deletions: z.number(),
      }),
    )
    .optional(),
});
