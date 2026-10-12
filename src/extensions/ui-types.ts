import { z } from "zod";
import type { Disposable } from "./contracts.js";

export const UiIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const UiToneSchema = z.enum([
  "muted",
  "accent",
  "success",
  "warning",
  "error",
]);
export const UiStateSchema = z.enum([
  "loading",
  "empty",
  "ready",
  "stale",
  "error",
  "unavailable",
]);
const title = z.string().max(120);
const detail = z.string().max(2000);
export const UiActionUseSchema = z
  .object({
    id: UiIdSchema,
    args: z.record(z.string(), z.json()).optional(),
  })
  .strict();
export const UiRowSchema = z
  .object({
    id: UiIdSchema,
    label: title,
    value: detail.optional(),
    detail: detail.optional(),
    tone: UiToneSchema.optional(),
    action: UiActionUseSchema.optional(),
  })
  .strict();
export const UiSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    state: UiStateSchema,
    label: title.optional(),
    detail: detail.optional(),
    tone: UiToneSchema.optional(),
    count: z.number().int().min(0).max(1_000_000).optional(),
    rows: z.array(UiRowSchema).max(8).optional(),
    action: UiActionUseSchema.optional(),
  })
  .strict();
export const UiDetailsPageSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    state: UiStateSchema,
    summary: detail.optional(),
    fields: z.array(UiRowSchema).max(16).optional(),
    rows: z.array(UiRowSchema).max(100).optional(),
    nextCursor: z.string().max(120).optional(),
    actions: z.array(UiActionUseSchema).max(6).optional(),
  })
  .strict();
export type UiSnapshot = z.infer<typeof UiSnapshotSchema>;
export type UiDetailsPage = z.infer<typeof UiDetailsPageSchema>;
export type UiRow = z.infer<typeof UiRowSchema>;
export type UiActionUse = z.infer<typeof UiActionUseSchema>;
export type UiTone = z.infer<typeof UiToneSchema>;

/** Read-only owner projection. No Session or runtime authority crosses this port. */
export interface UiOwnerSummary {
  readonly background: {
    readonly active: number;
    readonly errors: number;
    readonly awaitingApproval: number;
  };
  readonly agents: {
    readonly active: number;
    readonly total: number;
    readonly errors: number;
  };
}
export interface UiBinding {
  readonly workspaceRoot: string;
  readonly scopeInstance: string;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly read: {
    ownerSummary(): UiOwnerSummary;
    subscribeOwner(changed: () => void): Disposable;
  };
}
/** Opaque navigation reference. Only application composition can attest one. */
declare const coreTarget: unique symbol;
export interface UiCoreTarget {
  readonly [coreTarget]: true;
}
export type UiAction =
  | {
      readonly id: string;
      readonly label: string;
      readonly type: "view";
      readonly viewId: string;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly type: "tool";
      readonly tool: string;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly type: "core";
      readonly target: UiCoreTarget;
    };
export interface UiSource<T> {
  snapshot(binding: UiBinding): T | Promise<T>;
  subscribe?(binding: UiBinding, changed: () => void): Disposable;
}
export interface UiContribution {
  readonly id: string;
  readonly slot: "status" | "context_section" | "menu_entry";
  readonly scope: "workspace" | "conversation";
  readonly title: string;
  readonly description?: string;
  readonly group?: "conversation" | "project" | "extensions";
  readonly shortcut?: string;
  readonly order?: number;
  readonly actions?: readonly UiAction[];
  readonly source: UiSource<UiSnapshot>;
}
export interface UiDetailsView {
  readonly id: string;
  readonly scope: "workspace" | "conversation";
  readonly title: string;
  readonly actions?: readonly UiAction[];
  page(
    binding: UiBinding,
    request: Readonly<{ cursor?: string; search?: string }>,
  ): UiDetailsPage | Promise<UiDetailsPage>;
  subscribe?(binding: UiBinding, changed: () => void): Disposable;
}
export interface OwnedUiContribution {
  readonly key: string;
  readonly extensionId: string;
  readonly descriptor: Readonly<Omit<UiContribution, "source" | "actions">>;
  readonly snapshot: Readonly<UiSnapshot>;
}
