import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledSkillsDir,
  chiselHomeDir,
  sessionsRootDir,
  skillsRootDir,
  userSkillsDir,
} from "../../src/paths/home.js";
import {
  buildActiveSkillsPrompt,
  expandSkill,
  invocableSkills,
  loadSkills,
  modelInvocableSkills,
  parseSkillFile,
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
    source: "user",
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

  test("migrates legacy project skills into central user storage without deleting sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-skills-"));
    try {
      const project = join(root, "project");
      const legacy = join(project, ".chisel", "skills", "memo");
      const home = join(root, "home");
      await mkdir(legacy, { recursive: true });
      await mkdir(join(legacy, "references"));
      await writeFile(
        join(legacy, "SKILL.md"),
        skillFile("memo", "Памятка", "Запомни"),
      );
      await writeFile(join(legacy, "references", "details.md"), "details");
      const loaded = loadSkills(project, {
        homeDir: home,
        bundledSourceDir: join(root, "missing"),
        legacyDirs: [join(project, ".chisel", "skills")],
      });
      expect(loaded.map((entry) => `${entry.source}:${entry.name}`)).toEqual([
        "user:memo",
      ]);
      expect(loaded[0]?.dir).toBe(join(home, "skills", "user", "memo"));
      expect(await readFile(join(legacy, "SKILL.md"), "utf8")).toContain(
        "Запомни",
      );
      expect(
        await readFile(
          join(home, "skills", "user", "memo", "SKILL.md"),
          "utf8",
        ),
      ).toContain("Запомни");
      expect(
        await readFile(
          join(home, "skills", "user", "memo", "references", "details.md"),
          "utf8",
        ),
      ).toBe("details");
      expect(await readdir(join(home, "skills", ".migrations"))).toHaveLength(
        1,
      );
      await writeFile(
        join(legacy, "SKILL.md"),
        skillFile("memo", "Changed", "Changed"),
      );
      expect(
        loadSkills(project, {
          homeDir: home,
          bundledSourceDir: join(root, "missing"),
          legacyDirs: [join(project, ".chisel", "skills")],
        })[0]?.instructions,
      ).toBe("Запомни");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("empty central directories yield no skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-skills-"));
    try {
      const old = join(root, ".chisel", "skills", "project-only");
      await mkdir(old, { recursive: true });
      await writeFile(
        join(old, "SKILL.md"),
        skillFile("project-only", "Legacy", "Old"),
      );
      expect(
        loadSkills(root, {
          homeDir: join(root, "home"),
          bundledSourceDir: join(root, "missing"),
          legacyDirs: [],
        }),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migration skips linked resources without deleting the legacy skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-skills-link-"));
    try {
      const legacyRoot = join(root, "legacy");
      const skillDir = join(legacyRoot, "memo");
      const outside = join(root, "outside");
      await mkdir(skillDir, { recursive: true });
      await mkdir(outside);
      await writeFile(
        join(skillDir, "SKILL.md"),
        skillFile("memo", "Memo", "Read"),
      );
      await symlink(
        outside,
        join(skillDir, "references"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const diagnostics: string[] = [];
      expect(
        loadSkills(root, {
          homeDir: join(root, "home"),
          bundledSourceDir: join(root, "missing"),
          legacyDirs: [legacyRoot],
          onDiagnostic: (message) => diagnostics.push(message),
        }),
      ).toEqual([]);
      expect(diagnostics.join(" ")).toContain("Исходные файлы сохранены");
      expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain(
        "Read",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  test("path API keeps skills and sessions under one home", () => {
    expect(skillsRootDir()).toBe(join(chiselHomeDir(), "skills"));
    expect(bundledSkillsDir()).toBe(join(skillsRootDir(), "bundled"));
    expect(userSkillsDir()).toBe(join(skillsRootDir(), "user"));
    expect(sessionsRootDir()).toBe(join(chiselHomeDir(), "sessions"));
    if (process.platform === "win32" && process.env.LOCALAPPDATA)
      expect(chiselHomeDir()).toBe(
        join(process.env.LOCALAPPDATA, "ChiselCode"),
      );
  });

  test("manual and model invocation flags are independent", () => {
    const parsed = parseSkillFile(
      "skill-creator",
      "---\nname: skill-creator\ndescription: Писатель скиллов\ndisable-model-invocation: true\n---\nПиши скиллы\n",
    );
    expect(parsed?.disableModelInvocation).toBe(true);
    expect(parsed?.userInvocable).toBeUndefined();
    const hidden: Skill = {
      name: "skill-creator",
      description: "Писатель",
      instructions: "Пиши",
      disableModelInvocation: true,
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
    // Ручной вызов и автоматическая загрузка не зависят друг от друга.
    expect(skillsCatalogPrompt([hidden, shown])).not.toContain("skill-creator");
    expect(invocableSkills([hidden, shown]).map((s) => s.name)).toEqual([
      "skill-creator",
      "review",
    ]);
    const agentOnly = { ...shown, userInvocable: false };
    expect(skillsCatalogPrompt([agentOnly])).toContain("review");
    expect(modelInvocableSkills([agentOnly])).toHaveLength(1);
    expect(invocableSkills([agentOnly])).toHaveLength(0);
    expect(
      parseSkillFile(
        "x",
        "---\ndescription: x\ndisable-model-invocation: false\nuser-invocable: false\n---\nbody",
      )?.disableModelInvocation,
    ).toBe(false);
  });

  test("active skills wrap the prompt in a marked block", () => {
    const active: Skill[] = [
      {
        name: "review",
        description: "Ревью",
        instructions: "Сделай ревью",
        source: "user",
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

  test("bundled names stay reserved and conflicting user skills are diagnosed", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-skills-"));
    try {
      const home = join(root, "home");
      const source = join(root, "package", "code-review");
      const user = join(home, "skills", "user", "code-review");
      await mkdir(source, { recursive: true });
      await mkdir(user, { recursive: true });
      await writeFile(
        join(source, "SKILL.md"),
        skillFile("code-review", "Bundled", "Original"),
      );
      await writeFile(
        join(user, "SKILL.md"),
        skillFile("code-review", "User", "Override"),
      );
      const diagnostics: string[] = [];
      const loaded = loadSkills(root, {
        homeDir: home,
        bundledSourceDir: join(root, "package"),
        legacyDirs: [],
        onDiagnostic: (message) => diagnostics.push(message),
      });
      expect(loaded.map((s) => `${s.source}:${s.name}`)).toEqual([
        "bundled:code-review",
      ]);
      expect(loaded[0]?.instructions).toBe("Original");
      expect(diagnostics.join(" ")).toContain("зарезервировано");
      expect(await readFile(join(user, "SKILL.md"), "utf8")).toContain(
        "Override",
      );
      await writeFile(
        join(source, "SKILL.md"),
        skillFile("code-review", "Bundled", "Updated"),
      );
      expect(
        loadSkills(root, {
          homeDir: home,
          bundledSourceDir: join(root, "package"),
          legacyDirs: [],
          onDiagnostic: () => {},
        })[0]?.instructions,
      ).toBe("Updated");
      expect(await readFile(join(user, "SKILL.md"), "utf8")).toContain(
        "Override",
      );
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
        source: "user",
        dir: "/home/skills/user/review",
      },
    ]);
    expect(catalog).toContain("<available_skills>");
    expect(catalog).toContain("<name>review</name>");
    expect(catalog).toContain("Ревью diff");
    expect(catalog).not.toContain("/home/skills/user/review");
    expect(catalog).not.toContain("read_file");
    expect(catalog).not.toContain("Ревью</description>");
  });

  test("bundled skills expose review to the model and creator only to manual slash", async () => {
    const root = join(import.meta.dir, "..", "..");
    const temporary = await mkdtemp(join(tmpdir(), "chiselcode-bundled-"));
    const bundled = loadSkills(root, {
      homeDir: temporary,
      bundledSourceDir: join(root, "skills", "bundled"),
      legacyDirs: [],
    });
    expect(bundled.map((s) => s.name).sort()).toEqual([
      "code-review",
      "skill-creator",
    ]);
    expect(
      invocableSkills(bundled)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["code-review", "skill-creator"]);
    const catalog = skillsCatalogPrompt(bundled);
    expect(catalog).toContain("<name>code-review</name>");
    expect(catalog).not.toContain("skill-creator");
    expect(catalog).not.toContain(bundled[0]?.instructions ?? "impossible");
    await rm(temporary, { recursive: true, force: true });
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
