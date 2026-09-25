import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { userSkillsDir } from "../../src/paths/home.js";
import type { ApprovalRequest } from "../../src/security/approval.js";
import { ApprovalGate } from "../../src/security/approval.js";
import type { Skill } from "../../src/skills/skills.js";
import { buildFileDiff } from "../../src/tools/file-diff.js";
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

function registry(
  root: string,
  autoApprove = true,
  skills: Skill[] = [],
): ToolRegistry {
  const gate = new ApprovalGate(
    config,
    { autoApprove, allowedTools: new Set(), nonInteractive: true },
    {
      async requestApproval() {
        return "denied";
      },
    },
  );
  return new ToolRegistry(root, [], gate, session(root), skills);
}

afterEach(async () => {
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ToolRegistry", () => {
  test("load_skill uses only the registered snapshot and rejects manual-only names and paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-skills-tool-"));
    paths.push(root);
    const skills: Skill[] = [
      {
        name: "review",
        description: "review",
        instructions: "Review safely",
        source: "user",
        dir: join(root, "review"),
      },
      {
        name: "creator",
        description: "creator",
        instructions: "Create",
        disableModelInvocation: true,
        source: "bundled",
        dir: join(root, "creator"),
      },
    ];
    const tools = registry(root, true, skills);
    expect((await tools.execute("load_skill", { name: "review" })).output).toBe(
      "Review safely",
    );
    expect(
      (await tools.execute("load_skill", { name: "creator" })).isError,
    ).toBe(true);
    expect(
      (
        await tools.execute("load_skill", {
          name: join(root, "review", "SKILL.md"),
        })
      ).isError,
    ).toBe(true);
    expect(
      (await tools.execute("load_skill", { name: "../review" })).isError,
    ).toBe(true);
    skills.push({
      name: "later",
      description: "later",
      instructions: "later",
      source: "user",
      dir: root,
    });
    expect((await tools.execute("load_skill", { name: "later" })).isError).toBe(
      true,
    );
  });

  test("personal skill outside project loads while read_file stays project-bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-project-"));
    const external = await mkdtemp(join(tmpdir(), "chiselcode-personal-"));
    paths.push(root, external);
    await writeFile(join(external, "SKILL.md"), "private instructions");
    const tools = registry(root, true, [
      {
        name: "personal",
        description: "personal",
        instructions: "private instructions",
        source: "user",
        dir: external,
      },
    ]);
    expect(
      (await tools.execute("load_skill", { name: "personal" })).output,
    ).toBe("private instructions");
    expect(
      (await tools.execute("read_file", { path: join(external, "SKILL.md") }))
        .isError,
    ).toBe(true);
  });

  test("create_skill writes only central user skills and protects bundled names and paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-create-skill-"));
    paths.push(root);
    const envName =
      process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
    const previous = process.env[envName];
    process.env[envName] = root;
    try {
      const tools = registry(root);
      const content =
        "---\nname: release-helper\ndescription: Help with releases\n---\nRelease safely\n";
      const created = await tools.execute("create_skill", {
        name: "release-helper",
        files: { "SKILL.md": content, "references/example.md": "Example" },
      });
      expect(created.isError).not.toBe(true);
      expect(
        await readFile(
          join(userSkillsDir(), "release-helper", "SKILL.md"),
          "utf8",
        ),
      ).toBe(content);
      expect(
        await readFile(
          join(userSkillsDir(), "release-helper", "references", "example.md"),
          "utf8",
        ),
      ).toBe("Example");
      const outside = join(root, "outside");
      await mkdir(outside);
      await symlink(
        outside,
        join(userSkillsDir(), "release-helper", "scripts"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(
        (
          await tools.execute("create_skill", {
            name: "release-helper",
            mode: "update",
            files: { "SKILL.md": content, "scripts/escape.txt": "bad" },
          })
        ).isError,
      ).toBe(true);
      expect(
        await readFile(join(outside, "escape.txt"), "utf8").catch(
          () => "missing",
        ),
      ).toBe("missing");
      expect(
        await readFile(
          join(userSkillsDir(), "release-helper", "SKILL.md"),
          "utf8",
        ),
      ).toBe(content);
      expect(
        (
          await tools.execute("create_skill", {
            name: "code-review",
            files: { "SKILL.md": content },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await tools.execute("create_skill", {
            name: "release-helper",
            files: { "SKILL.md": content },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await tools.execute("create_skill", {
            name: "other",
            files: {
              "SKILL.md": content.replace("release-helper", "other"),
              "../outside": "bad",
            },
          })
        ).isError,
      ).toBe(true);
      const updated = await tools.execute("create_skill", {
        name: "release-helper",
        mode: "update",
        files: {
          "SKILL.md": content.replace("Release safely", "Release carefully"),
        },
      });
      expect(updated.isError).not.toBe(true);
      expect(
        await readFile(
          join(userSkillsDir(), "release-helper", "SKILL.md"),
          "utf8",
        ),
      ).toContain("Release carefully");
      expect(
        await readFile(
          join(userSkillsDir(), "release-helper", "references", "example.md"),
          "utf8",
        ),
      ).toBe("Example");
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  test("git_status and git_diff distinguish staged and unstaged changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-git-tools-"));
    paths.push(root);
    await execa("git", ["init", "-q", root]);
    await writeFile(join(root, "file.txt"), "original\n");
    await execa("git", ["add", "file.txt"], { cwd: root });
    await execa(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "base",
      ],
      { cwd: root },
    );
    await writeFile(join(root, "file.txt"), "staged\n");
    await execa("git", ["add", "file.txt"], { cwd: root });
    await writeFile(join(root, "file.txt"), "unstaged\n");
    await writeFile(join(root, "new.txt"), "untracked\n");
    const tools = registry(root);
    const status = await tools.execute("git_status", {});
    expect(status.isError).not.toBe(true);
    expect(status.output).toContain("MM file.txt");
    expect(status.output).toContain("?? new.txt");
    const unstaged = await tools.execute("git_diff", {});
    const staged = await tools.execute("git_diff", { scope: "staged" });
    const all = await tools.execute("git_diff", { scope: "all" });
    expect(unstaged.output).toContain("+unstaged");
    expect(unstaged.output).not.toContain("+staged");
    expect(staged.output).toContain("+staged");
    expect(staged.output).not.toContain("+unstaged");
    expect(all.output).toContain("+unstaged");
    expect(all.output).toContain("-original");
    expect(
      (await tools.execute("git_diff", { scope: "all", path: "file.txt" }))
        .output,
    ).toContain("+unstaged");
    expect(
      (await tools.execute("git_diff", { scope: "all", path: "new.txt" }))
        .output,
    ).not.toContain("+unstaged");
    expect(
      (await tools.execute("git_diff", { scope: "all", path: "../outside" }))
        .isError,
    ).toBe(true);
  });
  test("diff paths stay project-relative when the root is a filesystem alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-alias-"));
    const links = await mkdtemp(join(tmpdir(), "chiselcode-links-"));
    paths.push(links, root);
    const alias = join(links, "project");
    await symlink(
      root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await registry(alias).execute("write_file", {
      path: "new.txt",
      content: "new\n",
    });
    expect(result.isError).not.toBe(true);
    expect(result.fileDiff?.path).toBe("new.txt");
    expect(result.fileDiff?.patch).toContain("Index: new.txt");
  });
  for (const scenario of [
    "create",
    "overwrite",
    "edit",
    "denied",
    "noop",
  ] as const) {
    test(`structured diff ${scenario} keeps approval and undo consistent`, async () => {
      const root = await mkdtemp(join(tmpdir(), "chiselcode-"));
      paths.push(root);
      const current = session(root);
      const requests: ApprovalRequest[] = [];
      const gate = new ApprovalGate(
        config,
        {
          autoApprove: false,
          allowedTools: new Set(),
          nonInteractive: false,
        },
        {
          async requestApproval(request) {
            requests.push(request);
            if (scenario !== "create")
              expect(await readFile(join(root, "file.txt"), "utf8")).toBe(
                "old\nkeep\n",
              );
            return scenario === "denied" ? "denied" : "approved";
          },
        },
      );
      const tools = new ToolRegistry(root, [], gate, current);
      const before = scenario === "create" ? null : "old\nkeep\n";
      if (before !== null) {
        await writeFile(join(root, "file.txt"), before);
        await tools.execute("read_file", { path: "file.txt" });
      }
      const after = scenario === "noop" ? (before ?? "") : "$&\nnew\nkeep\n";
      const result =
        scenario === "edit" || scenario === "noop"
          ? await tools.execute("edit_file", {
              path: "file.txt",
              old_str: before,
              new_str: after,
            })
          : await tools.execute("write_file", {
              path: "file.txt",
              content: after,
            });
      if (scenario === "noop") {
        expect(result.output).toContain("No changes");
        expect(result.fileDiff).toBeUndefined();
        expect(requests).toHaveLength(0);
        expect(current.undoStack).toHaveLength(0);
      } else {
        const expected = buildFileDiff("file.txt", before, after);
        expect(requests[0]?.fileDiff).toEqual(expected);
        expect(requests[0]?.preview).toBe(expected.patch);
        if (scenario === "denied") {
          expect(result.isError).toBe(true);
          expect(result.fileDiff).toBeUndefined();
          expect(current.undoStack).toHaveLength(0);
          expect(await readFile(join(root, "file.txt"), "utf8")).toBe(
            before ?? "",
          );
        } else {
          expect(result.fileDiff).toEqual(expected);
          expect(result.isError).not.toBe(true);
          expect(await readFile(join(root, "file.txt"), "utf8")).toBe(after);
          expect(current.undoStack).toHaveLength(1);
          expect(current.undoStack[0]).toMatchObject({ before, after });
        }
      }
    });
  }
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
    await symlink(
      outside,
      join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

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
