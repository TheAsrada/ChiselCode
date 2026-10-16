/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TerminalScrollbox } from "../../src/ui/terminal-decoration.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

test("native scrollbar retains viewport and scroll position across content updates", async () => {
  let append!: () => void;
  function Harness() {
    const [count, setCount] = useState(30);
    append = () => setCount((value) => value + 1);
    return (
      <TerminalScrollbox id="scroll" width={20} height={6}>
        {Array.from({ length: count }, (_, i) => `line ${i}`).map((line) => (
          <text key={line} height={1} flexShrink={0}>
            {line}
          </text>
        ))}
      </TerminalScrollbox>
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
    expect(feed.verticalScrollBar.slider.visible).toBe(true);
    expect(feed.verticalScrollBar.showArrows).toBe(false);
    await act(async () => {
      feed.scrollTo(10);
      append();
      await setup.renderOnce();
    });
    expect(setup.renderer.root.findDescendantById("scroll")).toBe(feed);
    expect(feed.scrollTop).toBe(10);
    expect(feed.verticalScrollBar.slider.visible).toBe(true);
  } finally {
    act(() => setup.renderer.destroy());
  }
});

for (const width of [40, 120]) {
  test(`graphical chrome scrolls and preserves Unicode content at ${width} columns`, async () => {
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
      expect(setup.captureCharFrame()).toMatch(/[\u2500-\u259f]/u);
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
      await act(async () => {
        feed.scrollBy(-3);
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
    } finally {
      act(() => setup.renderer.destroy());
      workspace.dispose();
    }
  });
}
