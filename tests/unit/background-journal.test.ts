import { expect, test } from "bun:test";
import type {
  BackgroundEvent,
  BackgroundTaskRecord,
} from "../../src/background/contracts.js";
import {
  BackgroundTaskJournal,
  type JournalOwner,
  taskDescriptor,
} from "../../src/background/task-journal.js";
import { createSession } from "../../src/sessions/store.js";

function fixture() {
  const session = createSession("/project", "openai", "fixture");
  const record: BackgroundTaskRecord = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    operationKey: "private-key",
    ordinal: 1,
    rootOwnerId: session.id,
    sessionId: session.id,
    conversationId: "conversation",
    generation: 1,
    invocationId: "call",
    turnId: "turn",
    ownerLabel: "Агент",
    origin: "/project",
    workspace: "/project",
    workspaceLabel: "Проект",
    label: "Проверка",
    commandPreview: "echo ok",
    replayable: true,
    kind: "batch",
    foreground: false,
    state: "running",
    revision: 0,
    acceptedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deadline: new Date().toISOString(),
    readiness: "unknown",
    tail: ["first"],
    outputBytes: 5,
    outputLines: 0,
    outputLimit: 4096,
    outputGeneration: crypto.randomUUID(),
    truncated: false,
    cleanup: { confirmed: false },
    resources: [],
    process: {
      instance: crypto.randomUUID(),
      applicationPid: process.pid,
      host: "fixture",
      token: crypto.randomUUID(),
    },
  };
  const events: BackgroundEvent[] = [];
  const owner: JournalOwner = {
    closed: false,
    binding: {
      session,
      scope: { chat: { render: () => undefined } },
      onEvent: (event) => {
        events.push(event);
      },
      store: {
        patchBackground: async (_id, receipt) => {
          session.backgroundTasks = {
            ...session.backgroundTasks,
            [receipt.id]: receipt,
          };
          return session;
        },
      },
    },
  };
  return { record, owner, events, session };
}

test("journal publishes the persisted revision when live output advances during the write", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  let saved: BackgroundTaskRecord | undefined;
  const journal = new BackgroundTaskJournal({
    save: async (record) => {
      saved = record;
      await gate.promise;
    },
    saveForeground: async () => {
      throw Error("wrong storage lane");
    },
  });
  let notified = 0;
  journal.subscribe(() => {
    throw Error("closed observer");
  });
  const detach = journal.subscribe(() => {
    notified++;
  });
  const pending = journal.persist(f.owner, f.record, "changed");
  f.record.outputBytes = 99;
  f.record.tail = ["newer"];
  gate.resolve();
  expect(await pending).toBe(1);
  expect(saved?.outputBytes).toBe(5);
  expect(f.events[0]?.task.tail).toEqual(["first"]);
  expect(f.session.backgroundTasks?.[f.record.id]?.revision).toBe(1);
  expect(notified).toBe(1);
  detach();
  journal.notify();
  expect(notified).toBe(1);
  const dto = taskDescriptor(f.record);
  expect(dto).not.toHaveProperty("operationKey");
  expect(dto).not.toHaveProperty("process");
  expect(Object.isFrozen(dto)).toBe(true);
  journal.dispose();
});

test("foreground checkpoints never patch conversation receipts; a closed owner gets no event", async () => {
  const f = fixture();
  f.record.foreground = true;
  f.record.state = "completed";
  f.owner.closed = true;
  const writes: BackgroundTaskRecord[] = [];
  const journal = new BackgroundTaskJournal({
    save: async () => {
      throw Error("wrong storage lane");
    },
    saveForeground: async (record) => {
      writes.push(record);
    },
  });
  expect(await journal.persist(f.owner, f.record, "terminal")).toBe(1);
  expect(writes[0]?.terminalRevision).toBe(1);
  expect(f.session.backgroundTasks).toBeUndefined();
  expect(f.events).toEqual([]);
});
