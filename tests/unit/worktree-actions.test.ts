import { expect, test } from "bun:test";
import { ShellInputSchema } from "../../src/background/input.js";
import {
  sameWorktreePath,
  worktreeKey,
  worktreeOwned,
  worktreeRemoveBlock,
} from "../../src/ui/worktree-actions.js";
import type { WorktreeDescriptor } from "../../src/worktrees/service.js";

test("origin management readonly is distinct from a managed writable copy", () => {
  const origin: WorktreeDescriptor = {
    kind: "origin",
    label: "project",
    path: "/project",
    state: "external",
    readOnly: true,
  };
  expect(worktreeOwned(origin)).toBe(false);
  expect(worktreeRemoveBlock(origin)).toContain("основной проект");
  expect(worktreeKey(origin)).toBe("origin:/project");
});
test("remove requires observed clean files and no active users, including ignored files", () => {
  const item: WorktreeDescriptor = {
    kind: "managed",
    id: "owned",
    label: "task",
    path: "/task",
    state: "ready",
    readOnly: false,
    activeUsers: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ignored: 0,
    conflicted: 0,
  };
  expect(worktreeRemoveBlock(item)).toBeUndefined();
  expect(worktreeRemoveBlock({ ...item, ignored: 1 })).toContain(
    "игнорируемые",
  );
  expect(worktreeRemoveBlock({ ...item, activeUsers: 1 })).toContain("открыта");
  expect(worktreeRemoveBlock({ ...item, untracked: undefined })).toContain(
    "не проверено",
  );
  expect(
    worktreeRemoveBlock({
      ...item,
      state: "recovery_required",
      reason: "identity mismatch",
    }),
  ).toBe("identity mismatch");
});
test("ordinary shell omits optional IDs; nil IDs fail with a repair hint before preparation", () => {
  expect(ShellInputSchema.safeParse({ command: "echo check" }).success).toBe(
    true,
  );
  for (const field of ["targetWorktreeId", "retryOf"]) {
    const result = ShellInputSchema.safeParse({
      command: "echo check",
      [field]: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.message).toContain("опустите");
  }
});

test("UI tab grouping preserves case-sensitive workspace boundaries", () => {
  expect(sameWorktreePath("/project/a/../b", "/project/b")).toBe(true);
  expect(sameWorktreePath("/project/Case", "/project/case")).toBe(
    process.platform === "win32",
  );
});
