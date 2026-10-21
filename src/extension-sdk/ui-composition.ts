/** Named render sites. Permission prompts, trusted settings and modal input stay host-owned. */
export const UI_SURFACES = [
  "App",
  "WorkspaceTabs",
  "Header",
  "Home",
  "HomeLogo",
  "HomeHints",
  "Main",
  "Transcript",
  "UserMessage",
  "AssistantMessage",
  "SystemMessage",
  "ToolActions",
  "Skills",
  "FileDiff",
  "ChatCard",
  "CommandOutput",
  "Compaction",
  "RequestStatus",
  "ToolProgress",
  "Composer",
  "PromptHints",
  "PromptControls",
  "AbovePrompt",
  "BelowPrompt",
  "StatusLine",
  "Sidebar",
  "SidebarMenu",
  "ContextPanel",
  "AgentTree",
] as const;
export type UiSurface = (typeof UI_SURFACES)[number];
export type UiValueField = "text" | "title" | "state" | "count" | "path";
export type UiNodeTone = "muted" | "accent" | "success" | "warning" | "error";
/** Theme tokens follow the active palette; hex colors are local to this element. */
export type UiColor =
  | "bg"
  | "surface"
  | "raised"
  | "border"
  | "text"
  | "muted"
  | "accent"
  | "green"
  | "red"
  | "yellow"
  | `#${string}`;
export interface UiStyle {
  fg?: UiColor;
  bg?: UiColor;
  width?: number | `${number}%`;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  padding?: number;
  gap?: number;
  grow?: number;
  shrink?: number;
  border?: boolean;
  borderColor?: UiColor;
  borderStyle?: "single" | "double" | "rounded" | "heavy";
  align?: "flex-start" | "center" | "flex-end" | "stretch";
  justify?:
    | "flex-start"
    | "center"
    | "flex-end"
    | "space-between"
    | "space-around";
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  wrap?: "word" | "char" | "none";
}
export interface UiNativeProps extends UiStyle {
  title?: string;
  placeholder?: string;
}
export type UiInputEvent =
  | { type: "press" }
  | { type: "change" | "submit"; value: string }
  | { type: "select"; value: string; index: number }
  | { type: "pointer"; x: number; y: number; button: number }
  | {
      type: "key";
      name: string;
      sequence: string;
      ctrl: boolean;
      shift: boolean;
      meta: boolean;
    };
export interface UiEventUse {
  id: string;
  args?: import("./index.js").JsonObject;
}
export interface UiPresentationContext {
  readonly surface?: UiSurface;
  readonly instance: string;
  readonly values?: Partial<Record<UiValueField, string | number>>;
}
/** Plain data only. `native` embeds the preceding layer, not a renderer reference. */
export type UiNode = { key?: string; style?: UiStyle } & (
  | { type: "native"; props?: UiNativeProps }
  | { type: "text"; text: string; tone?: UiNodeTone; bold?: boolean }
  | {
      type: "value";
      field: UiValueField;
      tone?: UiNodeTone;
      maxLength?: number;
    }
  | {
      type: "button";
      label: string;
      action: { id: string; args?: import("./index.js").JsonObject };
      tone?: UiNodeTone;
      hotkey?: string;
      disabled?: boolean;
    }
  | {
      type: "input";
      key: string;
      label: string;
      value: string;
      placeholder?: string;
      maxLength?: number;
      onChange?: UiEventUse;
      onSubmit?: UiEventUse;
      disabled?: boolean;
    }
  | {
      type: "select";
      key: string;
      label: string;
      value?: string;
      options: { value: string; label: string; description?: string }[];
      onSelect: UiEventUse;
      disabled?: boolean;
    }
  | { type: "markdown"; text: string }
  | { type: "code"; text: string; language?: string }
  | { type: "image"; data: string; alt: string; fit?: "fit" | "cover" | "fill" }
  /** A custom terminal region. Cells are colored strings; callbacks stay outside the renderer. */
  | {
      type: "canvas";
      key: string;
      label: string;
      rows: { text: string; fg?: UiColor; bg?: UiColor }[][];
      onPointer?: UiEventUse;
      onKey?: UiEventUse;
    }
  | {
      type: "box";
      direction?: "row" | "column";
      gap?: number;
      padding?: number;
      border?: boolean;
      grow?: boolean;
      tone?: UiNodeTone;
      children: UiNode[];
    }
);
export interface UiRenderPatch {
  mode: "before" | "after" | "replace" | "hide";
  content?: UiNode;
}
