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
import { searchSkills, skillsCatalogPrompt } from "../../src/skills/catalog.js";
import { splitFrontmatter } from "../../src/skills/frontmatter.js";
import {
  buildActiveSkillsPrompt,
  expandSkill,
  invocableSkills,
  loadSkills,
  modelInvocableSkills,
  parseSkillFile,
  type Skill,
  stripActiveSkillsBlock,
} from "../../src/skills/skills.js";
import {
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
    expect(data.metadata).toEqual({ author: "me", version: 1 });
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

  test("bundled review and creator are available to both model and manual slash", async () => {
    const root = join(import.meta.dir, "..", "..");
    const temporary = await mkdtemp(join(tmpdir(), "chiselcode-bundled-"));
    const bundled = loadSkills(root, {
      homeDir: temporary,
      bundledSourceDir: join(root, "skills", "bundled"),
      legacyDirs: [],
    });
    expect(bundled.map((s) => s.name).sort()).toEqual([
      "code-review",
      "extension-creator",
      "skill-creator",
    ]);
    expect(
      invocableSkills(bundled)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["code-review", "extension-creator", "skill-creator"]);
    const catalog = skillsCatalogPrompt(bundled);
    expect(catalog).toContain("<name>code-review</name>");
    expect(catalog).toContain("<name>skill-creator</name>");
    expect(catalog).not.toContain(bundled[0]?.instructions ?? "impossible");
    await rm(temporary, { recursive: true, force: true });
  });
});

describe("skill completion", () => {
  const skills = [
    { name: "review", description: "Ревью diff" },
    { name: "commit", description: "Коммит" },
  ];

  test("suggestions merge built-in and skill commands", () => {
    const all = matchingCommands("/", skills);
    expect(all.map((c) => c.name)).not.toContain("/help");
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

  test("skill suggestions retain their descriptions and source", () => {
    expect(matchingCommands("/review", skills)).toEqual([
      {
        name: "/review",
        description: "Ревью diff",
        source: { type: "skill", name: "review" },
      },
    ]);
  });
});

test("uses YAML syntax for invocation flags and rejects ambiguous or invalid headers", () => {
  const parse = (header: string, diagnostics: string[] = []) =>
    parseSkillFile(
      "notes",
      `\uFEFF---\r\n${header}\r\n---\r\nInstructions`,
      (message) => diagnostics.push(message),
    );
  expect(
    parse(
      [
        'description: "Keep # and : in text"',
        "defaults: &flags { disable-model-invocation: true }",
        "<<: *flags",
        "user-invocable: false # hide from the slash menu",
      ].join("\r\n"),
    ),
  ).toMatchObject({
    description: "Keep # and : in text",
    disableModelInvocation: true,
    userInvocable: false,
  });
  expect(
    parse('disable-model-invocation: "true"')?.disableModelInvocation,
  ).toBe(true);
  for (const header of [
    "disable-model-invocation: true\ndisable-model-invocation: false",
    "disable-model-invocation: [true]",
    "disable-model-invocation: maybe",
    "user-invocable:",
    "user-invocable: { flag: false }",
    "description: [",
    "- disable-model-invocation: true",
  ]) {
    const diagnostics: string[] = [];
    expect(parse(header, diagnostics)).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
  }
  expect(
    parseSkillFile("notes", "---\ndisable-model-invocation: true\n"),
  ).toBeUndefined();
  expect(
    parse("description: |-\n  Ревью\n  ---\n  Подробнее")?.description,
  ).toBe("Ревью\n---\nПодробнее");
});

test("validates every local candidate and reports invalid frontmatter without losing later skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "chisel-full-skills-"));
  try {
    const root = join(home, "skills", "user");
    await mkdir(root, { recursive: true });
    for (let index = 0; index < 102; index++)
      await writeFile(join(root, `a-${index}`), "Not a skill directory");
    for (const [name, header] of [
      ["bad-flags", "disable-model-invocation: [true]\n"],
      ["zzz-valid", "disable-model-invocation: true # manual only\n"],
    ]) {
      const dir = join(root, name ?? "");
      await mkdir(dir);
      await writeFile(join(dir, "SKILL.md"), `---\n${header}---\nInstructions`);
    }
    const diagnostics: string[] = [];
    const skills = loadSkills(undefined, {
      homeDir: home,
      bundledSourceDir: "",
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(skills.map(({ name }) => name)).toEqual(["zzz-valid"]);
    expect(skills[0]?.disableModelInvocation).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("bad-flags");
    expect(diagnostics[0]).toContain("disable-model-invocation");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("bounds the encoded prompt and searches beyond the preview, with stable pages and visibility", () => {
  const description = `${"🙂<&".repeat(130)} ZEBRA протокол`;
  const skills: Skill[] = Array.from({ length: 104 }, (_, index) => ({
    ...skill("private instructions"),
    name: `a-${String(index).padStart(3, "0")}`,
    description,
  }));
  skills.push({ ...skill("body"), name: "bundled", source: "bundled" });
  skills.push({
    ...skill("body"),
    name: "manual",
    description,
    disableModelInvocation: true,
  });
  skills.push({
    ...skill("body"),
    name: "z-model",
    description,
    userInvocable: false,
  });
  const catalog = skillsCatalogPrompt(skills);
  expect(Buffer.byteLength(catalog)).toBeLessThanOrEqual(8192);
  expect(catalog).toContain("search_skills");
  expect(catalog).toContain("<name>bundled</name>");
  expect(catalog).toContain("&lt;&amp;");
  expect(catalog).not.toContain("private instructions");
  expect(catalog).not.toContain("z-model");
  const first = searchSkills(skills, "  ｚｅｂｒａ ПРОТОКОЛ  ", 0);
  expect(first.total).toBe(105);
  expect(first.skills).toHaveLength(12);
  expect(first.nextOffset).toBe(12);
  expect(first.skills[0]?.description).not.toContain("ZEBRA");
  const last = searchSkills(skills, "zebra протокол", 96);
  expect(last.skills.at(-1)?.name).toBe("z-model");
  expect(last.nextOffset).toBeUndefined();
  expect(searchSkills(skills, "manual", 0).total).toBe(0);
  expect(searchSkills(skills, "zzz-missing", 0).skills).toEqual([]);
  expect(searchSkills(skills, "", 1000).skills).toEqual([]);
});
