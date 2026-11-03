import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCapability } from "../../src/app/git-capability.js";
import { ToolCatalog } from "../../src/tools/catalog.js";
import { LocalToolProvider } from "../../src/tools/local/provider.js";

test("a non-Git project hides native Git/worktrees but keeps local tools and remote extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-git-capability-"));
  try {
    const git = new GitCapability(root);
    const catalog = new ToolCatalog(undefined, undefined, (handler) =>
      git.reason(handler),
    );
    const local = new LocalToolProvider();
    await catalog.addProvider(local);
    const base = await local.getHandler("read_file");
    for (const extensionId of ["builtin.worktrees", "remote.github"])
      catalog.register({
        ...base,
        spec: {
          ...base.spec,
          name: `ext:${extensionId}:status`,
          source: { type: "extension", extensionId, originalName: "status" },
        },
      });
    catalog.register({
      ...base,
      spec: {
        ...base.spec,
        name: "ext:builtin.subagents:submit_coding",
        source: {
          type: "extension",
          extensionId: "builtin.subagents",
          originalName: "submit_coding",
        },
      },
    });
    await git.refresh();
    const names = catalog.selectForTurn().map((tool) => tool.name);
    for (const name of [
      "git_status",
      "git_diff",
      "git_commit",
      "ext:builtin.worktrees:status",
      "ext:builtin.subagents:submit_coding",
    ]) {
      expect(names).not.toContain(name);
      expect(() => catalog.assertAvailable(catalog.get(name))).toThrow(
        "нет Git",
      );
    }
    for (const name of [
      "read_file",
      "write_file",
      "grep",
      "run_shell",
      "ext:remote.github:status",
    ])
      expect(names).toContain(name);
    expect(git.instructions()).toContain("не обходите");
    await mkdir(join(root, ".git"));
    await git.refresh();
    expect(catalog.selectForTurn().map((tool) => tool.name)).toContain(
      "git_status",
    );
    expect(git.instructions()).toBe("");
    await rm(join(root, ".git"), { recursive: true });
    await git.refresh();
    expect(catalog.selectForTurn().map((tool) => tool.name)).not.toContain(
      "git_status",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested projects and worktree git files retain Git availability without inventing a repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-git-parent-"));
  try {
    const nested = join(root, "nested", "project");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".git"), "gitdir: /fixture-only-marker\n");
    const git = new GitCapability(nested);
    await git.refresh();
    const local = new LocalToolProvider();
    expect(git.reason(await local.getHandler("git_status"))).toBeUndefined();
    expect(git.instructions()).toBe("");
    // The marker grants no integrity/ownership or permission; ordinary Git execution still validates it.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
