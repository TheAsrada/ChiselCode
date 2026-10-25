import { expect, test } from "bun:test";
import { validateSkillPackage } from "../../src/skills/package.js";
import { selectSkillPath } from "../../src/skills/selection.js";
import { parseSkillSource, SkillSourceInput } from "../../src/skills/source.js";

test("optional skill arguments accept omission/null while placeholder revisions fail with a repair hint", () => {
  for (const revision of [undefined, null, "A".repeat(40)])
    expect(
      SkillSourceInput.safeParse({ source: "acme/repo", skill: null, revision })
        .success,
    ).toBe(true);
  for (const revision of ["0".repeat(40), "", "HEAD", "g".repeat(40)]) {
    const result = SkillSourceInput.safeParse({
      source: "acme/repo",
      revision,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("revision");
  }
  expect(() =>
    SkillSourceInput.parse({ source: "acme/repo", revision: "0".repeat(40) }),
  ).toThrow("уберите revision");
});

test("a full path refines the skill named in a pasted command, but cannot substitute another skill", () => {
  const source = "npx skills add acme/repo --skill caveman";
  expect(parseSkillSource({ source, skill: "skills/caveman" })).toMatchObject({
    skill: "skills/caveman",
  });
  expect(
    parseSkillSource({
      source,
      skill: "plugins/caveman/skills/caveman/SKILL.md",
    }),
  ).toMatchObject({ skill: "plugins/caveman/skills/caveman/SKILL.md" });
  expect(() => parseSkillSource({ source, skill: "skills/other" })).toThrow(
    "противоречит",
  );
});

test("a bare name prefers canonical skills packaging, independent of Git tree order; an exact plugin path wins", () => {
  const candidates = [
    "plugins/caveman/skills/caveman/SKILL.md",
    "caveman/SKILL.md",
    "skills/caveman/SKILL.md",
    "skills/other/SKILL.md",
  ];
  const source = {
    kind: "github" as const,
    repository: "acme/repo",
    path: "",
    skill: "caveman",
  };
  for (const paths of [candidates, [...candidates].reverse()])
    expect(selectSkillPath(paths, source)).toMatchObject({
      path: "skills/caveman/SKILL.md",
      reason: "canonical_directory",
    });
  expect(
    selectSkillPath(candidates, {
      ...source,
      skill: "plugins/caveman/skills/caveman",
    }).path,
  ).toBe(candidates[0]);
});

test("an explicit commit URL cannot be silently replaced by another revision", () => {
  expect(() =>
    parseSkillSource({
      source: `https://github.com/acme/repo/tree/${"a".repeat(40)}/skills/caveman`,
      revision: "b".repeat(40),
    }),
  ).toThrow("противоречит");
});

test("folder-scoped selection accepts full repository paths and does not resolve unrelated ambiguous names", () => {
  const source = {
    kind: "github" as const,
    repository: "acme/repo",
    path: "plugins/example/skills/caveman",
    skill: "plugins/example/skills/caveman",
  };
  expect(selectSkillPath(["SKILL.md"], source).path).toBe("SKILL.md");
  expect(
    selectSkillPath(
      [
        "variants/a/caveman/SKILL.md",
        "variants/b/caveman/SKILL.md",
        "skills/other/SKILL.md",
      ],
      { ...source, path: "", skill: "caveman" },
    ),
  ).toEqual({
    matches: ["variants/a/caveman/SKILL.md", "variants/b/caveman/SKILL.md"],
  });
  expect(
    selectSkillPath(["skills/caveman/SKILL.md", "skills/other/SKILL.md"], {
      ...source,
      path: "",
      skill: undefined,
    }).path,
  ).toBeUndefined();
});

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
