import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROJECT_CONFIG,
  loadGlobalConfig,
} from "../../src/config/load.js";
import { captureConversation } from "../../src/models/context.js";
import type { SideQueryRecord } from "../../src/models/contracts.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { ApprovalArbiter } from "../../src/security/approval-arbiter.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import {
  effectiveSubagentConfig,
  SubagentConfigSchema,
} from "../../src/subagents/config.js";
import { ChildToolPolicy } from "../../src/subagents/policy.js";
import { SubagentSettingsStore } from "../../src/subagents/settings.js";
import { SubagentRecordStore } from "../../src/subagents/storage.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import { childFixture } from "../helpers/subagent.js";

test("child and side patches survive stale parent saves, duplicate receipts and interrupted recovery; no child resume authority", async () => {
  const temp = await mkdtemp(join(tmpdir(), "chisel-child-store-"));
  const key = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
  const before = process.env[key];
  process.env[key] = temp;
  try {
    const root = join(temp, "root");
    await mkdir(root);
    const store = await projectSessionStore(root);
    const parent = store.create("openai-compatible", "fixture-model");
    parent.mainSpend = {
      usage: { inputTokens: 10, outputTokens: 2 },
      knownCost: 0.1,
      unknownUsage: false,
      unknownCost: false,
    };
    parent.totalTokens = { inputTokens: 10, outputTokens: 2 };
    parent.totalCost = 0.1;
    await store.save(parent);
    const stale = structuredClone(parent);
    const child = childFixture(parent.id, root);
    child.status = "completed";
    child.cleanup = { quiescent: true };
    child.spend = {
      usage: { inputTokens: 30, outputTokens: 3 },
      knownCost: 0.3,
      unknownCost: false,
      unknownUsage: false,
    };
    await store.patchChild(parent.id, {
      revision: 2,
      child: { ...child, revision: 2 },
      spend: child.spend,
    });
    const now = new Date().toISOString();
    const side: SideQueryRecord = {
      operationId: crypto.randomUUID(),
      owner: {
        sessionId: parent.id,
        conversationId: parent.id,
        generation: 0,
        workspaceRoot: root,
        extensionId: "builtin.btw",
      },
      question: "Побочный вопрос",
      text: "Ответ",
      command: "btw",
      status: "completed",
      providerId: parent.providerId,
      profileId: parent.profileId,
      model: parent.model,
      acceptedAt: now,
      updatedAt: now,
      revision: 1,
      afterMessage: 0,
      context: captureConversation(parent).provenance,
      usageSource: "observed",
      usage: { inputTokens: 20, outputTokens: 2 },
      cost: { source: "estimated", usd: 0.2 },
      knownCost: 0.2,
      attempts: 1,
    };
    await store.patchSideQuery(parent.id, side);
    stale.messages.push({
      role: "user",
      content: [{ type: "text", text: "Сохранить собственную историю" }],
    });
    await store.save(stale);
    await store.patchChild(parent.id, {
      revision: 2,
      child: { ...child, revision: 2 },
      spend: child.spend,
    });
    const saved = await store.load(parent.id);
    expect(saved.messages).toHaveLength(1);
    expect(saved.sideQueries?.[0]?.text).toBe("Ответ");
    expect(saved.totalTokens.inputTokens).toBe(60);
    expect(saved.totalCost).toBeCloseTo(0.6);
    expect(saved.children?.[child.id]?.revision).toBe(2);
    const tasks = new SubagentRecordStore();
    const interrupted = {
      ...child,
      id: crypto.randomUUID(),
      status: "running" as const,
      cleanup: { quiescent: false },
      process: {
        pid: 2147483647,
        host: (await import("node:os")).hostname(),
        token: crypto.randomUUID(),
        heartbeat: now,
      },
    };
    await tasks.save(interrupted);
    const recovered = await tasks.reconcile(parent.id);
    expect(recovered.foreignLive).toBe(false);
    expect(recovered.records[0]?.status).toBe("interrupted");
    expect(recovered.records[0]?.cleanup.recoveryRequired).toBe(true);
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
    await rm(temp, { recursive: true, force: true });
  }
});

test("Settings save typed fields without losing unrelated data, reject stale writes and invalid JSON; project only narrows", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-child-settings-"));
  const path = join(root, "global.json");
  let applies = 0;
  try {
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        profiles: {},
        ui: { theme: "paper" },
        lsp: { mode: "off", servers: {} },
      }),
    );
    await writeFile(
      join(root, ".chiselrc"),
      JSON.stringify({
        unknownFeature: { keep: true },
        allowedCommands: ["bun test"],
      }),
    );
    const actions = new SubagentSettingsStore(root, path, async () => {
      applies++;
    });
    const initial = await actions.load();
    const config = { ...initial.global, enabled: false, maxActive: 1 };
    const updated = await actions.saveGlobal(config, initial.globalRevision);
    expect(updated.global.enabled).toBe(false);
    expect((await loadGlobalConfig(path)).ui?.theme).toBe("paper");
    expect((await loadGlobalConfig(path)).lsp?.mode).toBe("off");
    await expect(
      actions.saveGlobal(initial.global, initial.globalRevision),
    ).rejects.toThrow("изменились");
    await actions.saveProject(
      { enabled: true, maxActive: 2 },
      updated.projectRevision,
    );
    expect(
      JSON.parse(await readFile(join(root, ".chiselrc"), "utf8")).unknownFeature
        .keep,
    ).toBe(true);
    expect(
      effectiveSubagentConfig(config, { enabled: true, maxActive: 2 }).enabled,
    ).toBe(false);
    expect(effectiveSubagentConfig(config, { maxActive: 2 }).maxActive).toBe(1);
    expect(applies).toBe(2);
    expect(() =>
      SubagentConfigSchema.parse({ ...config, maxActive: 99 }),
    ).toThrow();
    await writeFile(join(root, ".chiselrc"), "{broken");
    await expect(actions.load()).rejects.toThrow();
    expect(await readFile(join(root, ".chiselrc"), "utf8")).toBe("{broken");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readonly ceiling is enforced by the real executor for direct handlers; live disable fences a prepared write", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-child-policy-"));
  const path = join(root, "global.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        profiles: {},
        subagents: { enabled: true },
      }),
    );
    await writeFile(join(root, "source.txt"), "real bytes\n");
    const global = await loadGlobalConfig(path);
    const store = await projectSessionStore(root);
    const session = store.create("openai-compatible", "fixture");
    let tools = 0;
    const policy = new ChildToolPolicy(
      "readonly",
      root,
      root,
      path,
      DEFAULT_PROJECT_CONFIG,
      global,
      "bypassPermissions",
      "edit_file,run_shell",
      async () => {
        tools++;
      },
    );
    const runtime = createLocalToolRuntime(
      root,
      [],
      new ApprovalGate(
        DEFAULT_PROJECT_CONFIG,
        {
          autoApprove: true,
          approvalMode: "bypassPermissions",
          allowBypassPermissions: true,
          allowedTools: new Set(["edit_file", "run_shell"]),
          nonInteractive: false,
        },
        { requestApproval: async () => "approved" },
      ),
      session,
      [],
      { mode: "build", executionConstraint: policy },
    );
    policy.seal(runtime.catalog.handlersSnapshot());
    const read = await runtime.executor.execute({
      id: "read",
      name: "read_file",
      input: { path: "source.txt" },
    });
    expect(read.isError).not.toBe(true);
    const edit = await runtime.executor.execute({
      id: "edit",
      name: "edit_file",
      input: {
        path: "source.txt",
        old_str: "real bytes",
        new_str: "forged write",
      },
    });
    expect(edit.errorCode).toBe("PERMISSION_DENIED");
    const shell = await runtime.executor.execute({
      id: "shell",
      name: "run_shell",
      input: { command: "echo forged" },
    });
    expect(shell.errorCode).toBe("PERMISSION_DENIED");
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe(
      "real bytes\n",
    );
    expect(tools).toBe(1);
    const mutable = new ChildToolPolicy(
      "coding",
      root,
      root,
      path,
      DEFAULT_PROJECT_CONFIG,
      global,
      "default",
      "edit_file",
      async () => {},
    );
    mutable.seal(runtime.catalog.handlersSnapshot());
    const handler = runtime.catalog
      .handlersSnapshot()
      .find((item) => item.spec.name === "edit_file")!;
    await mutable.beforePrepare(handler);
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        profiles: {},
        subagents: { enabled: false },
      }),
    );
    await expect(mutable.beforeExecute(handler)).rejects.toThrow("отключено");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval arbiter never cross-approves a sibling, prioritizes waiting foreground and removes cancelled waiters", async () => {
  const arbiter = new ApprovalArbiter();
  const order: string[] = [];
  const decisions = new Map<
    string,
    (decision: "approved" | "denied") => void
  >();
  const resolver = {
    requestApproval: async (request: { tool: string }) => {
      order.push(request.tool);
      return await new Promise<"approved" | "denied">((resolve) =>
        decisions.set(request.tool, resolve),
      );
    },
  };
  const child = arbiter.wrap(resolver, true),
    main = arbiter.wrap(resolver);
  const first = child.requestApproval({ tool: "one", preview: "" });
  await Promise.resolve();
  const aborted = new AbortController();
  const cancelled = child.requestApproval(
    { tool: "cancelled", preview: "" },
    aborted.signal,
  );
  const second = child.requestApproval({ tool: "two", preview: "" });
  const foreground = main.requestApproval({ tool: "main", preview: "" });
  aborted.abort();
  expect(await cancelled).toBe("unavailable");
  decisions.get("one")!("approved");
  expect(await first).toBe("approved");
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(order).toEqual(["one", "main"]);
  decisions.get("main")!("denied");
  expect(await foreground).toBe("denied");
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(order).toEqual(["one", "main", "two"]);
  decisions.get("two")!("denied");
  expect(await second).toBe("denied");
  arbiter.dispose();
});
