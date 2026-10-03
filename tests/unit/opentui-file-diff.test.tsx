/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import type { DiffRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { buildFileDiff } from "../../src/tools/file-diff.js";
import { THEMES } from "../../src/ui/appearance.js";
import { FileDiffCard } from "../../src/ui/opentui-file-diff.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import {
  TerminalScrollbox,
  UnicodeDecorationContext,
} from "../../src/ui/terminal-decoration.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(setup: Setup) {
  await act(async () => {
    await setup.flush({ maxPasses: 12 });
  });
}

for (const [name, palette] of Object.entries(THEMES)) {
  for (const width of [40, 120]) {
    test(`diff card fits ${width} columns in ${name}, with font-safe decoration`, async () => {
      const diff = buildFileDiff(
        "src/очень-длинная-папка/пример.ts",
        "const title = 'old';\n",
        "const title = 'new';\n",
      );
      const setup = await testRender(
        <FileDiffCard
          id="test-card"
          width={width}
          diff={diff}
          palette={palette}
          latest
          onToggle={() => {}}
        />,
        { width, height: 14 },
      );
      try {
        await frame(setup);
        const output = setup.captureCharFrame();
        expect(output).toContain("пример.ts");
        expect(output).toContain("+1");
        expect(output).toContain("-1");
        expect(output).toContain("old");
        expect(output).toContain("new");
        expect(output).toContain("Ctrl+D");
        expect(output).toContain("+---");
        expect(output).not.toContain("╭");
        expect(
          setup.renderer.root.findDescendantById("test-card-full"),
        ).toBeUndefined();
      } finally {
        act(() => setup.renderer.destroy());
      }
    });
  }
}

test("Unicode decoration uses the same layout with rounded borders", async () => {
  const diff = buildFileDiff("empty.txt", null, "");
  const setup = await testRender(
    <UnicodeDecorationContext value={true}>
      <FileDiffCard id="test-card" width={60} diff={diff} />
    </UnicodeDecorationContext>,
    { width: 60, height: 10 },
  );
  try {
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("╭");
    expect(setup.captureCharFrame()).toContain("Создан пустой файл");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("expanded diffs retain patches over 100k characters, wrap and scroll to the last line", async () => {
  const diff = buildFileDiff(
    "large.txt",
    null,
    `${Array.from({ length: 260 }, (_, i) => `${i} ${"x".repeat(420)}`).join("\n")}\nEND_OF_COMPLETE_DIFF\n`,
  );
  expect(diff.patch.length).toBeGreaterThan(100_000);
  const setup = await testRender(
    <TerminalScrollbox id="feed" height={20} width="100%">
      <FileDiffCard id="large" diff={diff} width={80} expanded />
    </TerminalScrollbox>,
    { width: 80, height: 20 },
  );
  try {
    await frame(setup);
    await frame(setup);
    const native = setup.renderer.root.findDescendantById(
      "large-full",
    ) as DiffRenderable;
    expect(native.diff).toBe(diff.patch);
    expect(native.view).toBe("unified");
    const feed = setup.renderer.root.findDescendantById(
      "feed",
    ) as ScrollBoxRenderable;
    expect(feed.scrollHeight).toBeGreaterThan(260);
    await act(async () => feed.scrollTo(Number.MAX_SAFE_INTEGER));
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("END_OF_COMPLETE_DIFF");
    await act(async () => setup.resize(130, 20));
    await frame(setup);
    await act(async () => feed.scrollTo(Number.MAX_SAFE_INTEGER));
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("END_OF_COMPLETE_DIFF");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("Ctrl+D toggles real chat diffs repeatedly without exiting or changing the draft", async () => {
  const controller = new TuiController(process.cwd());
  controller.append(
    "Изменён файл",
    "tool",
    buildFileDiff("test.txt", "old\n", "new\n"),
  );
  let exits = 0;
  const setup = await testRender(
    <OpenTuiSpike
      controller={controller}
      onExit={() => exits++}
      onSubmit={async () => {}}
    />,
    { width: 90, height: 30, exitOnCtrlC: false },
  );
  try {
    await frame(setup);
    // Version 0.6.11 interpreted Ctrl+D on an empty composer as app exit.
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
    await act(async () => setup.mockInput.pressKey("d", { ctrl: true }));
    await frame(setup);
    expect(exits).toBe(0);
    expect(
      setup.renderer.root.findDescendantById("file-diff-0-full"),
    ).toBeTruthy();
    await act(async () => setup.mockInput.pressKey("d", { ctrl: true }));
    await act(async () => setup.mockInput.pasteBracketedText("unsent draft"));
    await frame(setup);
    for (let index = 0; index < 6; index++) {
      await act(async () => setup.mockInput.pressKey("d", { ctrl: true }));
      await frame(setup);
      expect(
        Boolean(setup.renderer.root.findDescendantById("file-diff-0-full")),
      ).toBe(index % 2 === 0);
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
        "unsent draft",
      );
      expect(exits).toBe(0);
    }
    await act(async () => setup.mockInput.pressCtrlC());
    await frame(setup);
    expect(exits).toBe(0);
  } finally {
    act(() => {
      setup.renderer.destroy();
      controller.dispose();
    });
  }
});

test("full diff switches between split and unified after resize and keeps its final line after a theme change", async () => {
  const before = `${Array.from({ length: 120 }, (_, i) => `old ${i} ${"a".repeat(160)}`).join("\n")}\nOLD_FINAL_LINE\n`;
  const after = before
    .replaceAll("old", "new")
    .replace("OLD_FINAL_LINE", "NEW_FINAL_LINE");
  const diff = buildFileDiff("resizable.txt", before, after);
  let changeTheme!: () => void;
  function Fixture() {
    const { width } = useTerminalDimensions();
    const [palette, setPalette] = useState(THEMES.obsidian);
    changeTheme = () => setPalette(THEMES.paper);
    return (
      <TerminalScrollbox id="resizable-feed" height={20} width="100%">
        <FileDiffCard
          id="resizable"
          width={width - 1}
          diff={diff}
          palette={palette}
          expanded
        />
      </TerminalScrollbox>
    );
  }
  const setup = await testRender(<Fixture />, { width: 130, height: 20 });
  try {
    await frame(setup);
    const native = setup.renderer.root.findDescendantById(
      "resizable-full",
    ) as DiffRenderable;
    const feed = setup.renderer.root.findDescendantById(
      "resizable-feed",
    ) as ScrollBoxRenderable;
    expect(native.view).toBe("split");
    await act(async () => feed.scrollTo(Number.MAX_SAFE_INTEGER));
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("OLD_FINAL_LINE");
    expect(setup.captureCharFrame()).toContain("NEW_FINAL_LINE");
    await act(async () => {
      setup.resize(70, 20);
      changeTheme();
    });
    await frame(setup);
    expect(native.view).toBe("unified");
    await act(async () => feed.scrollTo(Number.MAX_SAFE_INTEGER));
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("NEW_FINAL_LINE");
    expect(diff.patch).toContain("-OLD_FINAL_LINE");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("click expands earlier cards independently and tab switching restores their expansion", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const first = workspace.newTab();
  const firstKey = workspace.activeKey;
  first.append(
    "first",
    "tool",
    buildFileDiff("first.txt", "old first\n", "new first\n"),
  );
  first.append(
    "second",
    "tool",
    buildFileDiff("second.txt", "old second\n", "new second\n"),
  );
  const setup = await testRender(
    <OpenTuiSpike workspace={workspace} onExit={() => {}} />,
    { width: 90, height: 40 },
  );
  try {
    await frame(setup);
    const header = setup.renderer.root.findDescendantById("file-diff-0-toggle");
    if (!header) throw new Error("Missing first file header");
    await act(async () => setup.mockMouse.click(header.x + 2, header.y));
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("file-diff-0-full"),
    ).toBeTruthy();
    expect(
      setup.renderer.root.findDescendantById("file-diff-1-full"),
    ).toBeUndefined();
    await act(async () => setup.mockInput.pressKey("d", { ctrl: true }));
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("file-diff-1-full"),
    ).toBeTruthy();
    act(() => workspace.newTab());
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("file-diff-0-full"),
    ).toBeUndefined();
    act(() => workspace.select(firstKey));
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("file-diff-0-full"),
    ).toBeTruthy();
    expect(
      setup.renderer.root.findDescendantById("file-diff-1-full"),
    ).toBeTruthy();
  } finally {
    act(() => {
      setup.renderer.destroy();
      workspace.dispose();
    });
  }
});
