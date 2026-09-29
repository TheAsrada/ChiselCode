/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Skill } from "../../src/skills/skills.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";

test("skills panel opens details, toggles active instructions and restores the composer", async () => {
  const active = new Set<string>();
  const skill: Skill = {
    name: "review",
    description: "Проверить код",
    instructions: "Проверьте изменения внимательно.",
    source: "user",
    dir: process.cwd(),
  };
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {}}
      onSubmit={async () => {}}
      skillsActions={{
        load: () => [skill],
        activeNames: () => [...active],
        toggle: (name) => {
          if (active.has(name)) active.delete(name);
          else active.add(name);
        },
      }}
    />,
    { width: 60, height: 15 },
  );
  try {
    await setup.renderOnce();
    await act(async () => {
      await setup.mockInput.typeText("/skills");
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("/review");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Проверьте изменения");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(active.has("review")).toBe(true);
    await act(async () => {
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await act(async () => {
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Напишите сообщение");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});
