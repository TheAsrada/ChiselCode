import type { Session } from "../types/domain.js";
export function initializeSessionState(session: Session): void {
  session.runtime ??= {
    invocations: {},
    workspaceObservations: {},
    failedCalls: {},
  };
  session.runtime.failedCalls ??= {};
  session.context ??= {};
}
