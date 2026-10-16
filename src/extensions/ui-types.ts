import { z } from "zod";
import type { UI_SURFACES, UiNode } from "../extension-sdk/ui-composition.js";
import type { Disposable } from "./contracts.js";

export type {
  UiNode,
  UiRenderPatch,
  UiSurface,
} from "../extension-sdk/ui-composition.js";
export { UI_SURFACES } from "../extension-sdk/ui-composition.js";

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
export const UiNodeSchema: z.ZodType<UiNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({ type: z.literal("native"), key: UiIdSchema.optional() })
      .strict(),
    z
      .object({
        type: z.literal("text"),
        key: UiIdSchema.optional(),
        text: z.string().max(2000),
        tone: UiToneSchema.optional(),
        bold: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("value"),
        key: UiIdSchema.optional(),
        field: z.enum(["text", "title", "state", "count", "path"]),
        tone: UiToneSchema.optional(),
        maxLength: z.number().int().min(1).max(20000).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("button"),
        key: UiIdSchema.optional(),
        label: title,
        action: UiActionUseSchema,
        tone: UiToneSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("box"),
        key: UiIdSchema.optional(),
        direction: z.enum(["row", "column"]).optional(),
        gap: z.number().int().min(0).max(3).optional(),
        padding: z.number().int().min(0).max(2).optional(),
        border: z.boolean().optional(),
        grow: z.boolean().optional(),
        tone: UiToneSchema.optional(),
        children: z.array(UiNodeSchema).max(32),
      })
      .strict(),
  ]),
);
export const UiRenderPatchSchema = z
  .object({
    mode: z.enum(["before", "after", "replace", "hide"]),
    content: UiNodeSchema.optional(),
  })
  .strict()
  .refine(
    (patch) => (patch.mode === "hide" ? !patch.content : !!patch.content),
    "Render content is required unless hidden.",
  );

/** Bound recursion before schema traversal and collect action uses for the existing dispatcher. */
export function uiNodeInfo(root?: UiNode) {
  const actions: z.infer<typeof UiActionUseSchema>[] = [];
  const buttons: {
    label: string;
    action: z.infer<typeof UiActionUseSchema>;
  }[] = [];
  const pending = root ? [{ node: root, depth: 1 }] : [];
  let count = 0,
    native = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 128 || depth > 8) throw new Error("UI tree limit exceeded.");
    if (node.type === "native") native++;
    if (node.type === "button") {
      actions.push(node.action);
      buttons.push({ label: node.label, action: node.action });
    }
    if (node.type === "box") {
      const keys = node.children
        .filter((child) => child.key)
        .map((child) => child.key);
      if (new Set(keys).size !== keys.length)
        throw new Error("Duplicate UI child key.");
      for (const child of [...node.children].reverse())
        pending.push({ node: child, depth: depth + 1 });
    }
  }
  if (native > 1)
    throw new Error("A UI patch may embed native content only once.");
  return { actions, buttons, native, count };
}
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
    render: UiRenderPatchSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      new Set((value.rows ?? []).map((row) => row.id)).size ===
      (value.rows?.length ?? 0),
    "Duplicate UI row identity.",
  );
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
  .strict()
  .refine(
    (value) =>
      [value.fields ?? [], value.rows ?? []].every(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
      ),
    "Duplicate UI details identity.",
  );
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
  readonly slot: "status" | "context_section" | "menu_entry" | "render";
  readonly surfaces?: readonly (typeof UI_SURFACES)[number][];
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
