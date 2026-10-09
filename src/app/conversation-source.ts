import {
  type ConversationCapture,
  type ConversationSource,
  captureConversation,
  withAcceptedPrompt,
} from "../models/context.js";
import type { Session } from "../types/domain.js";

/** Core bridge between the live session owner and submit-time captures. No rendered transcript. */
export class ConversationSourceBridge {
  private source?: ConversationSource;
  private epoch = 0;
  private saved = captureConversation();
  private acceptedPrompt?: string;
  private allocation?: {
    promise: Promise<string>;
    resolve(id: string): void;
    reject(error: unknown): void;
  };
  private sessionId?: string;
  restore(session: Session): void {
    this.source = undefined;
    this.saved = captureConversation(session);
    this.sessionId = session.id;
  }
  allocate(factory: () => Promise<Session>): Promise<string> {
    const pending = this.pendingSession();
    if (pending) return pending;
    this.begin();
    const allocation = this.allocation;
    if (!allocation) throw new Error("Session allocation is unavailable.");
    const epoch = this.epoch;
    void factory().then(
      (session) => {
        if (this.epoch !== epoch || this.allocation !== allocation) {
          allocation.reject(
            new Error("Conversation owner changed during session allocation."),
          );
          return;
        }
        this.sessionId = session.id;
        this.saved = captureConversation(session);
        allocation.resolve(session.id);
        if (this.allocation === allocation) this.allocation = undefined;
      },
      (error: unknown) => {
        allocation.reject(error);
        if (this.allocation === allocation) this.allocation = undefined;
      },
    );
    return allocation.promise;
  }
  begin(prompt?: string): void {
    if (this.source) this.saved = this.source.capture();
    this.source = undefined;
    this.acceptedPrompt = prompt;
    if (!this.sessionId && !this.allocation) {
      let resolve!: (id: string) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<string>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      void promise.catch(() => {});
      this.allocation = { promise, resolve, reject };
    }
  }
  bind(source: ConversationSource): void {
    this.source = source;
    this.sessionId = source.sessionId;
    this.acceptedPrompt = undefined;
    this.allocation?.resolve(source.sessionId);
    this.allocation = undefined;
  }
  capture(): ConversationCapture {
    if (this.source) return this.source.capture();
    const capture = structuredClone(
      this.acceptedPrompt
        ? withAcceptedPrompt(this.saved, this.acceptedPrompt)
        : this.saved,
    );
    capture.provenance.capturedAt = new Date().toISOString();
    return capture;
  }
  pendingSession(): Promise<string> | undefined {
    return (
      this.allocation?.promise ??
      (this.sessionId ? Promise.resolve(this.sessionId) : undefined)
    );
  }
  complete(session?: Session): void {
    if (session) this.restore(session);
    else if (this.source) this.saved = this.source.capture();
    this.source = undefined;
    this.acceptedPrompt = undefined;
    this.allocation?.reject(
      new Error("Conversation session allocation failed."),
    );
    this.allocation = undefined;
  }
  dispose(): void {
    this.epoch++;
    this.complete();
    this.sessionId = undefined;
    this.saved = captureConversation();
  }
}
