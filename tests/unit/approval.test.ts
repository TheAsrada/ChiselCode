import { describe, expect, test } from "bun:test";
import { ApprovalGate } from "../../src/security/approval.js";
import type { ProjectConfig } from "../../src/types/domain.js";

const config: ProjectConfig = {
	allowedCommands: ["bun test"],
	deniedCommands: ["rm -rf"],
	ignorePatterns: [],
	autoApprove: false,
};

const resolver = {
	async requestApproval() {
		return "denied" as const;
	},
};

describe("ApprovalGate", () => {
	test("auto approves read-only tools", async () => {
		const gate = new ApprovalGate(
			config,
			{ autoApprove: false, allowedTools: new Set(), nonInteractive: true },
			resolver,
		);
		expect(await gate.decide({ tool: "read_file", preview: "" })).toBe(
			"approved",
		);
	});

	test("uses the shell allow and deny lists", async () => {
		const gate = new ApprovalGate(
			config,
			{ autoApprove: false, allowedTools: new Set(), nonInteractive: true },
			resolver,
		);
		expect(
			await gate.decide({
				tool: "run_shell",
				preview: "",
				command: "bun test",
			}),
		).toBe("approved");
		expect(
			await gate.decide({
				tool: "run_shell",
				preview: "",
				command: "rm -rf build",
			}),
		).toBe("denied");
		expect(
			await gate.decide({
				tool: "run_shell",
				preview: "",
				command: "bun run build",
			}),
		).toBe("unavailable");
	});
});
