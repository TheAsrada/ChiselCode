import {
  cancelled,
  RuntimeError,
  type RuntimeErrorCode,
} from "../runtime/errors.js";
import { SecretRedactor } from "../security/redaction.js";

const redactor = new SecretRedactor();
export const safeDiagnostic = (text: string): string => redactor.text(text);

export function validateId(id: string, kind: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(id))
    throw new Error(`Invalid ${kind} ID.`);
}

export interface CleanupFailure {
  extensionId: string;
  phase: "cleanup";
  /** Raw causes remain internal and non-enumerable. */
  cause: unknown;
}

export class ExtensionLifecycleError extends Error {
  constructor(
    message: string,
    readonly extensionId?: string,
    cause?: unknown,
    readonly cleanupFailures: readonly CleanupFailure[] = [],
  ) {
    super(safeDiagnostic(message));
    this.name = "ExtensionLifecycleError";
    Object.defineProperty(this, "cause", { value: cause });
  }
}

export function cleanupFailure(
  extensionId: string,
  cause: unknown,
): CleanupFailure {
  return Object.defineProperty(
    { extensionId, phase: "cleanup" as const },
    "cause",
    { value: cause },
  ) as CleanupFailure;
}

export function extensionFailure(
  code: RuntimeErrorCode,
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): RuntimeError {
  return Object.defineProperty(
    new RuntimeError(code, safeDiagnostic(message), details),
    "cause",
    { value: cause },
  );
}

/** Cancels waiting, not arbitrary in-process JavaScript. Late rejection is consumed. */
export function abortable<T>(
  callback: () => T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  cancelled(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener("abort", abort);
      reject(new RuntimeError("CANCELLED", "Operation cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(() => {
        cancelled(signal);
        return callback();
      })
      .then(
        (value) => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) abort();
          else resolve(value);
        },
        (error: unknown) => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) abort();
          else reject(error);
        },
      );
  });
}

export function operationSignal(
  lifetime: AbortSignal,
  operation?: AbortSignal,
): AbortSignal {
  // Each invocation has its own signal identity, even when its caller has no
  // cancellation signal. Only workspace shutdown is shared in that case.
  return AbortSignal.any(operation ? [lifetime, operation] : [lifetime]);
}

export function frozenClone<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(clone);
  return clone;
}
