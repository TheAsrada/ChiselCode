import { z } from "zod";
import type {
  UI_SURFACES,
  UiColor,
  UiEventUse,
  UiInputEvent,
  UiNode,
  UiStyle,
} from "../extension-sdk/ui-composition.js";
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
export const UiColorSchema = z.union([
  z.enum([
    "bg",
    "surface",
    "raised",
    "border",
    "text",
    "muted",
    "accent",
    "green",
    "red",
    "yellow",
  ]),
  z.string().regex(/^#[\da-fA-F]{6}$/),
]) as z.ZodType<UiColor>;
const dimension = z.union([
  z.number().int().min(1).max(1000),
  z.string().regex(/^(?:100|[1-9]?\d)%$/),
]) as z.ZodType<number | `${number}%`>;
export const UiStyleSchema = z
  .object({
    fg: UiColorSchema.optional(),
    bg: UiColorSchema.optional(),
    width: dimension.optional(),
    height: z.number().int().min(1).max(200).optional(),
    minWidth: z.number().int().min(0).max(1000).optional(),
    maxWidth: z.number().int().min(1).max(1000).optional(),
    padding: z.number().int().min(0).max(8).optional(),
    gap: z.number().int().min(0).max(8).optional(),
    grow: z.number().min(0).max(100).optional(),
    shrink: z.number().min(0).max(100).optional(),
    border: z.boolean().optional(),
    borderColor: UiColorSchema.optional(),
    borderStyle: z.enum(["single", "double", "rounded", "heavy"]).optional(),
    align: z.enum(["flex-start", "center", "flex-end", "stretch"]).optional(),
    justify: z
      .enum([
        "flex-start",
        "center",
        "flex-end",
        "space-between",
        "space-around",
      ])
      .optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    dim: z.boolean().optional(),
    wrap: z.enum(["word", "char", "none"]).optional(),
  })
  .strict() satisfies z.ZodType<UiStyle>;
export const UiInputEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("press") }).strict(),
  z
    .object({
      type: z.enum(["change", "submit"]),
      value: z.string().max(20000),
    })
    .strict(),
  z
    .object({
      type: z.literal("select"),
      value: z.string().max(120),
      index: z.number().int().min(0).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("pointer"),
      x: z.number().int().min(0).max(1000),
      y: z.number().int().min(0).max(200),
      button: z.number().int().min(0).max(5),
    })
    .strict(),
  z
    .object({
      type: z.literal("key"),
      name: z.string().max(40),
      sequence: z.string().max(32),
      ctrl: z.boolean(),
      shift: z.boolean(),
      meta: z.boolean(),
    })
    .strict(),
]);
const nodeBase = {
  key: UiIdSchema.optional(),
  style: UiStyleSchema.optional(),
};
const eventUse = UiActionUseSchema;
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
      .object({
        type: z.literal("native"),
        ...nodeBase,
        props: UiStyleSchema.extend({
          title: title.optional(),
          placeholder: title.optional(),
        })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("text"),
        ...nodeBase,
        text: z.string().max(2000),
        tone: UiToneSchema.optional(),
        bold: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("value"),
        ...nodeBase,
        field: z.enum(["text", "title", "state", "count", "path"]),
        tone: UiToneSchema.optional(),
        maxLength: z.number().int().min(1).max(20000).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("button"),
        ...nodeBase,
        label: title,
        action: UiActionUseSchema,
        tone: UiToneSchema.optional(),
        hotkey: z
          .string()
          .regex(/^(?:(?:ctrl|alt|shift)\+)*(?:[a-z0-9]|f\d{1,2})$/)
          .optional(),
        disabled: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("input"),
        ...nodeBase,
        key: UiIdSchema,
        label: title,
        value: z.string().max(20000),
        placeholder: title.optional(),
        maxLength: z.number().int().min(1).max(20000).optional(),
        onChange: eventUse.optional(),
        onSubmit: eventUse.optional(),
        disabled: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("select"),
        ...nodeBase,
        key: UiIdSchema,
        label: title,
        value: title.optional(),
        options: z
          .array(
            z
              .object({
                value: title,
                label: title,
                description: detail.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        onSelect: eventUse,
        disabled: z.boolean().optional(),
      })
      .strict()
      .refine(
        (n) => new Set(n.options.map((o) => o.value)).size === n.options.length,
      ),
    z
      .object({
        type: z.literal("markdown"),
        ...nodeBase,
        text: z.string().max(20000),
      })
      .strict(),
    z
      .object({
        type: z.literal("code"),
        ...nodeBase,
        text: z.string().max(20000),
        language: z
          .string()
          .regex(/^[\w+-]{1,40}$/)
          .optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("image"),
        ...nodeBase,
        data: z
          .string()
          .max(48000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        alt: title,
        fit: z.enum(["fit", "cover", "fill"]).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("canvas"),
        ...nodeBase,
        key: UiIdSchema,
        label: title,
        rows: z
          .array(
            z
              .array(
                z
                  .object({
                    text: z.string().max(1000),
                    fg: UiColorSchema.optional(),
                    bg: UiColorSchema.optional(),
                  })
                  .strict(),
              )
              .max(200),
          )
          .max(100),
        onPointer: eventUse.optional(),
        onKey: eventUse.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("box"),
        ...nodeBase,
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
  const events: {
    node: UiNode;
    use: UiEventUse;
    type: UiInputEvent["type"];
  }[] = [];
  const controls: UiNode[] = [];
  const keys = new Set<string>();
  let count = 0,
    native = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 128 || depth > 8) throw new Error("UI tree limit exceeded.");
    if (node.type === "native") native++;
    if (node.key && ["input", "select", "canvas"].includes(node.type)) {
      if (keys.has(node.key)) throw new Error("Duplicate UI input key.");
      keys.add(node.key);
    }
    if (
      ((node.type === "input" ||
        node.type === "select" ||
        node.type === "button") &&
        !node.disabled) ||
      (node.type === "canvas" && (node.onKey || node.onPointer))
    )
      controls.push(node);
    if (node.type === "input") {
      if (node.onChange)
        events.push({ node, use: node.onChange, type: "change" });
      if (node.onSubmit)
        events.push({ node, use: node.onSubmit, type: "submit" });
    }
    if (node.type === "select")
      events.push({ node, use: node.onSelect, type: "select" });
    if (node.type === "canvas") {
      if (node.onPointer)
        events.push({ node, use: node.onPointer, type: "pointer" });
      if (node.onKey) events.push({ node, use: node.onKey, type: "key" });
    }
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
  return { actions, buttons, native, count, events, controls };
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
  readonly presentation?: import("../extension-sdk/ui-composition.js").UiPresentationContext;
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
      readonly type: "event";
      readonly eventId: string;
    }
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
  readonly slot:
    | "status"
    | "context_section"
    | "menu_entry"
    | "render"
    | "pane";
  readonly placement?: "sidebar" | "above_prompt" | "below_prompt";
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
export type UiEventHandler = (
  binding: UiBinding,
  event: Readonly<UiInputEvent>,
  args: Readonly<import("../extension-sdk/index.js").JsonObject>,
) => void | Promise<void>;
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
