import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CustomCommand,
  expandCustomCommand,
  loadCustomCommands,
  parseCommandFile,
} from "../../src/commands/custom.js";
import { commandHelpText, matchingCommands } from "../../src/ui/commands.js";

function command(prompt: string): CustomCommand {
  return { name: "test", description: "", prompt, source: "project" };
}

describe("custom command files", () => {
  test("parses frontmatter description and body", () => {
    const parsed = parseCommandFile(
      "review",
      "---\ndescription: Ревью diff\n---\nСделай ревью $ARGUMENTS\n",
    );
    expect(parsed).toEqual({
      name: "review",
      description: "Ревью diff",
      prompt: "Сделай ревью $ARGUMENTS",
    });
  });

  test("falls back to the first line when no frontmatter", () => {
    const parsed = parseCommandFile(
      "commit",
      "Сделай коммит\nподробности ниже\n",
    );
    expect(parsed?.description).toBe("Сделай коммит");
    expect(parsed?.prompt).toContain("подробности");
  });

  test("rejects empty bodies", () => {
    expect(
      parseCommandFile("empty", "---\ndescription: x\n---\n   \n"),
    ).toBeUndefined();
    expect(parseCommandFile("blank", "\n  \n")).toBeUndefined();
  });

  test("loads from project, global and bundled dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-cmd-"));
    try {
      const project = join(root, "proj", ".chisel", "commands");
      const global = join(root, "global");
      const bundled = join(root, "bundled");
      await mkdir(project, { recursive: true });
      await mkdir(global, { recursive: true });
      await mkdir(bundled, { recursive: true });
      await writeFile(join(project, "review.md"), "Ревью $ARGUMENTS\n");
      await writeFile(
        join(global, "commit.md"),
        "---\ndescription: Коммит\n---\nЗакоммить\n",
      );
      await writeFile(join(bundled, "explain.md"), "Объясни код\n");
      await writeFile(join(project, "notes.txt"), "не команда\n");
      await writeFile(join(project, "BAD NAME.md"), "плохое имя\n");
      const loaded = loadCustomCommands(join(root, "proj"), {
        projectDir: project,
        globalDir: global,
        bundledDir: bundled,
      });
      expect(loaded.map((c) => `${c.source}:${c.name}`).sort()).toEqual([
        "bundled:explain",
        "global:commit",
        "project:review",
      ]);
      expect(loaded.find((c) => c.name === "commit")?.description).toBe(
        "Коммит",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("project shadows global and bundled, built-ins win over files", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-cmd-"));
    try {
      const project = join(root, "commands");
      const global = join(root, "global");
      await mkdir(project, { recursive: true });
      await mkdir(global, { recursive: true });
      await writeFile(join(global, "review.md"), "Глобальное ревью\n");
      await writeFile(join(project, "review.md"), "Проектное ревью\n");
      await writeFile(
        join(project, "settings.md"),
        "Попытка перекрыть /settings\n",
      );
      const loaded = loadCustomCommands(root, {
        projectDir: project,
        globalDir: global,
        bundledDir: join(root, "missing"),
      });
      expect(loaded.map((c) => `${c.source}:${c.name}`)).toEqual([
        "project:review",
      ]);
      expect(loaded[0]?.prompt).toContain("Проектное");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("missing directories give an empty list", () => {
    expect(
      loadCustomCommands("/nonexistent", {
        projectDir: "/nonexistent/a",
        globalDir: "/nonexistent/b",
        bundledDir: "/nonexistent/c",
      }),
    ).toEqual([]);
  });
  test("expands $ARGUMENTS or appends args", () => {
    expect(
      expandCustomCommand(command("Сделай $ARGUMENTS сейчас"), "ревью"),
    ).toBe("Сделай ревью сейчас");
    expect(expandCustomCommand(command("Шаблон"), "арг")).toBe("Шаблон\n\nарг");
    expect(expandCustomCommand(command("Шаблон"), "  ")).toBe("Шаблон");
    expect(expandCustomCommand(command("A $ARGUMENTS B $ARGUMENTS"), "x")).toBe(
      "A x B x",
    );
  });
});

describe("custom command completion and help", () => {
  const custom = [
    { name: "review", description: "Ревью diff" },
    { name: "commit", description: "Коммит" },
  ];

  test("suggestions merge built-in and custom commands", () => {
    const all = matchingCommands("/", custom);
    expect(all.map((c) => c.name)).toContain("/help");
    expect(all.map((c) => c.name)).toContain("/review");
    const filtered = matchingCommands("/re", custom);
    expect(filtered.map((c) => c.name)).toEqual(["/resume", "/review"]);
    // Без своих команд — только встроенные, как раньше.
    expect(matchingCommands("/re").map((c) => c.name)).toEqual(["/resume"]);
  });

  test("help lists custom commands in their own section", () => {
    const plain = commandHelpText();
    expect(plain).not.toContain("Свои команды");
    const extended = commandHelpText(custom);
    expect(extended).toContain("── Свои команды ──");
    expect(extended).toContain("/review");
    expect(extended).toContain("Ревью diff");
  });
});
