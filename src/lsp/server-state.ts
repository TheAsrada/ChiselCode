import { type LspLaunch } from "./config.js";
import type {
  DiagnosticFreshness,
  LspDiagnostic,
  LspState,
} from "./contracts.js";
import { type LspFile } from "./documents.js";
import { LspTransport } from "./transport.js";

export interface Document extends LspFile {
  diagnosticEvidence?: "versioned_push" | "unversioned_push" | "pull_request";
  version: number;
  generation: number;
  freshness: DiagnosticFreshness;
  diagnostics: LspDiagnostic[];
  omitted: number;
  serial: number;
  notificationSerial?: number;
  accessed: number;
}
export interface Server {
  id: string;
  projectRoot: string;
  state: LspState;
  generation: number;
  launch?: LspLaunch;
  transport?: LspTransport;
  cleanupTransport?: LspTransport;
  pending?: Promise<void>;
  controller: AbortController;
  documents: Map<string, Document>;
  locks: Map<string, Promise<unknown>>;
  capabilities: Record<string, unknown>;
  publications: number;
  reason?: string;
  requiresRestart: boolean;
  stopping?: Promise<void>;
  restarting?: Promise<void>;
  revision: number;
}
