import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, compactMessages } from "../../src/core/prompt.js";

describe("prompt composition", () => {
	test("keeps base, project, then dynamic context ordering", () => {
		const prompt = buildSystemPrompt("PROJECT_RULE", {
			os: "test",
			cwd: "/project",
			date: "2026-01-01",
		});
		expect(prompt.indexOf("secure coding agent")).toBeLessThan(
			prompt.indexOf("PROJECT_RULE"),
		);
		expect(prompt.indexOf("PROJECT_RULE")).toBeLessThan(
			prompt.indexOf("Operating system: test"),
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
