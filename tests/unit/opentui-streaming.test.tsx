/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

test("long chat, streaming, tab switches and resizes keep a fixed number of resize listeners", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const controller = workspace.newTab();
  let setup!: Setup;
  await act(async () => {
    setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        initialMode="hide"
        onExit={() => {}}
        onSubmit={async () => {}}
      />,
      { width: 120, height: 40 },
    );
  });
  const render = () =>
    act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
  const capture = async (name: string) => {
    const directory = process.env.CHISEL_TEST_RESIZE_CAPTURES;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${name}.txt`), setup.captureCharFrame());
    const spans = setup.captureSpans();
    await writeFile(
      join(directory, `${name}.json`),
      JSON.stringify({
        ...spans,
        lines: spans.lines.map((line) => ({
          spans: line.spans.map((span) => ({
            ...span,
            fg: span.fg.toInts(),
            bg: span.bg.toInts(),
          })),
        })),
      }),
    );
  };
  try {
    await render();
    const listeners = setup.renderer.listenerCount("resize");
    const limit = setup.renderer.getMaxListeners();
    expect(listeners).toBeGreaterThan(0);
    expect(listeners).toBeLessThanOrEqual(limit);
    const table = "| Имя | Итог |\n| --- | --- |\n| Resize | Готово |";
    await act(async () => {
      for (let i = 0; i < 260; i++)
        controller.append(`Ответ ${i + 1}. История сохраняется.`, "assistant");
      controller.append(table, "assistant");
      controller.setBusy(true);
      controller.appendToLast("Продолжаю ответ без лишних подписок.");
    });
    await render();
    expect(setup.renderer.listenerCount("resize")).toBe(listeners);
    expect(setup.captureCharFrame()).toContain("Продолжаю ответ");
    await capture("long-chat");
    await act(async () => setup.resize(24, 40));
    await render();
    expect(setup.renderer.listenerCount("resize")).toBe(listeners);
    expect(setup.captureCharFrame()).toContain("Имя: Resize");
    expect(setup.captureCharFrame()).toContain("Итог: Готово");
    await capture("narrow-chat");
    await act(async () => setup.resize(120, 40));
    await render();
    expect(setup.renderer.listenerCount("resize")).toBe(listeners);
    expect(setup.captureCharFrame()).toContain("Resize");
    await act(async () => {
      controller.setBusy(false);
      workspace.newTab();
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => workspace.cycle(-1));
      await render();
      expect(setup.renderer.listenerCount("resize")).toBe(listeners);
      await act(async () => workspace.cycle(1));
      await render();
      expect(setup.renderer.listenerCount("resize")).toBe(listeners);
    }
    expect(setup.renderer.getMaxListeners()).toBe(limit);
  } finally {
    act(() => setup.renderer.destroy());
    workspace.dispose();
  }
  expect(setup.renderer.listenerCount("resize")).toBe(0);
});
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
test("Windows paragraph separators display compactly without modifying the content", async () => {
  const setup = await testRender(view("Первый абзац\r\n\r\nВторой абзац", 40), {
    width: 40,
    height: 20,
  });
  try {
    expect(await frame(setup)).toEqual(["Первый абзац", "Второй абзац"]);
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
