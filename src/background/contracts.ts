import { z } from "zod";
import {
  type OwnedChatPresentation,
  OwnedChatPresentationSchema,
} from "../types/chat-presentation.js";

export const BACKGROUND_STATES = [
  "queued",
  "waiting_resources",
  "awaiting_approval",
  "starting",
  "running",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "output_limit",
  "start_failed",
  "denied",
  "interrupted",
  "lost",
  "cleanup_unknown",
] as const;
export type BackgroundState = (typeof BACKGROUND_STATES)[number];
export function backgroundActive(state: BackgroundState): boolean {
  return [
    "queued",
    "waiting_resources",
    "awaiting_approval",
    "starting",
    "running",
    "stopping",
  ].includes(state);
}
export const BackgroundTaskSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    operationKey: z.string().max(500),
    ordinal: z.number().int().positive(),
    rootOwnerId: z.uuid(),
    sessionId: z.uuid(),
    conversationId: z.string().max(240),
    generation: z.number().int().nonnegative(),
    invocationId: z.string().max(240),
    turnId: z.string().max(240),
    childId: z.uuid().optional(),
    ownerLabel: z.string().max(240),
    origin: z.string().max(4096),
    workspace: z.string().max(4096),
    workspaceLabel: z.string().max(240),
    worktree: z
      .object({
        id: z.uuid(),
        label: z.string().max(120),
        base: z.string().max(64),
      })
      .optional(),
    label: z.string().max(120),
    commandPreview: z.string().max(16384),
    replayable: z.boolean(),
    kind: z.enum(["batch", "service"]),
    foreground: z.boolean().default(false),
    promoted: z.boolean().optional(),
    state: z.enum(BACKGROUND_STATES),
    revision: z.number().int().nonnegative(),
    terminalRevision: z.number().int().nonnegative().optional(),
    acceptedAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    deadline: z.string(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    readiness: z.enum(["unknown", "signal_seen", "verified_probe", "exited"]),
    readySignal: z.string().max(240).optional(),
    tail: z.array(z.string().max(2000)).max(3),
    outputBytes: z.number().int().nonnegative(),
    outputLines: z.number().int().nonnegative().default(0),
    outputLimit: z.number().int().positive(),
    outputGeneration: z.uuid(),
    outputExpired: z.boolean().optional(),
    truncated: z.boolean().default(false),
    cleanup: z.object({
      confirmed: z.boolean(),
      recoveryRequired: z.boolean().optional(),
    }),
    resources: z
      .array(
        z.object({
          resource: z.string().max(4096),
          mode: z.enum(["read", "write"]),
        }),
      )
      .max(32),
    error: z.string().max(4096).optional(),
    retryOf: z.uuid().optional(),
    process: z
      .object({
        instance: z.uuid(),
        pid: z.number().int().positive().optional(),
        applicationPid: z.number().int().positive(),
        host: z.string(),
        start: z.string().optional(),
        token: z.uuid(),
      })
      .optional(),
    presentation: OwnedChatPresentationSchema.optional(),
  })
  .strict();
export type BackgroundTaskRecord = z.infer<typeof BackgroundTaskSchema>;
export type BackgroundTask = Omit<
  BackgroundTaskRecord,
  "schemaVersion" | "operationKey" | "process"
>;
export interface BackgroundOutputPage {
  id: string;
  generation: string;
  oldest: number;
  cursor: number;
  next: number;
  end: number;
  text: string;
  truncated: boolean;
  eof: boolean;
  expired: boolean;
  streams: "combined";
  ordering: "append_sequence";
}
export interface BackgroundPort {
  list(): Promise<readonly BackgroundTask[]>;
  status(id: string): Promise<BackgroundTask>;
  readOutput(
    id: string,
    cursor?: number,
    limit?: number,
    generation?: string,
  ): Promise<BackgroundOutputPage>;
  wait(
    ids: readonly string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<readonly BackgroundTask[]>;
  stop(id: string): Promise<BackgroundTask>;
  recover(id: string): Promise<BackgroundTask>;
  deleteHistory(id: string): Promise<BackgroundTask>;
}
export interface BackgroundEvent {
  type: "accepted" | "changed" | "terminal" | "foreground";
  ownerId: string;
  task: BackgroundTask;
  presentation?: OwnedChatPresentation;
}
export const BackgroundReceiptSchema = z
  .object({
    id: z.uuid(),
    revision: z.number().int().nonnegative(),
    state: z.enum(BACKGROUND_STATES),
    label: z.string().max(120),
    kind: z.enum(["batch", "service"]),
    childId: z.uuid().optional(),
    afterMessage: z.number().int().nonnegative(),
    presentation: OwnedChatPresentationSchema.optional(),
  })
  .strict();
export type BackgroundReceipt = z.infer<typeof BackgroundReceiptSchema>;
