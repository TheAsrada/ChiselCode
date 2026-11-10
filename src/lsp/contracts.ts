import { type LspMode } from "./config.js";
import { type Range } from "./documents.js";

export type DiagnosticFreshness =
  | "pending"
  | "current"
  | "observed"
  | "stale"
  | "unavailable";
export type LspState =
  | "disabled"
  | "untrusted"
  | "unavailable"
  | "stopped"
  | "starting"
  | "ready"
  | "restarting"
  | "error"
  | "disposed";
export interface LspDiagnostic {
  path: string;
  range: Range;
  severity: number;
  message: string;
  code?: string | number;
  source?: string;
  relatedInformation?: { path: string; range: Range; message: string }[];
}
export interface LspStatus {
  workspaceRoot: string;
  serverId?: string;
  backend: string;
  state: LspState;
  generation: number;
  trackedDocuments: number;
  requiresRestart: boolean;
  mode?: LspMode;
  versions?: { server: string; typescript?: string; runtime: string };
  servers?: readonly {
    serverId: string;
    projectRoot: string;
    state: LspState;
    generation: number;
    trackedDocuments: number;
    reason?: string;
  }[];
  catalog?: readonly {
    id: string;
    title: string;
    languages: readonly string[];
    version: string;
    prerequisites?: string;
    platformAvailable?: boolean;
  }[];
  reason?: string;
  capabilities?: readonly string[];
}
export interface LspUiStatus {
  revision: number;
  workspaceRoot: string;
  mode: LspMode | "unknown";
  state: LspState | "unknown";
  trackedDocuments: number;
  checkedDocuments: number;
  observedDocuments: number;
  staleDocuments: number;
  diagnosticCount: number;
  requiresRestart: boolean;
  generation: number;
  diagnostics: readonly LspDiagnostic[];
}
export interface DiagnosticResult {
  path: string;
  revision: string;
  generation: number;
  freshness: DiagnosticFreshness;
  provenance: string;
  diagnostics: LspDiagnostic[];
  omitted: number;
}
export interface LspManagedInstance {
  serverId: string;
  projectRoot: string;
  state: LspState;
  generation: number;
  requiresRestart: boolean;
  reason?: string;
  version?: string;
  capabilities: readonly string[];
  documents: readonly {
    path: string;
    freshness: DiagnosticFreshness;
    diagnostics: readonly LspDiagnostic[];
  }[];
}
