/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ContextSidebar } from "../../src/ui/context-sidebar.js";

test("native sidebar shows observed usage and current Git changes", async () => {
  const setup = await testRender(
    <ContextSidebar
      height={30}
      state={{
        projectPath: "/project",
        sessionId: "s",
        transcript: [],
        streaming: "",
        draft: "",
        focus: "composer",
        usage: {
          provider: "anthropic",
          model: "model",
          totalTokens: { inputTokens: 8000, outputTokens: 2000 },
          totalCost: 0,
          contextSnapshot: {
            model: "model",
            observedInputTokens: 120,
            contextWindow: 1000,
            observedAt: "2026-09-28T00:00:00.000Z",
            source: "provider_usage",
            status: "observed",
          },
        },
        gitChanges: {
          root: "/project",
          branch: "main",
          totalFiles: 1,
          files: [
            {
              path: "src/example.ts",
              status: " M",
              additions: 4,
              deletions: 2,
            },
          ],
        },
      }}
    />,
    { width: 40, height: 30 },
  );
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Последний запрос:");
    expect(frame).toContain("120 /");
    expect(frame).toContain("12%");
    expect(frame).toContain("example.ts +4 -2");
    expect(frame).toContain("токенов");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
