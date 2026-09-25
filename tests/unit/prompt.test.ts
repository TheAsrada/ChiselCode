import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, compactMessages } from "../../src/core/prompt.js";
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

  test("compacts old history while retaining the newest messages", () => {
    const messages = Array.from({ length: 4 }, (_, index) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `message-${index}` }],
    }));
    const compacted = compactMessages(messages, 2);
    expect(compacted).toHaveLength(3);
    expect(compacted[0]?.content[0]).toMatchObject({
      text: expect.stringContaining("message-0"),
    });
    expect(compacted.at(-1)?.content[0]).toMatchObject({ text: "message-3" });
  });
});
