/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  OpenTuiSettings,
  type OpenTuiSettingsActions,
} from "../../src/ui/opentui-settings.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import type { TuiSettingsValues } from "../../src/ui/settings.js";

test("API key paste is masked, saved intact and never appears in the frame", async () => {
  const saved: TuiSettingsValues[] = [];
  const actions: OpenTuiSettingsActions = {
    load: async () => ({
      values: { provider: "anthropic", model: "claude-opus-5" },
      hasKey: false,
    }),
    hasKey: async () => false,
    save: async (values) => {
      saved.push(values);
      return "saved";
    },
    check: async () => "✓ Соединение работает",
    models: async () => ({ ok: true, models: [] }),
  };
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {}}
      onSubmit={async () => {}}
      settingsActions={actions}
    />,
    { width: 80, height: 24 },
  );
  try {
    await setup.renderOnce();
    await act(async () => {
      await setup.mockInput.typeText("/settings");
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Настройки ChiselCode");
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    await act(async () => {
      await setup.mockInput.pasteBracketedText("sk-очень-секретный-ключ");
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("••••");
    expect(setup.captureCharFrame()).not.toContain("sk-очень-секретный-ключ");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    for (let index = 0; index < 2; index++)
      await act(async () => {
        setup.mockInput.pressArrow("down");
      });
    await act(async () => {
      setup.mockInput.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(saved[0]?.apiKey).toBe("sk-очень-секретный-ключ");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("sk-очень-секретный-ключ");
    expect(setup.captureCharFrame()).toContain("Напишите сообщение");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("provider change discards the unsaved key from the previous provider", async () => {
  const saved: TuiSettingsValues[] = [];
  const actions: OpenTuiSettingsActions = {
    load: async () => ({
      values: { provider: "anthropic", model: "claude-opus-5" },
      hasKey: false,
    }),
    hasKey: async () => false,
    save: async (values) => {
      saved.push(values);
      return "saved";
    },
    check: async () => "ok",
    models: async () => ({ ok: true, models: [] }),
  };
  const setup = await testRender(
    <OpenTuiSettings
      actions={actions}
      width={80}
      height={24}
      onClose={() => {}}
    />,
    { width: 80, height: 24 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await act(async () => {
      await setup.mockInput.pasteBracketedText("private-key");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await act(async () => {
      setup.mockInput.pressArrow("up");
    });
    await act(async () => {
      setup.mockInput.pressArrow("up");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("private-key");
    expect(setup.captureCharFrame()).toContain("openai ·");
    expect(setup.captureCharFrame()).not.toContain("новый ключ введён");
    expect(saved).toEqual([]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("model list selects a discovered model and saves it", async () => {
  const saved: TuiSettingsValues[] = [];
  const actions: OpenTuiSettingsActions = {
    load: async () => ({
      values: { provider: "anthropic", model: "claude-opus-5" },
      hasKey: true,
    }),
    hasKey: async () => true,
    save: async (values) => {
      saved.push(values);
      return "saved";
    },
    check: async () => "ok",
    models: async () => ({
      ok: true,
      models: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }],
    }),
  };
  const setup = await testRender(
    <OpenTuiSettings
      actions={actions}
      width={80}
      height={24}
      initialSelection={1}
      onClose={() => {}}
    />,
    { width: 80, height: 24 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("claude-sonnet-5");
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    for (let index = 0; index < 3; index++)
      await act(async () => {
        setup.mockInput.pressArrow("down");
      });
    await act(async () => {
      setup.mockInput.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(saved[0]?.model).toBe("claude-sonnet-5");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("first-run settings require a saved key before showing the composer", async () => {
  let exited = 0;
  const saved: TuiSettingsValues[] = [];
  const actions: OpenTuiSettingsActions = {
    load: async () => ({
      values: { provider: "anthropic", model: "claude-opus-5" },
      hasKey: false,
    }),
    hasKey: async () => false,
    save: async (values) => {
      saved.push(values);
      return values.apiKey ? "saved" : "setup_required";
    },
    check: async () => "ok",
    models: async () => ({ ok: true, models: [] }),
  };
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {
        exited++;
      }}
      onSubmit={async () => {}}
      settingsActions={actions}
      initialSettingsOpen
    />,
    { width: 60, height: 15 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Настройки ChiselCode");
    expect(setup.captureCharFrame()).not.toContain("Напишите сообщение");
    await act(async () => {
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(exited).toBe(1);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
  expect(saved).toEqual([]);

  const configured = await testRender(
    <OpenTuiSpike
      onExit={() => {
        exited++;
      }}
      onSubmit={async () => {}}
      settingsActions={actions}
      initialSettingsOpen
    />,
    { width: 60, height: 15 },
  );
  try {
    await configured.renderOnce();
    await act(async () => {
      configured.mockInput.pressArrow("down");
    });
    await act(async () => {
      configured.mockInput.pressArrow("down");
    });
    await act(async () => {
      configured.mockInput.pressEnter();
    });
    await act(async () => {
      await configured.mockInput.pasteBracketedText("new-private-key");
    });
    await configured.renderOnce();
    expect(configured.captureCharFrame()).not.toContain("new-private-key");
    await act(async () => {
      configured.mockInput.pressEnter();
    });
    await act(async () => {
      configured.mockInput.pressArrow("down");
    });
    await act(async () => {
      configured.mockInput.pressArrow("down");
    });
    await act(async () => {
      configured.mockInput.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await configured.renderOnce();
    expect(saved[0]?.apiKey).toBe("new-private-key");
    expect(configured.captureCharFrame()).toContain("Напишите сообщение");
    expect(exited).toBe(1);
  } finally {
    act(() => {
      configured.renderer.destroy();
    });
  }
});
