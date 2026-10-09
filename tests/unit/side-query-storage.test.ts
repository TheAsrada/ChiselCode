import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureConversation } from "../../src/models/context.js";
import type { SideQueryRecord } from "../../src/models/contracts.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import type { Session } from "../../src/types/domain.js";

function side(session: Session, revision = 1): SideQueryRecord {
  const now = new Date().toISOString();
  return {
    operationId: randomUUID(),
    owner: {
      extensionId: "builtin.btw",
      conversationId: session.id,
      sessionId: session.id,
      workspaceRoot: session.projectPath,
      generation: 0,
    },
    status: "completed",
    text: "Separate answer",
    question: "Question",
    command: "btw",
    providerId: session.providerId,
    profileId: "fixture",
    model: session.model,
    acceptedAt: now,
    updatedAt: now,
    finishedAt: now,
    afterMessage: 0,
    revision,
    context: captureConversation(session).provenance,
    attempts: 1,
    usage: { inputTokens: 20, outputTokens: 5 },
    usageSource: "observed",
    cost: { source: "estimated", usd: 0.2 },
    knownCost: 0.2,
  };
}
// Retention exercises 54 real atomic writes/locks; Windows CI needs an IO budget, not the default 5 s.
test("main checkpoints and operation-only patches merge under lock, deduplicate accounting and preserve legacy state", async () => {
  const storage = await mkdtemp(join(tmpdir(), "chisel-side-store-"));
  const variable =
    process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
  const previous = process.env[variable];
  process.env[variable] = storage;
  try {
    const root = join(storage, "workspace");
    await mkdir(root);
    const store = await projectSessionStore(root);
    const main = store.create("openai-compatible", "fixture");
    main.totalTokens = { inputTokens: 100, outputTokens: 10 };
    main.totalCost = 1;
    main.costEstimate = { source: "estimated", usd: 1 };
    await store.save(main);
    const oldCheckpoint = structuredClone(main);
    const record = side(main);
    await store.patchSideQuery(main.id, record);
    oldCheckpoint.messages.push({
      role: "user",
      content: [{ type: "text", text: "Main accepted prompt" }],
    });
    const mainSpend = oldCheckpoint.mainSpend;
    expect(mainSpend).toBeDefined();
    if (!mainSpend) throw new Error("Main spend missing");
    mainSpend.usage.outputTokens += 3;
    await store.save(oldCheckpoint);
    let saved = await store.load(main.id);
    expect(saved.messages).toEqual(oldCheckpoint.messages);
    expect(saved.sideQueries?.[0]?.text).toBe(record.text);
    expect(saved.totalTokens).toMatchObject({
      inputTokens: 120,
      outputTokens: 18,
    });
    expect(saved.totalCost).toBeCloseTo(1.2);
    await store.patchSideQuery(main.id, record);
    expect((await store.load(main.id)).totalTokens).toEqual(saved.totalTokens);
    await store.patchSideQuery(main.id, {
      ...record,
      revision: 2,
      text: "Last answer",
    });
    saved = await store.load(main.id);
    saved.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "Main completed" }],
    });
    await store.save(saved);
    expect((await store.load(main.id)).messages).toHaveLength(2);
    expect((await store.load(main.id)).sideQueries?.[0]?.text).toBe(
      "Last answer",
    );
    expect(captureConversation(saved).text).not.toContain("Last answer");
    for (let index = 0; index < 52; index++)
      await store.patchSideQuery(main.id, side(main));
    const pending = {
      ...side(main),
      status: "receiving" as const,
      finishedAt: undefined,
    };
    await store.patchSideQuery(main.id, pending);
    saved = await store.load(main.id);
    expect(saved.sideQueries).toHaveLength(51);
    expect(Object.keys(saved.sideQuerySpend ?? {})).toHaveLength(54);
    const before = saved.totalTokens;
    saved = await store.interruptSideQueries(main.id);
    expect(
      saved.sideQueries?.find(
        (item) => item.operationId === pending.operationId,
      )?.status,
    ).toBe("interrupted");
    expect(saved.totalTokens).toEqual(before);
    await expect(
      store.patchSideQuery(main.id, {
        ...record,
        owner: { ...record.owner, sessionId: randomUUID() },
      }),
    ).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(storage, { recursive: true, force: true });
  }
}, 30_000);
