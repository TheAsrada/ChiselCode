import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildActiveSkillsPrompt,
  expandSkill,
  invocableSkills,
  loadSkills,
  parseSkillFile,
  personalSkillsDir,
  type Skill,
  skillsCatalogPrompt,
  splitFrontmatter,
  stripActiveSkillsBlock,
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
      const personal = join(root, "personal");
      const global = join(root, "global");
      const bundled = join(root, "bundled");
      for (const dir of [project, shared, personal, global, bundled])
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
      await mkdir(join(personal, "memo"), { recursive: true });
      await writeFile(join(personal, "memo", "SKILL.md"), "Памятка\n");
      // Мусор игнорируется: файлы вместо папок, чужие расширения.
      await writeFile(join(project, "notes.txt"), "не скилл\n");
      const loaded = loadSkills(join(root, "proj"), {
        projectDir: project,
        sharedDir: shared,
        personalDir: personal,
        globalDir: global,
        bundledDir: bundled,
      });
      expect(loaded.map((s) => `${s.source}:${s.name}`).sort()).toEqual([
        "bundled:explain",
        "global:commit",
        "personal:memo",
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
        personalDir: join(root, "missing-personal"),
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
        personalDir: "/nonexistent/p",
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

  test("personal dir is the single home for new skills", () => {
    const dir = personalSkillsDir();
    expect(dir.length).toBeGreaterThan(0);
    if (process.platform === "win32") expect(dir).toContain("skills");
    else expect(dir).toContain("chiselcode");
  });

  test("user-invocable false hides the skill from slash commands", () => {
    const parsed = parseSkillFile(
      "skill-creator",
      "---\nname: skill-creator\ndescription: Писатель скиллов\nuser-invocable: false\n---\nПиши скиллы\n",
    );
    expect(parsed?.userInvocable).toBe(false);
    const hidden: Skill = {
      name: "skill-creator",
      description: "Писатель",
      instructions: "Пиши",
      userInvocable: false,
      source: "bundled",
      dir: "/tmp/x",
    };
    const shown: Skill = {
      name: "review",
      description: "Ревью",
      instructions: "Ревью",
      source: "bundled",
      dir: "/tmp/y",
    };
    // В каталоге для агента остаются оба, в командах — только вызываемый.
    expect(skillsCatalogPrompt([hidden, shown])).toContain("/skill-creator");
    expect(invocableSkills([hidden, shown]).map((s) => s.name)).toEqual([
      "review",
    ]);
  });

  test("active skills wrap the prompt in a marked block", () => {
    const active: Skill[] = [
      {
        name: "review",
        description: "Ревью",
        instructions: "Сделай ревью",
        source: "personal",
        dir: "/tmp/r",
      },
    ];
    expect(buildActiveSkillsPrompt([], "задача")).toBe("задача");
    const full = buildActiveSkillsPrompt(active, "задача");
    expect(full).toContain("◈ Активные скиллы: /review");
    expect(full).toContain("Сделай ревью");
    expect(full).toContain("◈ Конец скиллов.");
    expect(full.endsWith("задача")).toBe(true);
    // Полоса для вида: инструкции вырезаются, задача остаётся.
    expect(stripActiveSkillsBlock(full)).toBe("задача");
    expect(stripActiveSkillsBlock("обычный текст")).toBe("обычный текст");
  });

  test("personal shadows global and bundled", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-skills-"));
    try {
      const personal = join(root, "personal");
      const global = join(root, "global");
      await mkdir(join(personal, "memo"), { recursive: true });
      await mkdir(join(global, "memo"), { recursive: true });
      await writeFile(join(personal, "memo", "SKILL.md"), "Личная памятка\n");
      await writeFile(join(global, "memo", "SKILL.md"), "Конфиг-памятка\n");
      const loaded = loadSkills(root, {
        projectDir: join(root, "missing-p"),
        sharedDir: join(root, "missing-s"),
        personalDir: personal,
        globalDir: global,
        bundledDir: join(root, "missing-b"),
      });
      expect(loaded.map((s) => `${s.source}:${s.name}`)).toEqual([
        "personal:memo",
      ]);
      expect(loaded[0]?.instructions).toContain("Личная");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
