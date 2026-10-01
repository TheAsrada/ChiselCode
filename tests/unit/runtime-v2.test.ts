import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { compactProjection } from "../../src/context/compactor.js";
import { ContextManager } from "../../src/context/context-manager.js";
import { partitionTranscript } from "../../src/context/partition.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { createSession } from "../../src/sessions/store.js";
import { EditingService } from "../../src/tools/editing/service.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import type {
  ChatMessage,
  ProviderAdapter,
  StreamEvent,
} from "../../src/types/domain.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chisel-v2-"));
  roots.push(root);
  return root;
}
function adapter(messages: ChatMessage[]): ProviderAdapter {
  let next = 0;
  return {
    kind: "anthropic",
    providerId: "anthropic",
    listModels: async () => [],
    async *streamChat(): AsyncIterable<StreamEvent> {
      const message = messages[next++];
      if (!message) throw new Error("Unexpected provider call");
      yield {
        type: "turn_complete",
        message,
        stopReason: message.content.some((item) => item.type === "tool_use")
          ? "tool_use"
          : "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}
function setup(
  root: string,
  session = createSession(root, "anthropic", "mock"),
  approve = true,
) {
  const events = new RuntimeEventBus(session.id);
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    {
      approvalMode: approve ? "bypassPermissions" : "default",
      allowBypassPermissions: approve,
      autoApprove: false,
      allowedTools: new Set(),
      nonInteractive: true,
    },
    { requestApproval: async () => "unavailable" },
  );
  const tools = createLocalToolRuntime(
    root,
    DEFAULT_PROJECT_CONFIG.ignorePatterns,
    gate,
    session,
    [],
    {
      events,
      artifactDirectory: join(root, ".artifacts"),
    },
  );
  const run = (provider: ProviderAdapter) =>
    new AgentRuntime(
      provider,
      new ContextManager({}, events),
      {
        selectForTurn: () => tools.catalog.selectForTurn(),
        execute: (calls, signal) => tools.scheduler.execute(calls, signal),
      },
      "system",
      events,
    );
  return { tools, session, events, run };
}
test("protocol partition keeps multiple calls and results atomic, including a pending tail", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "goal" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "read_file", input: {} },
        { type: "tool_use", id: "b", name: "read_file", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "a", content: "A" }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "b", content: "B" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "c", name: "read_file", input: {} }],
    },
  ];
  const units = partitionTranscript(messages);
  expect(
    units.map(({ start, end, pending }) => ({ start, end, pending })),
  ).toEqual([
    { start: 0, end: 1, pending: false },
    { start: 1, end: 4, pending: false },
    { start: 4, end: 5, pending: true },
  ]);
  const session = createSession("/project", "anthropic", "mock");
  session.messages = messages;
  expect(compactProjection(session, 0)).toBe(true);
  expect(session.context?.activeCheckpoint?.throughMessageIndex).toBe(4);
  expect(session.messages).toEqual(messages);
});
test("token budget compacts large outputs without changing transcript and counts schemas/output reserve", async () => {
  const session = createSession("/project", "anthropic", "mock");
  session.messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Keep the public API; fix null handling." },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "read",
          content: "log ".repeat(5000),
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Continue" }] },
  ];
  const durable = JSON.stringify(session.messages);
  const manager = new ContextManager({
    contextWindow: 2000,
    keepRecentTokens: 300,
  });
  const frame = await manager.build({
    session,
    system: "system",
    tools: [],
    provider: adapter([]),
    capabilities: { tokenCounting: "local_estimate" },
  });
  expect(frame.estimatedInputTokens).toBeLessThan(
    frame.budget.maxInputTokens ?? 0,
  );
  expect(frame.budget.reservedOutputTokens).toBe(500);
  expect(frame.checkpoint?.summary.userConstraints).toContain(
    "Keep the public API; fix null handling.",
  );
  expect(JSON.stringify(session.messages)).toBe(durable);
  await expect(
    manager.build({
      session,
      system: "system",
      tools: [
        {
          name: "huge",
          description: "x".repeat(9000),
          inputSchema: {},
          requiresApproval: false,
        },
      ],
      provider: adapter([]),
      capabilities: { tokenCounting: "local_estimate" },
    }),
  ).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
});
test("provider overflow performs exactly one recovery, unknown model window stays unknown", async () => {
  const root = await fixture();
  const { run, session, events } = setup(root);
  let requests = 0;
  let recoveries = 0;
  events.subscribe((event) => {
    if (event.type === "overflow_recovery") recoveries++;
  });
  const provider: ProviderAdapter = {
    kind: "anthropic",
    providerId: "anthropic",
    listModels: async () => [],
    async *streamChat() {
      requests++;
      yield {
        type: "error",
        code: "context_overflow",
        message: "Context too long",
      };
    },
  };
  const result = await run(provider).run(session, "goal");
  expect(requests).toBe(2);
  expect(recoveries).toBe(1);
  expect(result.errorCode).toBe("PROVIDER_CONTEXT_OVERFLOW");
  const frame = await new ContextManager().build({
    session,
    system: "system",
    tools: [],
    provider,
    capabilities: { tokenCounting: "local_estimate" },
  });
  expect(frame.budget.contextWindow).toBeUndefined();
});
test("pending approval retains completed calls and resumes without replaying their effects", async () => {
  const root = await fixture();
  const initial = setup(root, undefined, false);
  await writeFile(join(root, "a.txt"), "before");
  const provider = adapter([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read-a",
          name: "read_file",
          input: { path: "a.txt" },
        },
        {
          type: "tool_use",
          id: "edit-a",
          name: "edit_file",
          input: { path: "a.txt", old_str: "before", new_str: "after" },
        },
      ],
    },
  ]);
  const pending = await initial.run(provider).run(initial.session, "edit");
  expect(pending.status).toBe("approval_required");
  expect(initial.session.messages).toHaveLength(3);
  expect(initial.session.runtime?.invocations["read-a"]?.state).toBe(
    "succeeded",
  );
  expect(initial.session.runtime?.invocations["edit-a"]?.state).toBe(
    "awaiting_approval",
  );
  const resumed = setup(
    root,
    JSON.parse(JSON.stringify(initial.session)),
    true,
  );
  const result = await resumed
    .run(
      adapter([
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ]),
    )
    .run(resumed.session, "");
  expect(result.status).toBe("completed");
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after");
  expect(resumed.session.undoStack).toHaveLength(1);
  expect(
    partitionTranscript(resumed.session.messages).every(
      (unit) => !unit.pending,
    ),
  ).toBe(true);
});
test("duplicate IDs are idempotent and conflicting inputs are protocol errors", async () => {
  const root = await fixture();
  const { tools, session } = setup(root);
  const call = {
    id: "same",
    name: "write_file",
    input: { path: "new.txt", content: "value" },
  };
  expect((await tools.executor.execute(call)).isError).not.toBe(true);
  expect((await tools.executor.execute(call)).isError).not.toBe(true);
  expect(session.undoStack).toHaveLength(1);
  expect(
    (
      await tools.executor.execute({
        ...call,
        input: { path: "new.txt", content: "changed" },
      })
    ).errorCode,
  ).toBe("PROTOCOL_ERROR_DUPLICATE_CALL_ID");
});
test("fresh-read revisions survive serialization and prevent external overwrite", async () => {
  const root = await fixture();
  const original = setup(root);
  await writeFile(join(root, "a.txt"), "before");
  await original.tools.executor.execute({
    id: "read",
    name: "read_file",
    input: { path: "a.txt" },
  });
  const resumed = setup(root, JSON.parse(JSON.stringify(original.session)));
  await writeFile(join(root, "a.txt"), "external");
  const result = await resumed.tools.executor.execute({
    id: "write",
    name: "write_file",
    input: { path: "a.txt", content: "agent" },
  });
  expect(result.errorCode).toBe("STALE_FILE_REVISION");
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("external");
});
test("patch preflight validates all files before mutation; second commit failure rolls back first", async () => {
  const root = await fixture();
  const { tools, session } = setup(root);
  await writeFile(join(root, "a.txt"), "one\n");
  await writeFile(join(root, "b.txt"), "two\n");
  for (const [index, path] of ["a.txt", "b.txt"].entries())
    await tools.executor.execute({
      id: `read-${index}`,
      name: "read_file",
      input: { path },
    });
  const patch =
    "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** Update File: b.txt\n@@\n-two\n+TWO\n*** End Patch";
  const invalid = await tools.executor.execute({
    id: "bad",
    name: "apply_patch",
    input: {
      patchText: patch.replace(
        "*** End Patch",
        "*** Delete File: missing.txt\n*** End Patch",
      ),
    },
  });
  expect(invalid.isError).toBe(true);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\n");
  tools.context.editing = new EditingService(
    tools.context.workspace,
    session.runtime?.workspaceObservations ?? {},
    true,
    async (_operation, index) => {
      if (index === 1) throw new Error("Injected second-file failure");
    },
  );
  const failed = await tools.executor.execute({
    id: "partial",
    name: "apply_patch",
    input: { patchText: patch },
  });
  expect(failed.errorCode).toBe("PATCH_PARTIAL_FAILURE");
  expect(failed.output).toContain("Rolled back:");
  expect(failed.output).toContain("a.txt");
  expect(failed.details?.rolledBack).toHaveLength(1);
  expect(failed.details?.rollbackFailed).toEqual([]);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\n");
  expect(await readFile(join(root, "b.txt"), "utf8")).toBe("two\n");
});
test("patch supports multiple hunks, create, delete and move with structured diffs", async () => {
  const root = await fixture();
  const { tools } = setup(root);
  await writeFile(join(root, "a.txt"), "one\nmiddle\nthree\n");
  await writeFile(join(root, "old.txt"), "delete\n");
  for (const path of ["a.txt", "old.txt"])
    await tools.executor.execute({
      id: `read-${path}`,
      name: "read_file",
      input: { path },
    });
  const result = await tools.executor.execute({
    id: "patch",
    name: "apply_patch",
    input: {
      patchText:
        "*** Begin Patch\n*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-one\n+ONE\n@@\n-three\n+THREE\n*** Delete File: old.txt\n*** Add File: new.txt\n+new\n*** End Patch",
    },
  });
  expect(result.isError).not.toBe(true);
  expect(result.diffs).toHaveLength(4);
  expect(await readFile(join(root, "moved.txt"), "utf8")).toBe(
    "ONE\nmiddle\nTHREE\n",
  );
  expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new\n");
});

test("read batches run four at once and keep result order; mixed batches stay sequential", async () => {
  const root = await fixture();
  const { tools } = setup(root);
  let active = 0;
  let maximum = 0;
  const completed: number[] = [];
  tools.catalog.register({
    spec: {
      name: "artificial_read",
      description: "test",
      inputSchema: {},
      effect: "read",
      permission: "read",
      parallelSafe: true,
    },
    parse: (input) => input,
    prepare: async (_context, input) => ({
      data: input,
      preview: "read",
      resources: [],
    }),
    execute: async (_context, plan) => {
      const index = (plan.data as { index: number }).index;
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) =>
        setTimeout(resolve, 100 + (3 - index) * 10),
      );
      active--;
      completed.push(index);
      return { output: String(index) };
    },
  });
  const calls = [0, 1, 2, 3].map((index) => ({
    id: `parallel-${index}`,
    name: "artificial_read",
    input: { index },
  }));
  expect(
    (await tools.scheduler.execute(calls)).map((result) => result.output),
  ).toEqual(["0", "1", "2", "3"]);
  expect(maximum).toBe(4);
  expect(completed[0]).toBe(3);
  maximum = 0;
  await tools.scheduler.execute([
    ...calls.map((call) => ({ ...call, id: `mixed-${call.id}` })),
    {
      id: "mixed-write",
      name: "write_file",
      input: { path: "new.txt", content: "new" },
    },
  ]);
  expect(maximum).toBe(1);
});

test("cancellation terminates shell and records following calls without starting them", async () => {
  const root = await fixture();
  const { tools, session } = setup(root);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100);
  const results = await tools.scheduler.execute(
    [
      {
        id: "long-shell",
        name: "run_shell",
        input: { command: `${process.execPath} -e "setInterval(()=>{},1000)"` },
      },
      {
        id: "after-abort",
        name: "write_file",
        input: { path: "must-not-exist", content: "bad" },
      },
    ],
    abort.signal,
  );
  clearTimeout(timer);
  expect(results.map((result) => result.errorCode)).toEqual([
    "CANCELLED",
    "CANCELLED",
  ]);
  expect(session.runtime?.invocations["after-abort"]?.state).toBe("cancelled");
  await expect(readFile(join(root, "must-not-exist"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("three identical failures warn on the next call; large outputs are offloaded and ranged", async () => {
  const root = await fixture();
  const { tools } = setup(root);
  for (let i = 0; i < 3; i++)
    expect(
      (
        await tools.executor.execute({
          id: `missing-${i}`,
          name: "read_file",
          input: { path: "missing.txt" },
        })
      ).isError,
    ).toBe(true);
  expect(
    (
      await tools.executor.execute({
        id: "missing-4",
        name: "read_file",
        input: { path: "missing.txt" },
      })
    ).errorCode,
  ).toBe("REPEATED_CALL_DETECTED");
  tools.catalog.register({
    spec: {
      name: "huge_read",
      description: "test",
      inputSchema: {},
      effect: "read",
      permission: "read",
      parallelSafe: true,
      outputPolicy: { maxInlineTokens: 100 },
    },
    parse: (input) => input,
    prepare: async () => ({ data: {}, preview: "read", resources: [] }),
    execute: async () => ({ output: "line\n".repeat(5000) }),
  });
  const result = await tools.executor.execute({
    id: "huge",
    name: "huge_read",
    input: {},
  });
  expect(result.artifact?.uri).toMatch(/^tool-result:\/\//);
  expect(result.output.length).toBeLessThan(5000);
  expect(
    await tools.context.artifacts.read(result.artifact?.uri ?? "", 4, 2),
  ).toBe("line\nline");
  await expect(
    tools.context.artifacts.read("tool-result://../../outside"),
  ).rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
});

test("grep works without rg and accepts a single file", async () => {
  const root = await fixture();
  const { tools } = setup(root);
  await writeFile(join(root, "search.txt"), "needle\nother\n");
  const previous = process.env.PATH;
  try {
    process.env.PATH = root;
    const result = await tools.executor.execute({
      id: "fallback",
      name: "grep",
      input: { path: "search.txt", pattern: "needle" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain("search.txt:1:needle");
  } finally {
    process.env.PATH = previous;
  }
});

test("denial is a durable tool result and the provider can continue", async () => {
  const root = await fixture();
  const { tools, session, events } = setup(root, undefined, false);
  const provider = adapter([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "deny",
          name: "write_file",
          input: { path: "new.txt", content: "new" },
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Action denied; no file created." }],
    },
  ]);
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    { autoApprove: false, allowedTools: new Set(), nonInteractive: false },
    { requestApproval: async () => "denied" },
  );
  const { ToolExecutor } = await import("../../src/tools/executor.js");
  const { ToolScheduler } = await import("../../src/tools/scheduler.js");
  const scheduler = new ToolScheduler(
    new ToolExecutor(tools.catalog, gate, tools.context),
  );
  const result = await new AgentRuntime(
    provider,
    new ContextManager({}, events),
    {
      selectForTurn: () => tools.catalog.selectForTurn(),
      execute: (calls, signal) => scheduler.execute(calls, signal),
    },
    "system",
    events,
  ).run(session, "Create new.txt");
  expect(result.status).toBe("completed");
  expect(session.runtime?.invocations.deny?.state).toBe("denied");
  expect(session.messages[2]?.content[0]).toMatchObject({
    type: "tool_result",
    isError: true,
  });
  await expect(readFile(join(root, "new.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a file changed while approval is open cannot be committed", async () => {
  const root = await fixture();
  const { tools } = setup(root);
  await writeFile(join(root, "a.txt"), "before");
  await tools.executor.execute({
    id: "observe",
    name: "read_file",
    input: { path: "a.txt" },
  });
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    { autoApprove: false, allowedTools: new Set(), nonInteractive: false },
    {
      requestApproval: async () => {
        await writeFile(join(root, "a.txt"), "external");
        return "approved";
      },
    },
  );
  const { ToolExecutor } = await import("../../src/tools/executor.js");
  const result = await new ToolExecutor(
    tools.catalog,
    gate,
    tools.context,
  ).execute({
    id: "stale-after-approval",
    name: "write_file",
    input: { path: "a.txt", content: "agent" },
  });
  expect(result.errorCode).toBe("STALE_FILE_REVISION");
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("external");
});

test("shell timeout is typed and a failed patch removes newly staged directories", async () => {
  const root = await fixture();
  const { tools } = setup(root);
  const result = await tools.executor.execute({
    id: "timeout",
    name: "run_shell",
    input: {
      command: `${process.execPath} -e "setInterval(()=>{},1000)"`,
      timeout: 1000,
    },
  });
  expect(result.errorCode).toBe("TOOL_TIMEOUT");
  const editing = new EditingService(
    tools.context.workspace,
    {},
    true,
    async () => {
      throw new Error("commit failed");
    },
  );
  await expect(
    editing.commit(await editing.write("nested/new.txt", "new")),
  ).rejects.toThrow("commit failed");
  const { stat } = await import("node:fs/promises");
  await expect(stat(join(root, "nested"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("root instructions preserve native priority and compound shell cannot use prefix allow", async () => {
  const root = await fixture();
  for (const name of ["CHISEL.md", "AGENTS.md", "CLAUDE.md"])
    await writeFile(join(root, name), `Rules from ${name}`);
  const { InstructionResolver } = await import(
    "../../src/context/instructions.js"
  );
  const instructions = await new InstructionResolver().resolve(root);
  expect(instructions.indexOf("Rules from CLAUDE.md")).toBeLessThan(
    instructions.indexOf("Rules from AGENTS.md"),
  );
  expect(instructions.indexOf("Rules from AGENTS.md")).toBeLessThan(
    instructions.indexOf("Rules from CHISEL.md"),
  );
  const { PermissionPolicy } = await import(
    "../../src/security/permission-policy.js"
  );
  const policy = new PermissionPolicy(
    { ...DEFAULT_PROJECT_CONFIG, allowedCommands: ["bun test"] },
    { autoApprove: false, allowedTools: new Set(), nonInteractive: true },
  );
  expect(
    policy.decide(
      { tool: "run_shell", preview: "", command: "bun test --bail" },
      "process",
    ),
  ).toBe("allow");
  for (const command of [
    "bun test && echo bypass",
    "bun test $(echo bypass)",
    "bun test > output.txt",
    "bun test | cat",
  ])
    expect(
      policy.decide({ tool: "run_shell", preview: "", command }, "process"),
    ).toBe("ask");
});

test("patch refuses malformed, ignored and symlink-escape targets without earlier writes", async () => {
  const root = await fixture();
  const outside = await fixture();
  const { tools } = setup(root);
  const { symlink } = await import("node:fs/promises");
  await symlink(
    outside,
    join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const target of [
    "../outside.txt",
    ".git/blocked.txt",
    "escape/outside.txt",
  ]) {
    const result = await tools.executor.execute({
      id: `blocked-${target}`,
      name: "apply_patch",
      input: {
        patchText: `*** Begin Patch\n*** Add File: good.txt\n+good\n*** Add File: ${target}\n+bad\n*** End Patch`,
      },
    });
    expect(result.isError).toBe(true);
    await expect(readFile(join(root, "good.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  const result = await tools.executor.execute({
    id: "malformed",
    name: "apply_patch",
    input: {
      patchText: "*** Begin Patch\n*** Add File: good.txt\n+good\ninvalid",
    },
  });
  expect(result.errorCode).toBe("PATCH_CONFLICT");
  await expect(readFile(join(root, "good.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("Git and file discovery use canonical roots when a workspace is an alias", async () => {
  const root = await fixture();
  const linked = await fixture();
  const { symlink } = await import("node:fs/promises");
  const { execa } = await import("execa");
  await writeFile(join(root, "a.txt"), "before\n");
  await execa("git", ["init"], { cwd: root });
  await execa("git", ["add", "a.txt"], { cwd: root });
  await execa(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  await writeFile(join(root, "a.txt"), "after\n");
  const alias = join(linked, "alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const { tools } = setup(alias);
  const diff = await tools.executor.execute({
    id: "alias-git",
    name: "git_diff",
    input: { path: "a.txt" },
  });
  expect(diff.isError).not.toBe(true);
  expect(diff.output).toContain("+after");
  const files = await tools.executor.execute({
    id: "alias-list",
    name: "list_dir",
    input: {},
  });
  expect(files.output.trim()).toBe("a.txt");
});

test("summary distinguishes reading tests from running them and resolves verified failures", async () => {
  const { summarize } = await import("../../src/context/summary.js");
  const failed = summarize([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "source",
          name: "read_file",
          input: { path: "test.ts" },
        },
        {
          type: "tool_use",
          id: "check",
          name: "run_shell",
          input: { command: "bun test" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "source",
          content: 'test("passes", () => {});',
        },
        {
          type: "tool_result",
          toolUseId: "check",
          content: "Command failed (exit 1). 1 fail",
          isError: true,
        },
      ],
    },
  ]);
  expect(failed.verification).toHaveLength(1);
  expect(failed.verification[0]).toContain("run_shell [bun test]");
  expect(failed.openProblems).toHaveLength(1);
  const verified = summarize(
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "check-again",
            name: "run_shell",
            input: { command: "bun test" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "check-again",
            content: "Command exited 0. 1 pass",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Next: check type errors." }],
      },
    ],
    failed,
  );
  expect(verified.verification).toHaveLength(1);
  expect(verified.openProblems).toEqual([]);
  expect(verified.failedAttempts).toHaveLength(1);
  expect(verified.nextAction).toBe("Next: check type errors.");
});

test("large tool exceptions are offloaded just like successful outputs", async () => {
  const root = await fixture();
  const { tools } = setup(root);
  tools.catalog.register({
    spec: {
      name: "huge_failure",
      description: "test",
      inputSchema: {},
      effect: "read",
      permission: "read",
      parallelSafe: true,
      outputPolicy: { maxInlineTokens: 128 },
    },
    parse: (input) => input,
    prepare: async () => ({ data: {}, preview: "read", resources: [] }),
    execute: async () => {
      throw new Error("failure details ".repeat(5000));
    },
  });
  const result = await tools.executor.execute({
    id: "huge-error",
    name: "huge_failure",
    input: {},
  });
  expect(result.isError).toBe(true);
  expect(result.errorCode).toBe("TOOL_EXECUTION_FAILURE");
  expect(result.artifact?.uri).toMatch(/^tool-result:\/\//);
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(128 * 3);
});
