import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../../src/core/prompt.js";
import type { Skill } from "../../src/skills/skills.js";

describe("prompt composition", () => {
  test("keeps base, project, then dynamic context ordering", () => {
    const prompt = buildSystemPrompt("PROJECT_RULE", {
      os: "test",
      cwd: "/project",
      date: "2026-01-01",
    });
    expect(prompt.indexOf("You are ChiselCode")).toBeLessThan(
      prompt.indexOf("PROJECT_RULE"),
    );
    expect(prompt.indexOf("PROJECT_RULE")).toBeLessThan(
      prompt.indexOf("Operating system: test"),
    );
  });

  test("advertises only model skills without paths or bodies and omits empty catalog", () => {
    const context = { os: "test", cwd: "/project", date: "2026-01-01" };
    const skills: Skill[] = [
      {
        name: "code-review",
        description: "Review changes",
        instructions: "Detailed review process",
        source: "bundled",
        dir: "/outside/code-review",
      },
      {
        name: "skill-creator",
        description: "Create skills",
        instructions: "Creator body",
        disableModelInvocation: true,
        source: "bundled",
        dir: "/outside/skill-creator",
      },
    ];
    const prompt = buildSystemPrompt("", context, skills);
    expect(prompt).toContain("<name>code-review</name>");
    expect(prompt).toContain("Review changes");
    expect(prompt).not.toContain("skill-creator");
    expect(prompt).not.toContain("/outside");
    expect(prompt).not.toContain("Detailed review process");
    expect(prompt).toContain("If none matches, load none");
    expect(buildSystemPrompt("", context, skills.slice(1))).not.toContain(
      "\n<available_skills>\n",
    );
  });

  test("does not add an arbitrary file tree to system context", () => {
    const context = {
      os: "test",
      cwd: "/project",
      date: "2026-01-01",
      fileTree: "SECRET_TREE",
    };
    expect(buildSystemPrompt("", context)).not.toContain("SECRET_TREE");
  });
});
