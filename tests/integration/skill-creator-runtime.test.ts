import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("npm includes all bundled skills and the built module discovers them from the installed package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-skills-package-"));
  try {
    const pack = Bun.spawn(
      ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, code] = await Promise.all([
      new Response(pack.stdout).text(),
      new Response(pack.stderr).text(),
      pack.exited,
    ]);
    expect(code, error).toBe(0);
    const files = (
      JSON.parse(output) as { files: { path: string }[] }[]
    )[0]?.files.map((file) => file.path);
    expect(files).toContain("skills/bundled/skill-creator/SKILL.md");
    expect(files).toContain("skills/bundled/code-review/SKILL.md");
    expect(files).toContain("skills/bundled/extension-creator/SKILL.md");
    expect(files).toContain("dist/extension-sdk/ui-composition.d.ts");
    const packageRoot = join(directory, "node_modules/chiselcode");
    await mkdir(join(packageRoot, "skills"), { recursive: true });
    await cp("skills/bundled", join(packageRoot, "skills/bundled"), {
      recursive: true,
    });
    const built = await Bun.build({
      entrypoints: [resolve("src/skills/skills.ts")],
      outdir: join(packageRoot, "dist"),
      target: "bun",
    });
    expect(built.success, String(built.logs)).toBe(true);
    const module = await import(
      pathToFileURL(join(packageRoot, "dist/skills.js")).href
    );
    const skills: import("../../src/skills/skills.js").Skill[] =
      module.loadSkills(directory, {
        homeDir: join(directory, "home"),
        legacyDirs: [],
      });
    expect(skills.map((skill) => skill.name).sort()).toEqual([
      "code-review",
      "extension-creator",
      "skill-creator",
    ]);
    expect(
      module
        .modelInvocableSkills(skills)
        .map((skill: { name: string }) => skill.name),
    ).toContain("skill-creator");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test("production OpenTUI invokes the bundled creator automatically and by slash, saving localized user skills", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-skill-creator.ts"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Skill creator OpenTUI:");
}, 45000);
