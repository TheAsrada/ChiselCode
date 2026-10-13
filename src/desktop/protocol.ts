/** Public desktop wire contract. Keep this module free of runtime/UI imports. */
export const DESKTOP_PROTOCOL = { major: 1, minor: 0 } as const;
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
