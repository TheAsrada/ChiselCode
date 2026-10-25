import { expect, test } from "bun:test";
import { validateSkillPackage } from "../../src/skills/package.js";
import { parseSkillSource } from "../../src/skills/source.js";

test("pasted skills commands are source data with a single selector", () => {
  expect(
    parseSkillSource({
      source:
        'npx --yes skills add "https://github.com/openai/plugins" --skill frontend-skill -g -y',
    }),
  ).toEqual({
    kind: "github",
    repository: "openai/plugins",
    path: "",
    skill: "frontend-skill",
  });
  expect(
    parseSkillSource({ source: "msmps/opentui-skill", skill: "opentui" }),
  ).toMatchObject({ repository: "msmps/opentui-skill", skill: "opentui" });
  expect(
    parseSkillSource({
      source: "https://github.com/acme/repo/tree/main/skills/frontend",
    }),
  ).toMatchObject({ ref: "main", path: "skills/frontend" });
  expect(
    parseSkillSource({
      source:
        "https://raw.githubusercontent.com/acme/repo/main/skills/frontend/SKILL.md",
    }),
  ).toMatchObject({ ref: "main", path: "skills/frontend" });
  expect(
    parseSkillSource({ source: "https://skills.example/frontend/SKILL.md" })
      .kind,
  ).toBe("markdown");
});

for (const source of [
  "npx skills add acme/repo; echo x",
  "npx skills add acme/repo --skill '$(id)'",
  "npx skills add acme/repo\nwhoami",
  "npx evil add acme/repo",
  "npx skills add acme/repo --all",
  "npx skills add acme/repo --skill x y",
  "npx skills add acme/repo --agent other",
  'npx skills add "acme/repo',
  "https://user:pass@example.com/SKILL.md",
  "http://example.com/SKILL.md",
  "https://github.com/acme/repo/releases/latest",
  "https://example.com/skill.zip",
  "https://example.com/SKILL.md?token=x",
])
  test(`reject unsupported or executable input: ${source}`, () => {
    expect(() => parseSkillSource({ source })).toThrow();
  });

const skill = Buffer.from(
  "---\nname: ui-design\ndescription: Design UI.\n---\nRead references/guide.md.\n",
);
test("the imported frontmatter name is authoritative; assets retain original bytes", () => {
  const pkg = validateSkillPackage(
    new Map([
      ["SKILL.md", skill],
      ["assets/pixel.bin", Buffer.from([0, 255, 127])],
    ]),
    "different-folder",
    { url: "https://github.com/acme/repo" },
  );
  expect(pkg.metadata.name).toBe("ui-design");
  expect(pkg.files.get("assets/pixel.bin")).toEqual(Buffer.from([0, 255, 127]));
});
for (const path of [
  "../escape",
  "C:/escape",
  "references/CON.txt",
  "references/a.",
  "references/a\\b",
  "references/\u202eevil",
  ".chisel-source.json",
  "other/SKILL.md",
])
  test(`reject unsafe package member ${path}`, () => {
    expect(() =>
      validateSkillPackage(
        new Map([
          ["SKILL.md", skill],
          [path, Buffer.from("bad")],
        ]),
        "ui-design",
        { url: "test" },
      ),
    ).toThrow();
  });
test("case collisions, overlapping file paths and oversized instructions fail before publication", () => {
  for (const files of [
    new Map([
      ["SKILL.md", skill],
      ["references/a", skill],
      ["references/A", skill],
    ]),
    new Map([
      ["SKILL.md", skill],
      ["references/a", skill],
      ["references/a/b", skill],
    ]),
    new Map([["SKILL.md", Buffer.alloc(65537)]]),
  ])
    expect(() =>
      validateSkillPackage(files, "ui-design", { url: "test" }),
    ).toThrow();
});

test("portable packages reject different spellings of the same parent directory", () => {
  expect(() =>
    validateSkillPackage(
      new Map([
        ["SKILL.md", skill],
        ["references/a.md", skill],
        ["References/b.md", skill],
      ]),
      "ui-design",
      { url: "test" },
    ),
  ).toThrow();
});
