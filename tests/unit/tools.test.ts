import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../src/security/approval.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ProjectConfig, Session } from "../../src/types/domain.js";

const paths: string[] = [];
const config: ProjectConfig = {
  allowedCommands: [],
  deniedCommands: [],
  ignorePatterns: [],
  autoApprove: false,
};

function session(root: string): Session {
  return {
    id: "test",
    projectPath: root,
    messages: [],
    model: "test",
    provider: "anthropic",
    totalTokens: { inputTokens: 0, outputTokens: 0 },
    totalCost: 0,
    undoStack: [],
    createdAt: "",
    updatedAt: "",
  };
}

function registry(root: string, autoApprove = true): ToolRegistry {
  const gate = new ApprovalGate(
    config,
    { autoApprove, allowedTools: new Set(), nonInteractive: true },
    {
      async requestApproval() {
        return "denied";
      },
    },
  );
  return new ToolRegistry(root, [], gate, session(root));
}

afterEach(async () => {
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ToolRegistry", () => {
  test("blocks writes to an existing unread file", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-"));
    paths.push(root);
    const file = join(root, "file.txt");
    await writeFile(file, "before");

    const result = await registry(root).execute("write_file", {
      path: "file.txt",
      content: "after",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Read-before-write");
    expect(await readFile(file, "utf8")).toBe("before");
  });

  test("edits only a unique read string", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-"));
    paths.push(root);
    const file = join(root, "file.txt");
    await writeFile(file, "one\none\n");
    const tools = registry(root);

    await tools.execute("read_file", { path: "file.txt" });
    const ambiguous = await tools.execute("edit_file", {
      path: "file.txt",
      old_str: "one",
      new_str: "two",
    });
    expect(ambiguous.isError).toBe(true);

    const changed = await tools.execute("edit_file", {
      path: "file.txt",
      old_str: "one\none",
      new_str: "two",
    });
    expect(changed.isError).not.toBe(true);
    expect(await readFile(file, "utf8")).toBe("two\n");
  });

  test("rejects paths outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-"));
    paths.push(root);
    const result = await registry(root).execute("read_file", {
      path: "../outside.txt",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("outside the project root");
  });

  test("blocks writes through a symlinked parent outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-"));
    const outside = await mkdtemp(join(tmpdir(), "chiselcode-outside-"));
    paths.push(root, outside);
    await symlink(outside, join(root, "escape"));

    const result = await registry(root).execute("write_file", {
      path: "escape/created.txt",
      content: "blocked",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("outside the project root");
  });

  test("requires reading a file before deleting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-"));
    paths.push(root);
    const file = join(root, "file.txt");
    await writeFile(file, "before");

    const result = await registry(root).execute("delete_file", {
      path: "file.txt",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Read-before-write");
    expect(await readFile(file, "utf8")).toBe("before");
  });
});
