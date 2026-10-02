import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolver,
} from "../security/approval.js";
import type { FileDiff } from "../types/domain.js";

export interface TuiApprovalResolver extends ApprovalResolver {
  bind(setter?: (request: ApprovalRequest | undefined) => void): void;
  resolve(decision: ApprovalDecision): void;
  dispose(): void;
}

export type TranscriptTone =
  | "assistant"
  | "user"
  | "tool"
  | "info"
  | "warn"
  | "error"
  | "success"
  | "dim"
  | "context"
  | "logo";

export interface TuiTranscriptLine {
  id: number;
  text: string;
  tone?: TranscriptTone;
  header?: "title" | "meta";
  fileDiff?: FileDiff;
}
export interface TuiTranscript {
  append(line: string, tone?: TranscriptTone, fileDiff?: FileDiff): void;
  setToolActivity(text?: string): void;
  appendToLast(text: string): void;
  replace?(
    entries: Array<{
      text: string;
      tone?: TranscriptTone;
      fileDiff?: FileDiff;
    }>,
  ): void;
  clear(): void;
}

export function createTuiApprovalResolver(): TuiApprovalResolver {
  let resolvePending: ((decision: ApprovalDecision) => void) | undefined;
  let pendingRequest: ApprovalRequest | undefined;
  let setRequest: ((request: ApprovalRequest | undefined) => void) | undefined;
  return {
    async requestApproval(request) {
      if (!setRequest || resolvePending) return "unavailable";
      return new Promise((resolve) => {
        resolvePending = resolve;
        pendingRequest = request;
        setRequest?.(request);
      });
    },
    bind(setter) {
      setRequest = setter;
      setter?.(pendingRequest);
    },
    resolve(decision) {
      resolvePending?.(decision);
      resolvePending = undefined;
      pendingRequest = undefined;
      setRequest?.(undefined);
    },
    dispose() {
      resolvePending?.("unavailable");
      resolvePending = undefined;
      pendingRequest = undefined;
      setRequest = undefined;
    },
  } as TuiApprovalResolver;
}
