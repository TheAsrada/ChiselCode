/** Public desktop wire contract. Keep this module free of runtime/UI imports. */
export const DESKTOP_PROTOCOL = { major: 1, minor: 1 } as const;

import type {
  SettingsSchema,
  SettingValue,
} from "../extension-sdk/settings.js";

export type {
  SettingField,
  SettingsSchema,
  SettingValue,
} from "../extension-sdk/settings.js";
export type ExtensionAction =
  | "enable"
  | "disable"
  | "trust"
  | "settings"
  | "update"
  | "versions"
  | "remove";
export interface CatalogExtension {
  id: string;
  name: string;
  description: string;
  origin: "builtin" | "installed";
  version: string;
  source: string;
  digest?: string;
  revision: number;
  compatible: boolean;
  compatibility: string;
  trusted: boolean;
  desiredEnabled: boolean;
  actualState: string;
  actualLabel: string;
  state:
    | "saved"
    | "working"
    | "disabled"
    | "not_trusted"
    | "error"
    | "restart_required";
  reason?: string;
  projectBlocked: boolean;
  restartRequired: boolean;
  deferredRemoval: boolean;
  actions: ExtensionAction[];
  settingsRoute?: "tools.lsp" | "tools.subagents" | "tools.background";
  versions: {
    key: string;
    version: string;
    digest: string;
    selected: boolean;
    trusted: boolean;
    inUse: boolean;
    location: string;
  }[];
}
export interface ExtensionCatalog {
  items: CatalogExtension[];
  revision: number;
}
export interface ExtensionReview {
  requestId: string;
  kind: "install" | "update" | "trust" | "rollback" | "remove";
  id: string;
  name: string;
  version: string;
  digest: string;
  revision: number;
  oldVersion?: string;
  oldDigest?: string;
  location: string;
  bytes: number;
  files: number;
  sourceKind?: "directory" | "zip";
  incompatible?: string;
  downgrade: boolean;
  trustRequired: boolean;
  requestedEnabled: boolean;
  description: string;
  entry: string;
  compatibility: string;
  contents: { path: string; bytes: number; digest: string }[];
}
export interface ExtensionResult {
  id: string;
  restartRequired: boolean;
  deferred: boolean;
  warning?: string;
}
export interface ExtensionOperation {
  requestId: string;
  phase:
    | "preparing"
    | "review"
    | "committing"
    | "completed"
    | "cancelled"
    | "error";
  progress?: { phase: string; bytes: number; files: number };
  review?: ExtensionReview;
  result?: ExtensionResult;
  error?: string;
}
export interface ExtensionSettings {
  id: string;
  schema: SettingsSchema;
  revision: number;
  values: Record<string, SettingValue>;
  secretSet: Record<string, boolean>;
  unknownKeys: string[];
  issues: string[];
  restartRequired: true;
}
export interface BuiltinSettings {
  id: string;
  global: Json;
  project: Json;
  effective?: Json;
  globalRevision: string;
  projectRevision: string;
  status?: Json;
}
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Workflow = "plan" | "build";
export type PermissionMode = "default" | "acceptEdits" | "dontAsk";
export interface Project {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string;
}
export interface Profile {
  id: string;
  providerId: string;
  label: string;
  model: string;
  baseUrl?: string;
  hasKey: boolean;
}
export interface Provider {
  id: string;
  label: string;
  defaultModel?: string;
  defaultBaseUrl?: string;
  requiresKey: boolean;
  requiresEndpoint: boolean;
}
export interface Diff {
  path: string;
  kind: "create" | "edit" | "delete";
  patch: string;
  additions: number;
  deletions: number;
}
export interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "command";
  text: string;
  tool?: string;
  isError?: boolean;
  diffs?: Diff[];
}
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  model: string;
  profileId: string;
  messageCount: number;
}
export interface Session extends SessionSummary {
  projectPath: string;
  messages: Message[];
  mode: Workflow;
  approvalMode: PermissionMode;
  active: boolean;
  totalTokens: number;
  totalCost: number;
  children: Json;
  backgroundTasks: Json;
}
export interface GitState {
  branch: string;
  files: {
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }[];
  totalFiles: number;
}
export interface Hello {
  engineVersion: string;
  protocol: typeof DESKTOP_PROTOCOL;
  capabilities: string[];
  sessionSchemaVersion: number;
}
export interface Approval {
  requestId: string;
  sessionId: string;
  turnId: string;
  tool: string;
  preview: string;
  command?: string;
  diffs?: Diff[];
  ownerLabel?: string;
}
export type ApprovalDecision =
  | "approved"
  | "approved_always"
  | "approved_session"
  | "denied";
export interface StartTurn {
  path: string;
  sessionId: string;
  prompt: string;
  profileId?: string;
  model?: string;
  mode: Workflow;
  approvalMode: PermissionMode;
}
export interface RequestMap {
  "extensions/list": { params: { path?: string }; result: ExtensionCatalog };
  "extensions/prepare": {
    params: {
      requestId: string;
      kind: ExtensionReview["kind"];
      source?: string;
      id?: string;
      versionKey?: string;
    };
    result: ExtensionReview;
  };
  "extensions/operation": {
    params: { requestId: string };
    result: ExtensionOperation;
  };
  "extensions/cancel": {
    params: { requestId: string };
    result: { ok: boolean };
  };
  "extensions/commit": {
    params: {
      requestId: string;
      digest: string;
      revision: number;
      trust: boolean;
      enable?: boolean;
    };
    result: ExtensionResult;
  };
  "extensions/setEnabled": {
    params: {
      id: string;
      enabled: boolean;
      digest: string;
      revision: number;
      path?: string;
    };
    result: ExtensionResult;
  };
  "extensions/settings/read": {
    params: { id: string; digest: string; revision: number };
    result: ExtensionSettings;
  };
  "extensions/settings/save": {
    params: {
      id: string;
      digest: string;
      revision: number;
      settingsRevision: number;
      values: Record<string, SettingValue>;
      secrets?: Record<string, string>;
      clearSecrets?: string[];
      reset?: boolean;
    };
    result: ExtensionSettings;
  };
  "extensions/builtin/read": {
    params: { id: string; path: string };
    result: BuiltinSettings;
  };
  "extensions/builtin/save": {
    params: {
      id: string;
      path: string;
      scope: "global" | "project";
      revision: string;
      value: Json;
    };
    result: BuiltinSettings;
  };
  "extensions/lsp/action": {
    params: {
      path: string;
      action: "trust" | "check" | "restart";
      serverId: string;
      allowed?: boolean;
      value?: Json;
    };
    result: { text: string };
  };
  "system/status": { params: Record<string, never>; result: { busy: boolean } };
  initialize: {
    params: { protocolMajor: number; clientVersion: string };
    result: Hello;
  };
  "projects/list": { params: Record<string, never>; result: Project[] };
  "projects/open": { params: { path: string }; result: Project };
  "profiles/list": {
    params: Record<string, never>;
    result: {
      profiles: Profile[];
      providers: Provider[];
      defaultProfileId?: string;
    };
  };
  "profiles/save": {
    params: {
      id: string;
      providerId: string;
      label?: string;
      model: string;
      baseUrl?: string;
      apiKey?: string;
    };
    result: Profile;
  };
  "models/list": {
    params: { profileId: string };
    result: { id: string; name: string }[];
  };
  "sessions/list": { params: { path: string }; result: SessionSummary[] };
  "sessions/create": {
    params: { path: string; profileId?: string; model?: string };
    result: Session;
  };
  "sessions/read": {
    params: { path: string; sessionId: string };
    result: Session;
  };
  "sessions/rename": {
    params: { path: string; sessionId: string; title: string };
    result: { ok: boolean };
  };
  "sessions/delete": {
    params: { path: string; sessionId: string };
    result: { ok: boolean };
  };
  "turn/start": {
    params: StartTurn;
    result: { turnId: string; sessionId: string };
  };
  "turn/cancel": { params: { sessionId: string }; result: { ok: boolean } };
  "approvals/respond": {
    params: { requestId: string; decision: ApprovalDecision };
    result: { ok: boolean };
  };
  "git/status": { params: { path: string }; result: GitState | null };
  "git/diff": {
    params: { path: string; file: string };
    result: { patch: string };
  };
  "skills/list": {
    params: { path: string };
    result: { name: string; description: string; source: string }[];
  };
  "commands/list": {
    params: { path: string };
    result: { name: string; description: string; usage?: string }[];
  };
  "mcp/list": { params: { path: string }; result: Json };
  "mcp/save": {
    params: { path: string; id: string; config: Json };
    result: { ok: boolean };
  };
  "mcp/action": {
    params: {
      path: string;
      id: string;
      action:
        | "connect"
        | "disconnect"
        | "enable"
        | "disable"
        | "remove"
        | "trust";
    };
    result: { ok: boolean };
  };
  "tasks/list": { params: { path: string; sessionId: string }; result: Json };
  "tasks/inspect": {
    params: { sessionId: string; id: string; view: "history" | "changes" };
    result: { text: string; diffs?: Diff[] };
  };
  "tasks/cancel": {
    params: { sessionId: string; id: string };
    result: { ok: boolean };
  };
  "settings/read": { params: Record<string, never>; result: Json };
  "settings/patch": {
    params: { section: "web" | "lsp"; value: Json };
    result: { ok: boolean };
  };
  shutdown: { params: Record<string, never>; result: { ok: boolean } };
}
export type Method = keyof RequestMap;
export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: Method;
  params: unknown;
}
export type RpcResponse =
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | {
      jsonrpc: "2.0";
      id: number | null;
      error: { code: number; message: string; data?: { reason: string } };
    };
export interface EngineEvent {
  jsonrpc: "2.0";
  method: "event";
  params: {
    sequence: number;
    type:
      | "runtime"
      | "turn.started"
      | "turn.completed"
      | "approval.requested"
      | "approval.resolved"
      | "subagent"
      | "background"
      | "worktree.opened";
    sessionId: string;
    turnId: string;
    data: Json;
  };
}
export type WireMessage = RpcResponse | EngineEvent;
