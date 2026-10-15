import { expect, test } from "bun:test";
import { subagentOutput } from "../../src/subagents/output.js";
import { childFixture } from "../helpers/subagent.js";

test("wait/status model responses keep result references and usage without duplicating the task or attempt ledger", () => {
  const child = childFixture();
  child.task = "Original user task ".repeat(300);
  child.text = "Long result ".repeat(5000);
  child.artifact = { uri: "artifact://sha256/full-result", tokens: 25000 };
  child.spend.usage = { inputTokens: 270000, outputTokens: 5000 };
  child.attempts = Array.from({ length: 24 }, (_, index) => ({
    id: String(index),
    purpose: "generation",
    completed: true,
    usageSource: "observed",
  }));
  for (const action of ["wait", "status"]) {
    const output = subagentOutput(action, action === "wait" ? [child] : child);
    const parsed = JSON.parse(output);
    const value = Array.isArray(parsed) ? parsed[0] : parsed;
    expect(output.length).toBeLessThan(3500);
    expect(value).not.toHaveProperty("task");
    expect(value).not.toHaveProperty("attempts");
    expect(value).not.toHaveProperty("context");
    expect(value.artifact).toEqual(child.artifact);
    expect(value.spend.usage).toEqual(child.spend.usage);
    expect(value.resultAction).toBe("ext:builtin.subagents:result");
  }
});
