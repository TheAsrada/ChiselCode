/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { THEMES } from "../../src/ui/appearance.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { FormattedMessage } from "../../src/ui/opentui-transcript.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
  });
  const node = setup.renderer.root.findDescendantById("message");
  if (!node) throw new Error("Missing message");
  return setup
    .captureCharFrame()
    .split("\n")
    .slice(node.y, node.y + node.height)
    .map((row) => row.trim());
}
function view(content: string, width: number) {
  return (
    <box id="message" width={width} flexDirection="column">
      <FormattedMessage
        content={content}
        palette={THEMES.obsidian}
        width={width}
      />
    </box>
  );
}
for (const width of [16, 37, 77]) {
  test(`long words and paths wrap without empty rows at ${width} columns`, async () => {
    const word = "a".repeat(width * 2);
    const setup = await testRender(view(`${word}\n${word}\n${word}`, width), {
      width,
      height: 20,
    });
    try {
      const rows = await frame(setup);
      expect(rows.every(Boolean)).toBe(true);
      expect(rows.join("")).toBe(word.repeat(3));
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
}
test("streamed text updates the same row instead of recreating it for every delta", async () => {
  let update!: (content: string) => void;
  function Harness() {
    const [content, setContent] = useState("Первая");
    update = setContent;
    return view(content, 40);
  }
  const setup = await testRender(<Harness />, { width: 40, height: 20 });
  try {
    await frame(setup);
    const findText = () => {
      const message = setup.renderer.root.findDescendantById("message");
      const descendants = (
        node: NonNullable<typeof message>,
      ): NonNullable<typeof message>[] => [
        node,
        ...node.getChildren().flatMap(descendants),
      ];
      return message
        ? descendants(message).find((node) => node instanceof TextRenderable)
        : undefined;
    };
    const row = findText();
    expect(row).toBeTruthy();
    await act(async () => {
      update("Первая строка");
    });
    expect(await frame(setup)).toEqual(["Первая строка"]);
    expect(findText()).toBe(row);
    await act(async () => {
      update("Первая строка\nВторая строка");
    });
    expect(await frame(setup)).toEqual(["Первая строка", "Вторая строка"]);
    expect(findText()).toBe(row);
  } finally {
    act(() => setup.renderer.destroy());
  }
});
test("intentional paragraph breaks and Windows line endings preserve their row count", async () => {
  const setup = await testRender(view("Первый абзац\r\n\r\nВторой абзац", 40), {
    width: 40,
    height: 20,
  });
  try {
    expect(await frame(setup)).toEqual(["Первый абзац", "", "Второй абзац"]);
  } finally {
    act(() => setup.renderer.destroy());
  }
});
for (const width of [40, 80, 120]) {
  test(`chat keeps streaming and completed answers contiguous at ${width} columns`, async () => {
    const workspace = new TuiWorkspace(process.cwd());
    const controller = workspace.newTab();
    controller.setBusy(true);
    controller.setRunningMode("build");
    let setup!: Setup;
    await act(async () => {
      setup = await testRender(
        <OpenTuiSpike
          workspace={workspace}
          initialMode="hide"
          onExit={() => {}}
          onSubmit={async () => {}}
        />,
        { width, height: 30 },
      );
    });
    const source = `${"abcdef".repeat(width / 2)}\r\n${"ghijkl".repeat(width / 2)}\r\nПоследняя строка`;
    try {
      const contiguous = (id: string) => {
        const rows = setup.captureCharFrame().split("\n");
        const message = setup.renderer.root.findDescendantById(id);
        if (!message) throw new Error(`Missing ${id}`);
        const body = rows.slice(message.y, message.y + message.height);
        expect(body.length).toBeGreaterThan(0);
        expect(body.every((row) => !!row.trim())).toBe(true);
        expect(setup.captureCharFrame()).not.toContain("Помощник");
        expect(setup.captureCharFrame()).not.toContain("Build | отвечает");
      };
      // Render once per delta, including splits inside Windows CRLF pairs.
      for (let i = 0; i < source.length; i += 7) {
        await act(async () => {
          controller.appendToLast(source.slice(i, i + 7));
        });
        await act(async () => {
          await setup.renderOnce();
        });
        contiguous("streaming-message");
      }
      expect(controller.snapshot.streaming).toBe(source);
      await act(async () => {
        controller.append("Готово", "success");
        controller.setBusy(false);
        controller.setRunningMode();
      });
      await act(async () => {
        await setup.renderOnce();
      });
      const id = `assistant-${controller.snapshot.transcript[0]?.id}`;
      contiguous(id);
      expect(controller.snapshot.transcript[0]?.text).toBe(source);
      await act(async () => {
        setup.resize(60, 30);
      });
      await act(async () => {
        await setup.renderOnce();
      });
      contiguous(id);
    } finally {
      act(() => setup.renderer.destroy());
      workspace.dispose();
    }
  });
}
