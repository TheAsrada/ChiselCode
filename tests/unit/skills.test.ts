import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandSkill,
  loadSkills,
  parseSkillFile,
  type Skill,
  skillsCatalogPrompt,
  splitFrontmatter,
} from "../../src/skills/skills.js";
import {
  commandHelpText,
  matchingCommands,
  suggestSimilarCommand,
} from "../../src/ui/commands.js";

function skill(instructions: string): Skill {
  return {
    name: "test",
    description: "",
    instructions,
    source: "project",
    dir: "/tmp/test",
  };
}

function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

describe("SKILL.md files", () => {
  test("parses frontmatter name, description and body", () => {
    const parsed = parseSkillFile(
      "review",
      skillFile("review", "Ревью diff", "Сделай ревью $ARGUMENTS"),
    );
    expect(parsed).toEqual({
      name: "review",
      description: "Ревью diff",
      instructions: "Сделай ревью $ARGUMENTS",
    });
  });

  test("folds multi-line descriptions and reads allowed-tools", () => {
    const parsed = parseSkillFile(
      "deploy",
      "---\nname: deploy\n" +
        "description: >\n  Деплой сервиса.\n  Используй, когда просят выкатить.\n" +
        "allowed-tools: shell git\n---\nЗадеплой всё\n",
    );
    expect(parsed?.description).toBe(
      "Деплой сервиса. Используй, когда просят выкатить.",
    );
    expect(parsed?.allowedTools).toEqual(["shell", "git"]);
  });

  test("falls back to directory name and first line without frontmatter", () => {
    const parsed = parseSkillFile(
      "commit",
      "Сделай коммит\nподробности ниже\n",
    );
    expect(parsed?.name).toBe("commit");
    expect(parsed?.description).toBe("Сделай коммит");
    expect(parsed?.instructions).toContain("подробности");
  });

  test("rejects empty bodies and invalid names", () => {
    expect(
      parseSkillFile("empty", "---\ndescription: x\n---\n   \n"),
    ).toBeUndefined();
    expect(parseSkillFile("blank", "\n  \n")).toBeUndefined();
    expect(parseSkillFile("BAD NAME", "текст\n")).toBeUndefined();
    expect(
      parseSkillFile("ok", "---\nname: --bad--\ndescription: x\n---\nтекст\n"),
    ).toBeUndefined();
  });

  test("frontmatter name must match the directory", () => {
    expect(
      parseSkillFile("folder", skillFile("real", "Описание", "Текст")),
    ).toBeUndefined();
    const parsed = parseSkillFile(
      "real",
      skillFile("real", "Описание", "Текст"),
    );
    expect(parsed?.name).toBe("real");
  });

  test("splitFrontmatter reads nested metadata maps", () => {
    const { data, body } = splitFrontmatter(
      "---\nname: x\ndescription: y\nmetadata:\n  author: me\n  version: 1.0\n---\nТело\n",
    );
    expect(data.name).toBe("x");
    expect(data.metadata).toContain("author: me");
    expect(body.trim()).toBe("Тело");
  });

  test("loads from project, shared, global and bundled dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-skills-"));
    try {
      const project = join(root, "proj", ".chisel", "skills");
      const shared = join(root, "proj", ".agents", "skills");
      const global = join(root, "global");
      const bundled = join(root, "bundled");
      for (const dir of [project, shared, global, bundled])
        await mkdir(dir, { recursive: true });
      await mkdir(join(project, "review"), { recursive: true });
      await writeFile(
        join(project, "review", "SKILL.md"),
        "Ревью $ARGUMENTS\n",
      );
      await mkdir(join(shared, "plan"), { recursive: true });
      await writeFile(join(shared, "plan", "SKILL.md"), "План\n");
      await mkdir(join(global, "commit"), { recursive: true });
      await writeFile(
        join(global, "commit", "SKILL.md"),
        "---\ndescription: Коммит\n---\nЗакоммить\n",
      );
      await mkdir(join(bundled, "explain"), { recursive: true });
      await writeFile(join(bundled, "explain", "SKILL.md"), "Объясни код\n");
      // Мусор игнорируется: файлы вместо папок, чужие расширения.
      await writeFile(join(project, "notes.txt"), "не скилл\n");
      const loaded = loadSkills(join(root, "proj"), {
        projectDir: project,
        sharedDir: shared,
        globalDir: global,
        bundledDir: bundled,
      });
      expect(loaded.map((s) => `${s.source}:${s.name}`).sort()).toEqual([
        "bundled:explain",
        "global:commit",
        "project:review",
        "shared:plan",
      ]);
      expect(loaded.find((s) => s.name === "commit")?.description).toBe(
        "Коммит",
      );
      expect(loaded.find((s) => s.name === "review")?.dir).toBe(
        join(project, "review"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("project shadows the rest, built-ins win over files", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-skills-"));
    try {
      const project = join(root, "skills");
      const global = join(root, "global");
      await mkdir(join(project, "review"), { recursive: true });
      await mkdir(join(global, "review"), { recursive: true });
      await mkdir(join(project, "settings"), { recursive: true });
      await writeFile(join(global, "review", "SKILL.md"), "Глобальное ревью\n");
      await writeFile(join(project, "review", "SKILL.md"), "Проектное ревью\n");
      await writeFile(
        join(project, "settings", "SKILL.md"),
        "Попытка перекрыть /settings\n",
      );
      const loaded = loadSkills(root, {
        projectDir: project,
        globalDir: global,
        sharedDir: join(root, "missing-shared"),
        bundledDir: join(root, "missing"),
      });
      expect(loaded.map((s) => `${s.source}:${s.name}`)).toEqual([
        "project:review",
      ]);
      expect(loaded[0]?.instructions).toContain("Проектное");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("missing directories give an empty list", () => {
    expect(
      loadSkills("/nonexistent", {
        projectDir: "/nonexistent/a",
        sharedDir: "/nonexistent/s",
        globalDir: "/nonexistent/b",
        bundledDir: "/nonexistent/c",
      }),
    ).toEqual([]);
  });

  test("expands $ARGUMENTS or appends args", () => {
    expect(expandSkill(skill("Сделай $ARGUMENTS сейчас"), "ревью")).toBe(
      "Сделай ревью сейчас",
    );
    expect(expandSkill(skill("Шаблон"), "арг")).toBe("Шаблон\n\nарг");
    expect(expandSkill(skill("Шаблон"), "  ")).toBe("Шаблон");
    expect(expandSkill(skill("A $ARGUMENTS B $ARGUMENTS"), "x")).toBe(
      "A x B x",
    );
  });

  test("catalog prompt stays empty without skills", () => {
    expect(skillsCatalogPrompt([])).toBe("");
    const catalog = skillsCatalogPrompt([
      {
        name: "review",
        description: "Ревью diff",
        instructions: "Ревью",
        source: "project",
        dir: "/proj/.chisel/skills/review",
      },
    ]);
    expect(catalog).toContain("/review");
    expect(catalog).toContain("Ревью diff");
    expect(catalog).toContain("/proj/.chisel/skills/review");
    expect(catalog).toContain("read_file");
  });
});

describe("skill completion and help", () => {
  const skills = [
    { name: "review", description: "Ревью diff" },
    { name: "commit", description: "Коммит" },
  ];

  test("suggestions merge built-in and skill commands", () => {
    const all = matchingCommands("/", skills);
    expect(all.map((c) => c.name)).toContain("/help");
    expect(all.map((c) => c.name)).toContain("/skills");
    expect(all.map((c) => c.name)).toContain("/review");
    const filtered = matchingCommands("/re", skills);
    expect(filtered.map((c) => c.name)).toEqual(["/resume", "/review"]);
    // Без скиллов — только встроенные, как раньше.
    expect(matchingCommands("/re").map((c) => c.name)).toEqual(["/resume"]);
  });

  test("typos hint the closest skill", () => {
    expect(suggestSimilarCommand("/revie", skills)).toBe("/review");
  });

  test("help lists skills in their own section", () => {
    const plain = commandHelpText();
    expect(plain).not.toContain("── Скиллы ──");
    const extended = commandHelpText(skills);
    expect(extended).toContain("── Скиллы ──");
    expect(extended).toContain("/review");
    expect(extended).toContain("Ревью diff");
  });
});
