/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import type { DirectoryPage } from "../../src/projects/navigation.js";
import { THEMES } from "../../src/ui/appearance.js";
import {
  OpenTuiProjects,
  type OpenTuiProjectsActions,
} from "../../src/ui/opentui-projects.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";
import { menuAction, uiKey } from "../fixtures/menu-navigation.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function render(
  element: ReactNode,
  options: { width: number; height: number },
) {
  let setup!: Setup;
  await act(async () => {
    setup = await testRender(element, options);
  });
  return setup;
}
const base =
  process.platform === "win32" ? "C:\\Projects" : "/home/demo/projects";
const page = (names: string[], filter = ""): DirectoryPage => ({
  path: base,
  parent: process.platform === "win32" ? "C:\\" : "/home/demo",
  directories: names.map((name) => join(base, name)),
  more: false,
  offset: names.length,
  filter,
});
function api(overrides: Partial<OpenTuiProjectsActions> = {}) {
  const browsed: string[] = [],
    opened: string[] = [];
  const actions: OpenTuiProjectsActions = {
    base,
    browse: async (value) => {
      browsed.push(value);
      return page(["apps", "docs", "packages", "Проект с пробелами"]);
    },
    open: async (value) => {
      opened.push(value);
    },
    cancel: () => {},
    ...overrides,
  };
  return { actions, browsed, opened };
}
async function wait(setup: Setup, ready: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(setup.captureCharFrame());
    await act(async () => {
      await Bun.sleep(5);
      await setup.renderOnce();
    });
  }
  await act(async () => {
    await setup.renderOnce();
  });
}
async function edit(setup: Setup, value: string) {
  await act(async () => {
    setup.mockInput.pressKey("a", { ctrl: true });
    setup.mockInput.pressKey("k", { ctrl: true });
    await setup.mockInput.pasteBracketedText(value);
  });
  await act(async () => {
    await setup.renderOnce();
  });
}
async function click(setup: Setup, id: string) {
  const node = setup.renderer.root.findDescendantById(id);
  if (!node) throw new Error(`Missing ${id}`);
  await act(async () => {
    await setup.mockMouse.click(node.x + 1, node.y);
    await setup.renderOnce();
  });
}
async function capture(setup: Setup, name: string) {
  const directory = process.env.CHISEL_PROJECT_CAPTURES;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const spans = setup.captureSpans();
  await writeFile(join(directory, `${name}.txt`), setup.captureCharFrame());
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
}

for (const theme of ["paper", "obsidian"] as const) {
  for (const [width, height] of [
    [120, 40],
    [80, 24],
    [60, 15],
    [32, 10],
  ]) {
    test(`folder picker has separate actions and fits ${theme} ${width}x${height}`, async () => {
      const { actions, opened } = api();
      let closed = 0;
      const setup = await render(
        <OpenTuiProjects
          actions={actions}
          width={width}
          height={height}
          palette={THEMES[theme]}
          onClose={() => closed++}
        />,
        { width, height },
      );
      try {
        await wait(setup, () => setup.captureCharFrame().includes("apps/"));
        expect(setup.captureCharFrame()).not.toContain("Недавний");
        expect(setup.captureCharFrame()).not.toContain("Полный путь");
        for (const id of [
          "project-path",
          "project-actions",
          "project-open-status",
          "project-directories",
        ]) {
          const node = setup.renderer.root.findDescendantById(id)!;
          expect(node.x).toBeGreaterThanOrEqual(0);
          expect(node.x + node.width).toBeLessThanOrEqual(width);
          expect(node.y).toBeGreaterThanOrEqual(0);
          expect(node.y + node.height).toBeLessThanOrEqual(height);
        }
        await uiKey(setup, "TAB");
        await uiKey(setup, "ARROW_DOWN");
        await uiKey(setup, "ARROW_DOWN");
        expect(setup.captureCharFrame()).toContain("> apps/");
        await capture(setup, `${theme}-${width}x${height}`);
        await menuAction(setup, "project-actions", "project-open");
        expect(opened).toEqual([base]);
        expect(closed).toBe(1);
      } finally {
        act(() => setup.renderer.destroy());
      }
    });
  }
}

test("path editing debounces I/O, shows completions without Enter and ignores stale responses", async () => {
  const requests: Array<{
    input: string;
    signal: AbortSignal;
    resolve(page: DirectoryPage): void;
  }> = [];
  const { actions, opened } = api({
    browse: (input, signal) =>
      new Promise((resolve) => requests.push({ input, signal, resolve })),
  });
  const setup = await render(
    <OpenTuiProjects
      actions={actions}
      width={80}
      height={24}
      palette={THEMES.paper}
      onClose={() => {}}
    />,
    { width: 80, height: 24 },
  );
  try {
    await wait(setup, () => requests.length === 1);
    await act(async () => requests[0]!.resolve(page(["old"])));
    await wait(setup, () => setup.captureCharFrame().includes("old/"));
    await edit(setup, join(base, "a"));
    await edit(setup, join(base, "ap"));
    expect(setup.captureCharFrame()).not.toContain("old/");
    await wait(setup, () => requests.length === 2);
    expect(requests[1]!.input).toBe(join(base, "ap"));
    await edit(setup, join(base, "doc"));
    expect(requests[1]!.signal.aborted).toBe(true);
    await wait(setup, () => requests.length === 3);
    await act(async () => requests[2]!.resolve(page(["docs"], "doc")));
    await wait(setup, () => setup.captureCharFrame().includes("docs/"));
    await act(async () => requests[1]!.resolve(page(["apps"], "ap")));
    await act(async () => {
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).not.toContain("apps/");
    expect(
      (
        setup.renderer.root.findDescendantById(
          "project-path",
        ) as InputRenderable
      ).value,
    ).toBe(join(base, "doc"));
    await capture(setup, "paper-filter-80x24");
    await click(setup, "project-open");
    expect(opened).toEqual([]);
    await click(setup, `project-row-directory-${join(base, "docs")}`);
    await wait(setup, () => requests.length === 4);
    expect(requests[3]!.input).toBe(join(base, "docs"));
    await act(async () => setup.mockInput.pressEscape());
    await act(async () => requests[3]!.resolve(page(["too-late"])));
    expect(opened).toEqual([]);
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("cached completions are visible immediately but cannot navigate before the new path is checked", async () => {
  const inputs: string[] = [];
  let resolve!: (page: DirectoryPage) => void;
  const { actions, opened } = api({
    cached: (input) =>
      input === base ? undefined : page(["cached-match"], "cached"),
    browse: async (input) => {
      inputs.push(input);
      if (input === base) return page(["initial"]);
      return new Promise<DirectoryPage>((done) => {
        resolve = done;
      });
    },
  });
  const setup = await render(
    <OpenTuiProjects
      actions={actions}
      width={80}
      height={24}
      palette={THEMES.paper}
      onClose={() => {}}
    />,
    { width: 80, height: 24 },
  );
  try {
    await wait(setup, () => setup.captureCharFrame().includes("initial/"));
    await edit(setup, join(base, "cached"));
    expect(setup.captureCharFrame()).toContain("cached-match/");
    await uiKey(setup, "TAB");
    await uiKey(setup, "RETURN");
    await wait(setup, () => inputs.length === 2);
    expect(inputs).toEqual([base, join(base, "cached")]);
    await click(setup, "project-open");
    expect(opened).toEqual([]);
    await act(async () => resolve(page([], "cached")));
    await wait(setup, () =>
      setup.captureCharFrame().includes("Папки не найдены"),
    );
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("sparse matches continue automatically and opening is single-flight while Esc cancels", async () => {
  let continued = 0,
    opened = 0,
    cancelled = 0;
  let finish!: () => void;
  const { actions } = api({
    browse: async (_input, _signal, offset) =>
      offset
        ? (continued++, page(["last-match"], "last"))
        : { ...page([], "last"), more: true, offset: 256 },
    open: () => {
      opened++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    cancel: () => {
      cancelled++;
    },
  });
  const setup = await render(
    <OpenTuiProjects
      actions={actions}
      width={80}
      height={24}
      palette={THEMES.paper}
      onClose={() => {}}
    />,
    { width: 80, height: 24 },
  );
  try {
    await wait(setup, () => setup.captureCharFrame().includes("last-match/"));
    expect(continued).toBe(1);
    actions.browse = async () => page([]);
    await edit(setup, join(base, "last-match"));
    await wait(setup, () => setup.captureCharFrame().includes("нет подпапок"));
    await click(setup, "project-open");
    await click(setup, "project-open");
    expect(opened).toBe(1);
    await act(async () => setup.mockInput.pressEscape());
    await wait(setup, () => cancelled > 0);
    expect(cancelled).toBeGreaterThan(0);
    await act(async () => finish());
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("/cwd is consumed but the footer preserves a genuine composer draft", async () => {
  const workspace = new TuiWorkspace();
  const { actions } = api();
  const setup = await render(
    <OpenTuiSpike
      workspace={workspace}
      onExit={() => {}}
      onSubmit={async () => {}}
      getDefaultModel={() => "fixture"}
      getProjectActions={() => actions}
    />,
    { width: 80, height: 24 },
  );
  try {
    await wait(setup, () => !!setup.renderer.currentFocusedEditor);
    await act(async () => {
      await setup.mockInput.pasteBracketedText("/cwd");
      setup.mockInput.pressEnter();
    });
    await wait(
      setup,
      () => !!setup.renderer.root.findDescendantById("projects-popup"),
    );
    expect(workspace.home.snapshot.draft).toBe("");
    await act(async () => setup.mockInput.pressEscape());
    await wait(
      setup,
      () =>
        !setup.renderer.root.findDescendantById("projects-popup") &&
        !!setup.renderer.currentFocusedEditor,
    );
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
    await act(async () => {
      await setup.mockInput.pasteBracketedText("Настоящий черновик");
    });
    await click(setup, "home-open-project");
    expect(workspace.home.snapshot.draft).toBe("Настоящий черновик");
    await act(async () => setup.mockInput.pressEscape());
    await wait(
      setup,
      () =>
        !setup.renderer.root.findDescendantById("projects-popup") &&
        !!setup.renderer.currentFocusedEditor,
    );
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
      "Настоящий черновик",
    );
  } finally {
    act(() => setup.renderer.destroy());
    await workspace.dispose();
  }
});
