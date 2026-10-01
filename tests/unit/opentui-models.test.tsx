/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import type { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  type ModelSelection,
  OpenTuiModels,
  type OpenTuiModelsActions,
} from "../../src/ui/opentui-models.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import type { ModelListResult } from "../../src/ui/settings-values.js";
import { createTuiApprovalResolver } from "../../src/ui/tui-contract.js";
import { TuiController } from "../../src/ui/tui-controller.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
const current: ModelSelection = {
  provider: "openai",
  profileId: "work",
  model: "model-current",
};
function api(overrides: Partial<OpenTuiModelsActions> = {}) {
  const selected: ModelSelection[] = [];
  const actions: OpenTuiModelsActions = {
    load: async () => ({
      current,
      profiles: [
        {
          key: "work",
          label: "Работа",
          providerLabel: "OpenAI",
          selection: current,
        },
        {
          key: "personal",
          label: "Личный",
          providerLabel: "OpenAI",
          selection: {
            ...current,
            profileId: "personal",
            model: "model-personal",
          },
        },
      ],
    }),
    models: async () => ({
      ok: true,
      models: [
        { id: "model-current" },
        { id: "model-large", hint: "Reasoning Large", contextWindow: 200000 },
        { id: "model-small", hint: "Fast Small" },
      ],
    }),
    select: async (selection) => {
      selected.push(selection);
    },
    ...overrides,
  };
  return { actions, selected };
}
async function frame(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
  return setup.captureCharFrame();
}
async function key(setup: Setup, name: string, ctrl = false) {
  await act(async () => {
    setup.mockInput.pressKey(name, { ctrl });
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame(setup);
}
async function paste(setup: Setup, text: string) {
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
  });
  await frame(setup);
}
async function click(setup: Setup, id: string) {
  const node = setup.renderer.root.findDescendantById(id);
  if (!node) throw new Error(`Missing ${id}`);
  await act(async () => {
    await setup.mockMouse.click(node.x + 1, node.y);
  });
  await frame(setup);
}
function destroy(setup: Setup) {
  act(() => setup.renderer.destroy());
}
async function picker(
  actions: OpenTuiModelsActions,
  width = 100,
  height = 30,
  onClose = () => {},
) {
  let setup!: Setup;
  await act(async () => {
    setup = await testRender(
      <OpenTuiModels
        actions={actions}
        width={width}
        height={height}
        onClose={onClose}
        onSettings={() => {}}
      />,
      { width, height },
    );
  });
  await frame(setup);
  return setup;
}

for (const [width, height] of [
  [40, 12],
  [80, 24],
  [120, 36],
]) {
  test(`model picker fits ${width}x${height} and chooses a searched model immediately`, async () => {
    const { actions, selected } = api();
    let closed = 0;
    const setup = await picker(actions, width, height, () => closed++);
    try {
      expect(setup.captureCharFrame()).toContain("Выбор модели");
      expect(setup.captureCharFrame()).toContain("+ model-current");
      expect(setup.captureCharFrame()).not.toMatch(/[⚙↻⚠↵\ufffd]/u);
      if (width === 40) expect(setup.captureCharFrame()).toContain("API");
      for (const id of [
        "models-search",
        "models-row-0",
        "models-select",
        "models-settings",
      ]) {
        const node = setup.renderer.root.findDescendantById(id);
        expect(node).toBeTruthy();
        expect(node?.y).toBeGreaterThanOrEqual(0);
        expect((node?.y ?? 0) + (node?.height ?? 0)).toBeLessThanOrEqual(
          height,
        );
      }
      await paste(setup, "reasoning");
      expect(setup.captureCharFrame()).toContain("Reasoning Large");
      await key(setup, "RETURN");
      expect(selected).toEqual([{ ...current, model: "model-large" }]);
      expect(closed).toBe(1);
    } finally {
      destroy(setup);
    }
  });
}
test("profile switch is a draft until a model is chosen and isolates same-provider accounts", async () => {
  const { actions, selected } = api();
  const setup = await picker(actions);
  try {
    await key(setup, "TAB");
    await paste(setup, "личный");
    await key(setup, "RETURN");
    expect(selected).toEqual([]);
    expect(setup.captureCharFrame()).toContain("Личный");
    await paste(setup, "model-small");
    await click(setup, "models-row-0");
    expect(selected).toEqual([
      { ...current, profileId: "personal", model: "model-small" },
    ]);
  } finally {
    destroy(setup);
  }
});
test("bracketed paste followed immediately by Enter uses the native search value", async () => {
  const { actions, selected } = api();
  const setup = await picker(actions);
  try {
    await act(async () => {
      await setup.mockInput.pasteBracketedText("model-small");
      setup.mockInput.pressEnter();
    });
    await frame(setup);
    expect(selected[0]?.model).toBe("model-small");
  } finally {
    destroy(setup);
  }
});
test("Enter immediately after a search with no matches cannot choose the old highlight", async () => {
  const { actions, selected } = api();
  const setup = await picker(actions);
  try {
    await act(async () => {
      await setup.mockInput.pasteBracketedText("no-such-model");
      setup.mockInput.pressEnter();
    });
    await frame(setup);
    expect(selected).toEqual([]);
    expect(setup.captureCharFrame()).toContain("Ничего не найдено");
  } finally {
    destroy(setup);
  }
});
test("mouse wheel and page keys navigate the complete list", async () => {
  const { actions, selected } = api();
  const setup = await picker(actions, 40, 12);
  try {
    const node = setup.renderer.root.findDescendantById("models-row-0");
    if (!node) throw new Error("Missing model row");
    await act(async () => setup.mockMouse.scroll(node.x + 1, node.y, "down"));
    await frame(setup);
    await key(setup, "\u001b[6~");
    await key(setup, "RETURN");
    expect(selected[0]?.model).toBe("model-small");
  } finally {
    destroy(setup);
  }
});
test("closing a picker ignores a pending profile load and catalog", async () => {
  let load!: (value: Awaited<ReturnType<OpenTuiModelsActions["load"]>>) => void;
  const { actions, selected } = api({
    load: () =>
      new Promise((done) => {
        load = done;
      }),
  });
  const setup = await picker(actions);
  destroy(setup);
  await act(async () => {
    load(await api().actions.load());
  });
  expect(selected).toEqual([]);
  let resolve!: (value: ModelListResult) => void;
  const pending = await picker(
    api({
      models: () =>
        new Promise((done) => {
          resolve = done;
        }),
    }).actions,
  );
  destroy(pending);
  await act(async () => resolve({ ok: true, models: [{ id: "late-model" }] }));
});
test("slow or failed catalog leaves manual ID usable and ignores late responses after close", async () => {
  let resolve!: (value: ModelListResult) => void;
  const { actions, selected } = api({
    models: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const setup = await picker(actions);
  let closed = 0;
  try {
    await paste(setup, "custom/new-model");
    await key(setup, "n", true);
    expect(
      (
        setup.renderer.root.findDescendantById(
          "models-manual",
        ) as InputRenderable
      ).value,
    ).toBe("custom/new-model");
    await key(setup, "RETURN");
    expect(selected[0]?.model).toBe("custom/new-model");
    await act(async () => {
      resolve({ ok: false, error: "catalog unavailable" });
    });
  } finally {
    destroy(setup);
  }
  const failed = await picker(
    api({ models: async () => ({ ok: false, error: "catalog unavailable" }) })
      .actions,
    80,
    24,
    () => closed++,
  );
  try {
    expect(failed.captureCharFrame()).toContain("catalog unavailable");
    await key(failed, "ESCAPE");
    expect(closed).toBe(1);
  } finally {
    destroy(failed);
  }
});
test("late catalog preserves highlight and stale profile responses cannot replace the new list", async () => {
  const pending: Array<(value: ModelListResult) => void> = [];
  const { actions, selected } = api({
    models: () => new Promise((done) => pending.push(done)),
  });
  const setup = await picker(actions);
  try {
    await key(setup, "TAB");
    await key(setup, "ARROW_DOWN");
    await key(setup, "RETURN");
    await act(async () => {
      pending[1]?.({
        ok: true,
        models: [{ id: "model-personal" }, { id: "aaa" }, { id: "zzz" }],
      });
    });
    await frame(setup);
    await key(setup, "ARROW_DOWN");
    await act(async () => {
      pending[0]?.({ ok: true, models: [{ id: "stale-work-model" }] });
    });
    await frame(setup);
    expect(setup.captureCharFrame()).not.toContain("stale-work-model");
    await key(setup, "RETURN");
    expect(selected[0]?.profileId).toBe("personal");
    expect(selected[0]?.model).toBe("zzz");
  } finally {
    destroy(setup);
  }
});
test("refresh preserves selection by ID when a catalog arrives in a different order", async () => {
  let resolve!: (value: ModelListResult) => void;
  let requests = 0;
  const { actions, selected } = api({
    models: async () =>
      ++requests === 1
        ? { ok: true, models: [{ id: "a" }, { id: "b" }] }
        : new Promise((done) => {
            resolve = done;
          }),
  });
  const setup = await picker(actions);
  try {
    await key(setup, "ARROW_DOWN");
    await key(setup, "r", true);
    await act(async () => {
      resolve({ ok: true, models: [{ id: "b" }, { id: "0" }, { id: "a" }] });
    });
    await frame(setup);
    await key(setup, "RETURN");
    expect(selected[0]?.model).toBe("a");
  } finally {
    destroy(setup);
  }
});
test("search reaches all 1000 models while rendering a bounded window", async () => {
  const { actions, selected } = api({
    models: async () => ({
      ok: true,
      models: Array.from({ length: 1000 }, (_, i) => ({
        id: `remote-${i.toString().padStart(4, "0")}`,
      })),
    }),
  });
  const setup = await picker(actions);
  try {
    expect(setup.captureCharFrame()).toContain("1001");
    expect(setup.renderer.root.findDescendantById("models-row-8")).toBeFalsy();
    await paste(setup, "0999");
    await key(setup, "RETURN");
    expect(selected[0]?.model).toBe("remote-0999");
  } finally {
    destroy(setup);
  }
});
test("failed selection keeps the picker open; repeated Enter does not apply twice", async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  let closed = 0;
  const setup = await picker(
    api({
      select: () => {
        calls++;
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
    }).actions,
    100,
    30,
    () => closed++,
  );
  try {
    await key(setup, "RETURN");
    await key(setup, "RETURN");
    await key(setup, "ESCAPE");
    expect(calls).toBe(1);
    expect(closed).toBe(0);
    await act(async () => {
      reject(new Error("disk unavailable"));
    });
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("disk unavailable");
    await key(setup, "ESCAPE");
    expect(closed).toBe(1);
  } finally {
    destroy(setup);
  }
});
test("/model opens directly, preserves composer and modes, and yields to approval", async () => {
  const { actions } = api();
  const controller = new TuiController(process.cwd());
  const approval = createTuiApprovalResolver();
  const setup = await testRender(
    <OpenTuiSpike
      controller={controller}
      getModelsActions={() => actions}
      approvalResolver={approval}
      onSubmit={async () => {}}
      onExit={() => {}}
    />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    await paste(setup, "/model");
    await key(setup, "RETURN");
    expect(controller.snapshot.overlay).toBe("models");
    await act(async () => setup.resize(40, 12));
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("models-select")?.y,
    ).toBeLessThan(12);
    await act(async () => setup.resize(100, 30));
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("models-search"),
    ).toBeTruthy();
    expect(
      setup.renderer.root.findDescendantById("settings-popup"),
    ).toBeFalsy();
    await key(setup, "F4");
    await act(async () => setup.mockInput.pressTab({ shift: true }));
    await frame(setup);
    expect(controller.snapshot.approvalMode).toBe("default");
    expect(controller.snapshot.agentMode).toBe("build");
    let decision: Promise<unknown> | undefined;
    await act(async () => {
      decision = approval.requestApproval({
        tool: "run_shell",
        preview: "git status",
      });
    });
    await frame(setup);
    expect(setup.renderer.root.findDescendantById("models-popup")).toBeFalsy();
    await key(setup, "n");
    expect(await decision).toBe("denied");
    await frame(setup);
    expect(setup.renderer.root.findDescendantById("models-popup")).toBeTruthy();
    await key(setup, "ESCAPE");
    await paste(setup, "unfinished draft");
    const editor = setup.renderer.currentFocusedEditor;
    expect(editor).toBeTruthy();
    if (!editor) throw new Error("Missing composer");
    editor.cursorOffset = 4;
    await click(setup, "prompt-model");
    expect(controller.snapshot.overlay).toBe("models");
    await key(setup, "ESCAPE");
    expect(setup.renderer.currentFocusedEditor).toBe(editor);
    expect(controller.snapshot.draft).toBe("unfinished draft");
    expect(editor.cursorOffset).toBe(4);
  } finally {
    act(() => approval.dispose());
    destroy(setup);
    controller.dispose();
  }
});
