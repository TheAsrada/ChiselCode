/** Public API v1. Runtime helpers are injected by the current host into the factory. */
export const API_VERSION = 1 as const;

import type { SettingsSchema, SettingValue } from "./settings.js";

export type { SettingField, SettingsSchema, SettingValue } from "./settings.js";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface Disposable {
  dispose(): void | Promise<void>;
}
export interface Manifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly entry: string;
  readonly displayName: string;
  readonly description?: string;
  readonly chiselVersion?: string;
  readonly settings?: SettingsSchema;
  readonly platforms?: readonly ("win32" | "darwin" | "linux")[];
}
export type Mode = "plan" | "build";
export type Tone = "muted" | "accent" | "success" | "warning" | "error";
export type ViewState =
  | "loading"
  | "empty"
  | "ready"
  | "stale"
  | "error"
  | "unavailable";
export interface ChatStyle {
  title: string;
  inputField?: string;
  view?: string;
}
export interface ChatPresentation {
  summary?: string;
  cards?: Array<{
    id: string;
    revision: number;
    title: string;
    subtitle?: string;
    description?: string;
    detail?: string;
    status?: { label: string; tone: Tone };
    target?: { type: "extension_view"; viewId: string; dataRef?: string };
    actions?: Array<{
      label: string;
      action: "open";
      target: { type: "extension_view"; viewId: string; dataRef?: string };
    }>;
  }>;
}
export interface FileDiff {
  path: string;
  kind: "create" | "edit" | "delete";
  patch: string;
  additions: number;
  deletions: number;
}
export interface ToolResult {
  preview?: string;
  fileDiff?: FileDiff;
  diffs?: FileDiff[];
  artifact?: { uri: string; tokens: number };
  requiresApproval?: boolean;
  output: string;
  rawOutput?: string;
  isError?: boolean;
  errorCode?: string;
  details?: JsonObject;
  chatData?: Json;
}
export interface Invocation {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly mode: Mode;
  readonly signal: AbortSignal;
}
declare const planBrand: unique symbol;
export interface EffectPlan {
  readonly [planBrand]: true;
  readonly preview: string;
  readonly resources: readonly string[];
}
export interface ToolPrepareContext extends Invocation {
  readonly plan: {
    readText(
      path: string,
      options?: { offset?: number; limit?: number },
    ): Promise<EffectPlan>;
    writeText(path: string, content: string): Promise<EffectPlan>;
    shell(
      command: string,
      options?: { cwd?: string; timeout?: number },
    ): Promise<EffectPlan>;
  };
}
export interface ToolExecuteContext extends Invocation {
  readonly effects: {
    /** Executes only the captured approved effect, once. No arguments can change it. */ run(): Promise<ToolResult>;
  };
}
export interface ToolDefinition<Input = JsonObject> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly effect: "read" | "workspace_write" | "process";
  readonly chat?: ChatStyle;
  readonly timeoutMs?: number;
  prepare(
    context: ToolPrepareContext,
    input: Input,
  ): EffectPlan | Promise<EffectPlan>;
  execute(
    context: ToolExecuteContext,
    plan: EffectPlan,
  ): ToolResult | Promise<ToolResult>;
}
export interface ModelRequestInput {
  text: string;
  context: "conversation" | "none";
  limits?: {
    inputTokens?: number;
    outputTokens?: number;
    outputBytes?: number;
    deadlineMs?: number;
    attempts?: number;
  };
}
export type ModelStatus =
  | "accepted"
  | "preparing"
  | "receiving"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "truncated"
  | "interrupted";
export interface ModelResult {
  operationId: string;
  status: ModelStatus;
  text: string;
  usageSource: "observed" | "partial" | "unknown";
  knownCost: number;
  attempts: number;
  error?: { code: string; message: string };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}
export type ModelEvent =
  | { type: "status"; operationId: string; status: ModelStatus }
  | { type: "text"; operationId: string; text: string }
  | { type: "terminal"; operationId: string; result: ModelResult };
export interface ModelPort {
  request(
    input: ModelRequestInput,
    observer?: (event: Readonly<ModelEvent>) => void,
  ): Promise<ModelResult>;
}
export interface CommandContext extends Invocation {
  readonly model: ModelPort;
  readonly tools: {
    execute(name: string, input: JsonObject): Promise<ToolResult>;
  };
}
export interface SideQueryContext extends Invocation {
  readonly model: ModelPort;
}
export type Command<Input = string> = {
  name: string;
  description: string;
  usage?: string;
  chat?: ChatStyle;
  parse(args: string): Input;
} & (
  | {
      executionPolicy?: "foreground";
      execute(
        context: CommandContext,
        input: Input,
      ): ToolResult | Promise<ToolResult>;
    }
  | {
      executionPolicy: "side_query";
      execute(
        context: SideQueryContext,
        input: Input,
      ): ModelResult | Promise<ModelResult>;
    }
);
export interface UiActionUse {
  id: string;
  args?: JsonObject;
}
export interface UiRow {
  id: string;
  label: string;
  value?: string;
  detail?: string;
  tone?: Tone;
  action?: UiActionUse;
}
export interface UiSnapshot {
  revision: number;
  state: ViewState;
  label?: string;
  detail?: string;
  tone?: Tone;
  count?: number;
  rows?: UiRow[];
  action?: UiActionUse;
}
export interface UiPage {
  revision: number;
  state: ViewState;
  summary?: string;
  fields?: UiRow[];
  rows?: UiRow[];
  nextCursor?: string;
  actions?: UiActionUse[];
}
export type UiAction =
  | { id: string; label: string; type: "view"; viewId: string }
  | { id: string; label: string; type: "tool"; tool: string };
export interface UiBinding {
  readonly workspaceRoot: string;
  readonly scopeInstance: string;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly read: {
    ownerSummary(): {
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
    };
    subscribeOwner(changed: () => void): Disposable;
  };
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
  readonly source: {
    snapshot(binding: UiBinding): UiSnapshot | Promise<UiSnapshot>;
    subscribe?(binding: UiBinding, changed: () => void): Disposable;
  };
}
export interface UiDetailsView {
  readonly id: string;
  readonly scope: "workspace" | "conversation";
  readonly title: string;
  readonly actions?: readonly UiAction[];
  page(
    binding: UiBinding,
    request: Readonly<{ cursor?: string; search?: string }>,
  ): UiPage | Promise<UiPage>;
  subscribe?(binding: UiBinding, changed: () => void): Disposable;
}
declare const serviceBrand: unique symbol;
export interface ServiceToken<T> {
  readonly diagnosticId: string;
  readonly [serviceBrand]: (value: T) => T;
}
export interface GuardSnapshot {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly mode: Mode;
  readonly signal: AbortSignal;
  readonly preview: string;
  readonly resources: readonly string[];
  readonly command?: string;
  readonly tool: { readonly name: string; readonly effect: string };
  readonly input: Readonly<JsonObject>;
}
export type Guard = (
  snapshot: GuardSnapshot,
) =>
  | { action: "continue" }
  | { action: "deny"; reason: string }
  | Promise<{ action: "continue" } | { action: "deny"; reason: string }>;
export interface ActivationContext {
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
  readonly tools: { register<Input>(tool: ToolDefinition<Input>): void };
  readonly commands: { register<Input>(command: Command<Input>): void };
  readonly chat: {
    register(view: {
      id: string;
      render(data: unknown): ChatPresentation | undefined;
    }): void;
  };
  readonly ui: {
    register(contribution: UiContribution): void;
    registerView(view: UiDetailsView): void;
  };
  readonly contextProviders: {
    register(provider: {
      id: string;
      collect(
        snapshot: Readonly<{
          workspaceRoot: string;
          sessionId: string;
          turnId: string;
          iteration: number;
          attempt: number;
          mode: Mode;
          userPrompt: string;
          signal: AbortSignal;
        }>,
      ): { text: string } | undefined | Promise<{ text: string } | undefined>;
    }): void;
  };
  readonly guards: {
    afterPrepare(guard: Guard): void;
    beforeExecute(guard: Guard): void;
  };
  readonly services: {
    provide<T>(token: ServiceToken<T>, service: T): void;
    get<T>(token: ServiceToken<T>): T;
    lookup<T>(token: ServiceToken<T>): T | undefined;
  };
  add(disposable: Disposable): void;
}
export type ThemeToken =
  | "bg"
  | "surface"
  | "raised"
  | "border"
  | "text"
  | "muted"
  | "accent"
  | "green"
  | "red"
  | "yellow";
export interface ThemeContribution {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly variant: "light" | "dark";
  readonly colors: Readonly<Record<ThemeToken, string>>;
}
export interface ExtensionDefinition {
  readonly themes?: readonly ThemeContribution[];
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly entry: string;
  activate(context: ActivationContext): void | Promise<void>;
}
export interface HostSdk {
  readonly apiVersion: 1;
  readonly chiselVersion: string;
  /** Application-start snapshot; secrets are retrieved only inside trusted core code. */
  readonly settings: {
    read(): Promise<Readonly<Record<string, SettingValue>>>;
    secret(name: string): Promise<string | undefined>;
  };
  defineTool<Input = JsonObject>(
    definition: ToolDefinition<Input>,
  ): ToolDefinition<Input>;
  createServiceToken<T>(diagnosticId: string): ServiceToken<T>;
}
export type ExtensionFactory = (
  input: Readonly<{ sdk: HostSdk; manifest: Manifest }>,
) => ExtensionDefinition | Promise<ExtensionDefinition>;
