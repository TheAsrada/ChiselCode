/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { THEMES } from "../../src/ui/appearance.js";
import { ContextSidebar } from "../../src/ui/context-sidebar.js";
import type { TuiViewState } from "../../src/ui/tui-controller.js";

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
    expect(frame).toContain("Окно:");
    expect(frame).toContain("120 /");
    expect(frame).toContain("12%");
    expect(frame).toContain("example.ts +4 -2");
    expect(frame).toContain("Расход сессии:");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const theme of ["obsidian", "paper"] as const)
  for (const scenario of [
    "estimated",
    "observed",
    "unknown",
    "before-request",
  ] as const)
    test(`native sidebar ${theme}/${scenario}: model window, current occupancy and honest precision`, async () => {
      const state: TuiViewState = {
        agentMode: "build",
        approvalMode: "default",
        projectPath: "/project",
        transcript: [],
        streaming: "",
        draft: "",
        focus: "composer",
        modelSelection: {
          provider: "openai-compatible",
          model: "deepseek-v4p1-flash",
        },
        modelCapabilities: {
          tokenCounting: "local_estimate",
          contextWindow: scenario === "unknown" ? undefined : 1_000_000,
          limitsSource: "catalog",
        },
        contextSnapshot:
          scenario === "before-request"
            ? undefined
            : {
                model: "deepseek-v4p1-flash",
                observedInputTokens: 1000,
                occupiedTokens: 33_000,
                contextWindow: scenario === "unknown" ? undefined : 1_000_000,
                source:
                  scenario === "observed" ? "count_tokens" : "local_estimate",
                status: scenario === "observed" ? "observed" : "estimated",
                windowSource: "provider",
                observedAt: new Date().toISOString(),
              },
      };
      let setup!: Awaited<ReturnType<typeof testRender>>;
      await act(async () => {
        setup = await testRender(
          <ContextSidebar state={state} palette={THEMES[theme]} height={24} />,
          { width: 40, height: 24 },
        );
      });
      try {
        await act(async () => {
          await setup.renderOnce();
        });
        const frame = setup.captureCharFrame().replaceAll("\u00a0", " ");
        expect(frame).not.toContain("Последний запрос");
        expect(frame).not.toContain("#");
        if (scenario === "unknown") {
          expect(frame).toContain("Размер окна неизвестен");
          expect(frame).not.toContain("%");
        } else {
          expect(frame).toContain("Окно: 1 000 000");
          if (scenario === "before-request") {
            expect(frame).toContain("каталог");
            expect(frame).toContain("Заполнение: —");
            expect(frame).not.toContain("%");
          } else {
            expect(frame).toContain("33 000 / 1 000 000");
            expect(frame).toContain(
              scenario === "estimated" ? "~3,3%" : "3,3%",
            );
            expect(frame.includes("приблизительная оценка")).toBe(
              scenario === "estimated",
            );
          }
        }
      } finally {
        act(() => setup.renderer.destroy());
      }
    });
