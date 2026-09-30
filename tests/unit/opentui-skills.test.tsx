/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Skill } from "../../src/skills/skills.js";
import { THEMES } from "../../src/ui/appearance.js";
import {
  OpenTuiSkills,
  type OpenTuiSkillsActions,
} from "../../src/ui/opentui-skills.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { skillCommandDraft, skillEditDraft } from "../../src/ui/skill-draft.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

const review: Skill = {
  name: "code-review",
  description: "Проверить изменения кода и найти регрессии",
  instructions: "Проверьте изменения внимательно.\nСначала изучите diff.",
  source: "bundled",
  dir: process.cwd(),
};
const creator: Skill = {
  ...review,
  name: "skill-creator",
  description: "Создать или улучшить навык",
  disableModelInvocation: true,
};

function actions(skills: Skill[] = [review, creator]) {
  const active = new Set<string>();
  const api: OpenTuiSkillsActions = {
    load: () => skills,
    activeNames: () => [...active],
    toggle: (name) => {
      if (active.has(name)) active.delete(name);
      else active.add(name);
    },
  };
  return { active, api };
}
type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
  });
}
async function press(
  setup: Setup,
  key: string,
  modifiers?: { ctrl?: boolean },
) {
  await act(async () => {
    const input =
      {
        DOWN: "ARROW_DOWN",
        UP: "ARROW_UP",
        PAGEDOWN: "\u001b[6~",
        PAGEUP: "\u001b[5~",
      }[key] ?? key;
    setup.mockInput.pressKey(input, modifiers);
    if (key === "ESCAPE") await Bun.sleep(120);
  });
  await frame(setup);
}
async function open(setup: Setup) {
  await act(async () => {
    await setup.mockInput.typeText("/skills");
    setup.mockInput.pressEnter();
  });
  await frame(setup);
  expect(setup.captureCharFrame()).toContain("Библиотека");
}
function position(setup: Setup, text: string) {
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  if (y < 0)
    throw new Error(`Missing ${text} in frame:\n${setup.captureCharFrame()}`);
  return { x: (lines[y]?.indexOf(text) ?? 0) + 1, y };
}
function destroy(setup: Setup) {
  act(() => setup.renderer.destroy());
}

test("choosing a skill prepares one message, keeps the dialog behind it, and never pins or submits", async () => {
  const { api, active } = actions();
  const submitted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {}}
      onSubmit={async (input) => {
        submitted.push(input);
      }}
      skillsActions={api}
    />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    await open(setup);
    expect(setup.captureCharFrame()).toContain("Применить к задаче");
    expect(setup.captureCharFrame()).toContain("Автовыбор");
    expect(setup.captureCharFrame()).toContain("Enter отправить");
    await press(setup, "RETURN");
    expect(submitted).toEqual([]);
    expect(active.size).toBe(0);
    expect(setup.captureCharFrame()).not.toContain("Библиотека");
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
      "/code-review ",
    );
    await act(async () => {
      await setup.mockInput.typeText("проверь diff");
    });
    await press(setup, "RETURN");
    expect(submitted).toEqual(["/code-review проверь diff"]);
  } finally {
    destroy(setup);
  }
});

test("opening the library shortcut and choosing preserve an existing multiline task draft", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const { api, active } = actions();
  const submitted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      onExit={() => {}}
      onSubmit={async (input) => {
        submitted.push(input);
      }}
      skillsActions={api}
    />,
    { width: 120, height: 40 },
  );
  try {
    await frame(setup);
    await act(async () => {
      await setup.mockInput.pasteBracketedText("Проверь API\nи тесты");
    });
    await frame(setup);
    await press(setup, "s", { ctrl: true });
    await frame(setup);
    expect(workspace.home.snapshot.overlay).toBe("skills");
    await press(setup, "RETURN");
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
      "/code-review Проверь API\nи тесты",
    );
    expect(workspace.home.snapshot.draft).toBe(
      "/code-review Проверь API\nи тесты",
    );
    expect(workspace.home.snapshot.focus).toBe("composer");
    expect(active.size).toBe(0);
    expect(submitted).toEqual([]);
  } finally {
    destroy(setup);
    workspace.dispose();
  }
});

test("pinning is an explicit separate tab and Enter there does not choose a one-off skill", async () => {
  const { api, active } = actions();
  let chosen = 0;
  const setup = await testRender(
    <OpenTuiSkills
      actions={api}
      width={100}
      height={30}
      onClose={() => {}}
      onChoose={() => chosen++}
    />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    await press(setup, "TAB");
    expect(setup.captureCharFrame()).toContain("Для постоянных правил");
    await press(setup, "RETURN");
    expect(active.has("code-review")).toBe(true);
    expect(chosen).toBe(0);
    expect(setup.captureCharFrame()).toContain("● /code-review");
    await press(setup, "RETURN");
    expect(active.size).toBe(0);
  } finally {
    destroy(setup);
  }
});

test("native search supports pasted Cyrillic descriptions and typing never reaches the composer", async () => {
  const { api } = actions([
    review,
    {
      ...review,
      name: "api",
      description: "Контракты публичного сервиса",
      source: "user",
    },
  ]);
  const setup = await testRender(
    <OpenTuiSpike onExit={() => {}} skillsActions={api} />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    await open(setup);
    await act(async () => {
      await setup.mockInput.pasteBracketedText("публичного");
    });
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("/api");
    expect(setup.captureCharFrame()).not.toContain("/code-review");
    await press(setup, "ESCAPE");
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
  } finally {
    destroy(setup);
  }
});

test("agent-only skills can be inspected but cannot be invoked manually", async () => {
  const { api, active } = actions([{ ...review, userInvocable: false }]);
  let chosen = 0;
  const setup = await testRender(
    <OpenTuiSkills
      actions={api}
      width={100}
      height={30}
      onClose={() => {}}
      onChoose={() => chosen++}
    />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("Только агент");
    await press(setup, "RETURN");
    expect(chosen).toBe(0);
    expect(active.size).toBe(0);
    await press(setup, "o", { ctrl: true });
    expect(setup.captureCharFrame()).toContain(
      "Проверьте изменения внимательно",
    );
    await press(setup, "ESCAPE");
    expect(setup.captureCharFrame()).toContain("Только агент");
  } finally {
    destroy(setup);
  }
});

test("creation and editing prepare creator prompts without executing them", async () => {
  const memo = { ...review, name: "memo", source: "user" as const };
  const { api } = actions([memo, creator]);
  const original =
    "---\nname: memo\ndescription: Test\ndisable-model-invocation: true # keep this setting\n---\nOriginal instructions";
  api.editSource = () => original;
  const submitted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {}}
      onSubmit={async (input) => {
        submitted.push(input);
      }}
      skillsActions={api}
    />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    await open(setup);
    await press(setup, "e", { ctrl: true });
    const draft = setup.renderer.currentFocusedEditor?.plainText ?? "";
    expect(draft).toContain("/skill-creator");
    expect(draft).toContain(original);
    expect(submitted).toEqual([]);
    await act(async () => {
      setup.renderer.currentFocusedEditor?.setText("");
    });
    await open(setup);
    await press(setup, "n", { ctrl: true });
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
      "/skill-creator ",
    );
    expect(submitted).toEqual([]);
  } finally {
    destroy(setup);
  }
});

test("empty search and discovery errors keep the popup usable", async () => {
  const { api } = actions();
  let closed = 0;
  const setup = await testRender(
    <OpenTuiSkills
      actions={api}
      width={80}
      height={24}
      onClose={() => closed++}
      onChoose={() => {}}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    await act(async () => {
      await setup.mockInput.typeText("no-such-skill");
    });
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("Ничего не найдено");
    await press(setup, "DOWN");
    await press(setup, "RETURN");
    expect(closed).toBe(0);
    await press(setup, "ESCAPE");
    expect(closed).toBe(1);
  } finally {
    destroy(setup);
  }
  const failed = {
    ...api,
    load: () => {
      throw new Error("Skill discovery failed");
    },
  };
  const failure = await testRender(
    <OpenTuiSpike onExit={() => {}} skillsActions={failed} />,
    { width: 80, height: 24 },
  );
  try {
    await frame(failure);
    await open(failure);
    expect(failure.captureCharFrame()).toContain("Skill discovery failed");
    await press(failure, "ESCAPE");
    expect(failure.captureCharFrame()).toContain("Опишите задачу");
  } finally {
    destroy(failure);
  }
});

test("large libraries scroll by keyboard and outside clicks close without choosing", async () => {
  const { api } = actions(
    Array.from({ length: 80 }, (_, i) => ({
      ...review,
      name: `skill-${i.toString().padStart(2, "0")}`,
    })),
  );
  let closed = 0,
    chosen = 0;
  const setup = await testRender(
    <OpenTuiSkills
      actions={api}
      width={80}
      height={24}
      onClose={() => closed++}
      onChoose={() => chosen++}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    for (let i = 0; i < 3; i++) await press(setup, "PAGEDOWN");
    expect(setup.captureCharFrame()).toContain("/skill-15");
    const at = position(setup, "/skill-15");
    await act(async () => {
      await setup.mockMouse.click(at.x, at.y);
    });
    await frame(setup);
    expect(closed).toBe(0);
    expect(chosen).toBe(0);
    await act(async () => {
      await setup.mockMouse.scroll(at.x, at.y, "down");
    });
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("/skill-16");
    await act(async () => {
      await setup.mockMouse.click(0, 0);
    });
    expect(closed).toBe(1);
  } finally {
    destroy(setup);
  }
});

test("mouse selection and the primary button choose exactly once without pinning", async () => {
  const { api, active } = actions();
  const chosen: string[] = [];
  const setup = await testRender(
    <OpenTuiSkills
      actions={api}
      width={100}
      height={30}
      onClose={() => {}}
      onChoose={(skill) => chosen.push(skill.name)}
    />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    const row = position(setup, "/skill-creator");
    await act(async () => {
      await setup.mockMouse.click(row.x, row.y);
    });
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("Вручную");
    expect(chosen).toEqual([]);
    const button = position(setup, "Применить к задаче");
    await act(async () => {
      await setup.mockMouse.click(button.x, button.y);
    });
    expect(chosen).toEqual(["skill-creator"]);
    expect(active.size).toBe(0);
  } finally {
    destroy(setup);
  }
});

for (const [width, height] of [
  [40, 12],
  [60, 15],
  [80, 24],
  [120, 40],
]) {
  test(`popup at ${width}×${height} keeps selection, query and explicit action on resize`, async () => {
    const { api, active } = actions();
    let chosen = "";
    const setup = await testRender(
      <OpenTuiSpike onExit={() => {}} skillsActions={api} />,
      { width, height },
    );
    try {
      await frame(setup);
      await open(setup);
      expect(setup.captureCharFrame()).toContain("Применить к задаче");
      expect(setup.captureCharFrame()).toContain("↑↓ выбрать");
      await act(async () => {
        await setup.mockInput.typeText("skill-creator");
        setup.resize(100, 30);
      });
      await frame(setup);
      expect(setup.captureCharFrame()).toContain("Вручную");
      await press(setup, "RETURN");
      chosen = setup.renderer.currentFocusedEditor?.plainText ?? "";
      expect(chosen).toBe("/skill-creator ");
      expect(active.size).toBe(0);
    } finally {
      destroy(setup);
    }
  });
}

for (const [name, palette] of Object.entries(THEMES)) {
  test(`popup uses the ${name} palette with a visible selection and action`, async () => {
    const { api } = actions();
    const setup = await testRender(
      <OpenTuiSkills
        actions={api}
        width={100}
        height={30}
        palette={palette}
        onClose={() => {}}
        onChoose={() => {}}
      />,
      { width: 100, height: 30 },
    );
    try {
      await frame(setup);
      expect(setup.captureCharFrame()).toContain("/code-review");
      expect(setup.captureCharFrame()).toContain("Применить к задаче");
    } finally {
      destroy(setup);
    }
  });
}

test("switching workflows preserves the task and editing preserves the original YAML source", () => {
  expect(
    skillCommandDraft("skill-creator", "/code-review проверь\nAPI", [
      review,
      creator,
    ]),
  ).toBe("/skill-creator проверь\nAPI");
  expect(skillCommandDraft("code-review", "задача", [review])).toBe(
    "/code-review задача",
  );
  const source = "---\nmetadata:\n  author: me\n---\ntext";
  expect(skillEditDraft("memo", source, "сделай короче")).toContain(source);
  expect(skillEditDraft("memo", source, "сделай короче")).toContain(
    "сделай короче",
  );
});
