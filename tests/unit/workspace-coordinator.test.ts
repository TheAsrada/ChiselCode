import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceCoordinator } from "../../src/tools/workspace-coordinator.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chisel-coordinator-"));
  roots.push(root);
  return root;
}

test("readers share access, writers are fair and another workspace is never blocked", async () => {
  const coordinator = new WorkspaceCoordinator();
  const a = await coordinator.scope(await fixture());
  const b = await coordinator.scope(await fixture());
  const releaseFirst = await coordinator.acquire(a, "read");
  const releaseSecond = await coordinator.acquire(a, "read");
  const started: string[] = [];
  const writer = coordinator.acquire(a, "write").then((release) => {
    started.push("writer");
    return release;
  });
  const lateReader = coordinator.acquire(a, "read").then((release) => {
    started.push("reader");
    return release;
  });
  const independent = await coordinator.acquire(b, "write");
  expect(started).toEqual([]);
  independent();
  releaseFirst();
  expect(started).toEqual([]);
  releaseSecond();
  const releaseWriter = await writer;
  expect(started).toEqual(["writer"]);
  releaseWriter();
  const releaseReader = await lateReader;
  expect(started).toEqual(["writer", "reader"]);
  releaseReader();
});

test("cancelling a waiting writer clears its place without cancelling the current reader", async () => {
  const coordinator = new WorkspaceCoordinator();
  const scope = await coordinator.scope(await fixture());
  const releaseFirst = await coordinator.acquire(scope, "read");
  const abort = new AbortController();
  const writer = coordinator.acquire(scope, "write", abort.signal);
  const cancelled = writer.catch((error: unknown) => error);
  const reader = coordinator.acquire(scope, "read");
  abort.abort();
  expect(await cancelled).toMatchObject({ code: "CANCELLED" });
  const releaseSecond = await reader;
  releaseSecond();
  releaseFirst();
  (await coordinator.acquire(scope, "write"))();
});

test("nested and aliased roots share access, sibling names remain independent", async () => {
  const coordinator = new WorkspaceCoordinator();
  const root = await fixture();
  const parent = join(root, "project");
  const child = join(parent, "nested");
  const sibling = join(root, "project-other");
  const alias = join(root, "alias");
  await mkdir(child, { recursive: true });
  await mkdir(sibling);
  await symlink(
    parent,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const parentScope = await coordinator.scope(parent);
  const childScope = await coordinator.scope(child);
  const aliasScope = await coordinator.scope(alias);
  expect(aliasScope).toEqual(parentScope);
  const releaseParent = await coordinator.acquire(parentScope, "write");
  let entered = false;
  const nested = coordinator.acquire(childScope, "read").then((release) => {
    entered = true;
    return release;
  });
  (await coordinator.acquire(await coordinator.scope(sibling), "write"))();
  expect(entered).toBe(false);
  coordinator.changed(childScope);
  expect(coordinator.revision(aliasScope)).toBeGreaterThan(0);
  expect(coordinator.revision(await coordinator.scope(sibling))).toBe(0);
  releaseParent();
  (await nested)();
});

test("sibling folders of a Git repository share its index and exceptions release access", async () => {
  const coordinator = new WorkspaceCoordinator();
  const root = await fixture();
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  const a = await coordinator.scope(join(root, "a"));
  const b = await coordinator.scope(join(root, "b"));
  const release = await coordinator.acquire(a, "write");
  let entered = false;
  const peer = coordinator.acquire(b, "write").then((unlock) => {
    entered = true;
    return unlock;
  });
  await Promise.resolve();
  expect(entered).toBe(false);
  release();
  (await peer)();
  await expect(
    coordinator.withAccess(a, "write", undefined, async () => {
      throw new Error("failure");
    }),
  ).rejects.toThrow("failure");
  (await coordinator.acquire(b, "write"))();
});

test("tools in different workspaces serialize a shared external resource", async () => {
  const coordinator = new WorkspaceCoordinator();
  const a = await coordinator.scope(await fixture());
  const b = await coordinator.scope(await fixture());
  const shared = await coordinator.resources([
    join(await fixture(), "new-skill", "SKILL.md"),
  ]);
  const releaseA = await coordinator.acquire([...a, ...shared], "write");
  let entered = false;
  const peer = coordinator
    .acquire([...b, ...shared], "write")
    .then((release) => {
      entered = true;
      return release;
    });
  (
    await coordinator.acquire(await coordinator.scope(await fixture()), "write")
  )();
  expect(entered).toBe(false);
  coordinator.changed([...a, ...shared]);
  expect(coordinator.revision([...b, ...shared])).toBeGreaterThan(0);
  releaseA();
  (await peer)();
});
