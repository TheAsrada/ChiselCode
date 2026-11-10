import { frozenClone } from "../extensions/lifecycle.js";
import {
  type BackgroundEvent,
  type BackgroundTask,
  type BackgroundTaskRecord,
  BackgroundTaskSchema,
} from "./contracts.js";
import type { BackgroundOwnerBinding } from "./owner-binding.js";
import type { BackgroundTaskStore } from "./storage.js";

export function taskDescriptor(record: BackgroundTaskRecord): BackgroundTask {
  const {
    schemaVersion: _schema,
    operationKey: _key,
    process: _process,
    ...dto
  } = record;
  // Tool details are JSON data. Optional formatter fields can contain
  // undefined in memory; they must not break checkpoint validation on resume.
  return frozenClone(JSON.parse(JSON.stringify(dto)) as BackgroundTask);
}
export interface JournalOwner {
  binding: Pick<BackgroundOwnerBinding, "session" | "onEvent"> & {
    store: Pick<BackgroundOwnerBinding["store"], "patchBackground">;
    scope: { chat: Pick<BackgroundOwnerBinding["scope"]["chat"], "render"> };
  };
  closed: boolean;
}
export class BackgroundTaskJournal {
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly storage: Pick<
      BackgroundTaskStore,
      "save" | "saveForeground"
    >,
  ) {}
  async persist(
    owner: JournalOwner,
    record: BackgroundTaskRecord,
    type: BackgroundEvent["type"],
  ): Promise<number> {
    record.revision++;
    if (type === "terminal") record.terminalRevision = record.revision;
    record.updatedAt = new Date().toISOString();
    const presentation = owner.binding.scope.chat.render(
      "builtin.background",
      "task",
      { task: taskDescriptor(record) },
    );
    if (presentation) record.presentation = presentation;
    // Persist and announce one immutable revision. Output may advance the live
    // record while disk/checkpoint writes await; it cannot change this receipt.
    const snapshot = BackgroundTaskSchema.parse(record);
    if (snapshot.foreground) await this.storage.saveForeground(snapshot);
    else await this.storage.save(snapshot);
    if (!snapshot.foreground) {
      const prior = owner.binding.session.backgroundTasks?.[snapshot.id];
      const receipt = {
        id: snapshot.id,
        revision: snapshot.revision,
        label: snapshot.label,
        kind: snapshot.kind,
        state: snapshot.state,
        ...(snapshot.childId ? { childId: snapshot.childId } : {}),
        afterMessage:
          prior?.afterMessage ?? owner.binding.session.messages.length,
        ...(presentation ? { presentation } : {}),
      };
      const saved = await owner.binding.store.patchBackground(
        snapshot.rootOwnerId,
        receipt,
      );
      owner.binding.session.backgroundTasks = saved.backgroundTasks;
    }
    if (!owner.closed)
      try {
        owner.binding.onEvent?.({
          type,
          ownerId: snapshot.rootOwnerId,
          task: taskDescriptor(snapshot),
          ...(presentation ? { presentation } : {}),
        });
      } catch {
        /* Observers own no process resources. */
      }
    this.notify();
    return snapshot.revision;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  notify(): void {
    for (const listener of this.listeners)
      try {
        listener();
      } catch {
        /* Closed observer. */
      }
  }
  dispose(): void {
    this.listeners.clear();
  }
}
