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
/** Plain data only. `native` embeds the preceding layer, not a renderer reference. */
export type UiNode = { key?: string } & (
  | { type: "native" }
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
