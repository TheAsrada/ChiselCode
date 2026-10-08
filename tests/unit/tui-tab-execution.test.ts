import { expect, test } from "bun:test";
import { createSession } from "../../src/sessions/store.js";
import { createTuiApprovalResolver } from "../../src/ui/tui-contract.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

test("unbound approvals wait in their own tabs and cancellation leaves peers untouched", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  try {
    const first = workspace.newTab();
    const second = workspace.newTab();
    const a = workspace.execution(first);
    const b = workspace.execution(second);
    a.abort = new AbortController();
    b.abort = new AbortController();
    const waitingA = new AbortController();
    const waitingB = new AbortController();
    a.pendingSubmissions.add(waitingA);
    b.pendingSubmissions.add(waitingB);
    const firstRequest = { tool: "write_file", preview: "first" };
    const secondRequest = { tool: "run_shell", preview: "second" };
    const firstPending = a.approvalResolver.requestApproval(firstRequest);
    const secondPending = b.approvalResolver.requestApproval(secondRequest);
    expect(first.snapshot.awaitingApproval).toBe(true);
    expect(second.snapshot.awaitingApproval).toBe(true);
    const shown: unknown[] = [];
    a.approvalResolver.bind((request) => shown.push(request));
    expect(shown.at(-1)).toBe(firstRequest);
    a.approvalResolver.bind(undefined);
    a.approvalResolver.bind((request) => shown.push(request));
    expect(shown.at(-1)).toBe(firstRequest);
    a.cancel();
    expect(await firstPending).toBe("unavailable");
    expect(a.abort.signal.aborted).toBe(true);
    expect(b.abort.signal.aborted).toBe(false);
    expect(waitingA.signal.aborted).toBe(true);
    expect(waitingB.signal.aborted).toBe(false);
    expect(first.snapshot.awaitingApproval).toBe(false);
    expect(second.snapshot.awaitingApproval).toBe(true);
    b.approvalResolver.resolve("approved", firstRequest);
    expect(second.snapshot.awaitingApproval).toBe(true);
    b.approvalResolver.resolve("denied", secondRequest);
    expect(await secondPending).toBe("denied");
    const next = { tool: "write_file", preview: "next turn" };
    const nextPending = a.approvalResolver.requestApproval(next);
    a.approvalResolver.resolve("approved", firstRequest);
    expect(first.snapshot.awaitingApproval).toBe(true);
    a.approvalResolver.resolve("approved", next);
    expect(await nextPending).toBe("approved");
    b.pendingSubmissions.delete(waitingB);
  } finally {
    workspace.dispose();
  }
});

test("standalone approval resolvers require a screen and disposed resolvers cannot wait", async () => {
  const resolver = createTuiApprovalResolver();
  const request = { tool: "write_file", preview: "file" };
  expect(await resolver.requestApproval(request)).toBe("unavailable");
  resolver.bind(() => {});
  const pending = resolver.requestApproval(request);
  expect(await resolver.requestApproval(request)).toBe("unavailable");
  resolver.dispose();
  expect(await pending).toBe("unavailable");
  resolver.bind(() => {});
  expect(await resolver.requestApproval(request)).toBe("unavailable");
});

test("workspace waits for all running tabs and queued prompts keep a tab busy", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  try {
    const first = workspace.newTab();
    const firstKey = workspace.activeKey;
    const second = workspace.newTab();
    const a = workspace.execution(first);
    const b = workspace.execution(second);
    let finishA = () => {};
    let finishB = () => {};
    a.activeRun = new Promise<void>((resolve) => {
      finishA = resolve;
    });
    b.activeRun = new Promise<void>((resolve) => {
      finishB = resolve;
    });
    expect(workspace.busy).toBe(true);
    expect(workspace.close(firstKey)).toBe(false);
    let settled = false;
    const waiting = workspace.waitForRuns().then(() => {
      settled = true;
    });
    finishA();
    await a.activeRun;
    a.activeRun = undefined;
    expect(settled).toBe(false);
    expect(workspace.busy).toBe(true);
    finishB();
    await waiting;
    b.activeRun = undefined;
    a.pendingOperations.push({
      kind: "prompt",
      root: first.snapshot.projectPath,
      input: "next",
      mode: "build",
      approvalMode: "default",
      modelOptions: {},
      generation: first.currentGeneration,
    });
    expect(workspace.busy).toBe(true);
    expect(workspace.close(firstKey)).toBe(false);
    workspace.cancelAll();
    expect(workspace.busy).toBe(false);
    expect(workspace.close(firstKey)).toBe(true);
  } finally {
    workspace.dispose();
  }
});

test("a checkpoint identifies a running session before completion, preventing duplicate tabs", () => {
  const workspace = new TuiWorkspace(process.cwd());
  try {
    const session = createSession(process.cwd(), "anthropic", "model");
    const owner = workspace.newTab();
    owner.setSessionId(session.id);
    owner.setBusy(true);
    owner.appendToLast("stream in progress");
    workspace.newDraft();
    expect(workspace.openSession(session)).toBe(owner);
    expect(workspace.tabs).toHaveLength(1);
    expect(owner.snapshot.streaming).toBe("stream in progress");
    expect(owner.snapshot.busy).toBe(true);
  } finally {
    workspace.dispose();
  }
});
