import { z } from "zod";
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
const ToolResultSchema = z.object({
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
    })
    .optional(),
});
