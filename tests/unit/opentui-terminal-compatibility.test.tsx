/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import {
  TerminalScrollbox,
  UnicodeDecorationContext,
} from "../../src/ui/terminal-decoration.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

test("changing graphics restores the native scrollbar without recreating the viewport", async () => {
  let change!: (next: boolean) => void;
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  function Harness() {
    const [unicode, setUnicode] = useState(false);
    change = setUnicode;
    return (
      <UnicodeDecorationContext value={unicode}>
        <TerminalScrollbox id="scroll" width={20} height={6}>
          {lines.map((line) => (
            <text key={line} height={1} flexShrink={0}>
              {line}
            </text>
          ))}
        </TerminalScrollbox>
      </UnicodeDecorationContext>
    );
  }
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<Harness />, { width: 20, height: 6 });
    await setup.renderOnce();
  });
  try {
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
    const feed = setup.renderer.root.findDescendantById(
      "scroll",
    ) as ScrollBoxRenderable;
    expect(feed.verticalScrollBar.slider.visible).toBe(false);
    expect(feed.verticalScrollBar.showArrows).toBe(true);
    await act(async () => {
      feed.scrollTo(10);
      change(true);
      await setup.renderOnce();
    });
    expect(setup.renderer.root.findDescendantById("scroll")).toBe(feed);
    expect(feed.scrollTop).toBe(10);
    expect(feed.verticalScrollBar.slider.visible).toBe(true);
    expect(feed.verticalScrollBar.showArrows).toBe(false);
    await act(async () => {
      change(false);
      await setup.renderOnce();
    });
    await act(async () => {
      await setup.renderOnce();
    });
    expect(feed.verticalScrollBar.slider.visible).toBe(false);
    expect(feed.verticalScrollBar.showArrows).toBe(true);
    expect(setup.captureCharFrame()).not.toMatch(/[^\x20-\x7e\n]/u);
  } finally {
    act(() => setup.renderer.destroy());
  }
});

for (const width of [40, 120]) {
  test(`compatible chrome uses ASCII, scrolls and preserves Unicode content at ${width} columns`, async () => {
    const workspace = new TuiWorkspace(process.cwd());
    const controller = workspace.newTab();
    controller.setSessionTitle("Проверка значков");
    controller.append(
      Array.from({ length: 80 }, (_, i) => `Строка ${i}`).join("\n"),
      "assistant",
    );
    let setup!: Awaited<ReturnType<typeof testRender>>;
    const frame = () =>
      act(async () => {
        await setup.renderOnce();
        await setup.renderOnce();
      });
    await act(async () => {
      setup = await testRender(
        <OpenTuiSpike
          workspace={workspace}
          initialMode="hide"
          onExit={() => {}}
          onSubmit={async () => {}}
        />,
        { width, height: 24 },
      );
    });
    try {
      await frame();
      expect(setup.captureCharFrame()).not.toMatch(
        /[^\x20-\x7e\u0400-\u052f\n]/u,
      );
      const findFeed = (
        node: typeof setup.renderer.root,
      ): ScrollBoxRenderable | undefined => {
        if (node instanceof ScrollBoxRenderable) return node;
        for (const child of node.getChildren()) {
          const found = findFeed(child);
          if (found) return found;
        }
      };
      const feed = findFeed(setup.renderer.root);
      if (!feed) throw new Error("Transcript scrollbox is missing");
      const before = feed.scrollTop;
      const arrow = feed.verticalScrollBar.startArrow;
      await act(async () => {
        await setup.mockMouse.click(arrow.x, arrow.y);
      });
      await frame();
      expect(feed.scrollTop).toBeLessThan(before);
      const payload = "👩‍💻 汉字 e\u0301";
      await act(async () => {
        controller.append(payload, "assistant");
        feed.scrollTo(Number.MAX_SAFE_INTEGER);
      });
      await frame();
      expect(controller.snapshot.transcript.at(-1)?.text).toBe(payload);
      expect(setup.captureCharFrame()).toContain(payload);
      expect(setup.captureCharFrame().replaceAll(payload, "")).not.toMatch(
        /[^\x20-\x7e\u0400-\u052f\n]/u,
      );
    } finally {
      act(() => setup.renderer.destroy());
      workspace.dispose();
    }
  });
}
