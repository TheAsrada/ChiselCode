import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolver,
} from "../security/approval.js";
import type { FileDiff } from "../types/domain.js";

export interface TuiApprovalResolver extends ApprovalResolver {
  bind(setter?: (request: ApprovalRequest | undefined) => void): void;
  resolve(decision: ApprovalDecision, request?: ApprovalRequest): void;
  cancel(): void;
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

export function createTuiApprovalResolver(
  options: {
    allowUnbound?: boolean;
    onChange?: (request: ApprovalRequest | undefined) => void;
  } = {},
): TuiApprovalResolver {
  let resolvePending: ((decision: ApprovalDecision) => void) | undefined;
  let pendingRequest: ApprovalRequest | undefined;
  let setRequest: ((request: ApprovalRequest | undefined) => void) | undefined;
  let disposed = false;
  let removeAbort = () => {};
  const settle = (decision: ApprovalDecision) => {
    removeAbort();
    removeAbort = () => {};
    resolvePending?.(decision);
    resolvePending = undefined;
    pendingRequest = undefined;
    setRequest?.(undefined);
    options.onChange?.(undefined);
  };
  return {
    async requestApproval(request, signal) {
      if (signal?.aborted) return "unavailable";
      if (disposed || (!setRequest && !options.allowUnbound) || resolvePending)
        return "unavailable";
      return new Promise((resolve) => {
        resolvePending = resolve;
        pendingRequest = request;
        if (signal) {
          const abort = () => settle("unavailable");
          signal.addEventListener("abort", abort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            abort();
            return;
          }
        }
        setRequest?.(request);
        options.onChange?.(request);
      });
    },
    bind(setter) {
      setRequest = setter;
      setter?.(pendingRequest);
    },
    resolve(decision, request) {
      if (request && request !== pendingRequest) return;
      settle(decision);
    },
    cancel() {
      settle("unavailable");
    },
    dispose() {
      disposed = true;
      settle("unavailable");
      setRequest = undefined;
    },
  } as TuiApprovalResolver;
}
