import type { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { terminalSlice } from "../../src/ui/terminal-text.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
export async function uiKey(setup: Setup, name: string, shift = false) {
  await act(async () => {
    setup.mockInput.pressKey(
      (
        { PAGEDOWN: "\u001b[6~", PAGEUP: "\u001b[5~", space: " " } as Record<
          string,
          string
        >
      )[name] ?? name,
      { shift },
    );
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
}
function focused(setup: Setup, id: string) {
  const node = setup.renderer.root.findDescendantById(id);
  const row = setup.captureCharFrame().split("\n")[node?.y ?? -1] ?? "";
  return !!node && terminalSlice(row, node.x, node.width).includes("›");
}
/** Operate the visible native UI, including its collapsed action row. */
export async function focusMenuAction(
  setup: Setup,
  rail: string,
  target: string,
) {
  for (let i = 0; i < 16; ++i) {
    const node = setup.renderer.root.findDescendantById(rail);
    const rows = setup
      .captureCharFrame()
      .split("\n")
      .slice(node?.y ?? -1, (node?.y ?? -1) + (node?.height ?? 0));
    if (rows.some((row) => row.includes("›"))) break;
    await uiKey(setup, "TAB");
  }
  for (let i = 0; i < 32; ++i) {
    if (focused(setup, target)) return;
    await uiKey(setup, "ARROW_RIGHT");
  }
  throw new Error(
    `Недоступное действие ${target}\n${setup.captureCharFrame()}`,
  );
}
export async function menuAction(setup: Setup, rail: string, target: string) {
  await focusMenuAction(setup, rail, target);
  await uiKey(setup, "RETURN");
}
export async function modelProfiles(setup: Setup) {
  await uiKey(setup, "TAB", true);
  await uiKey(setup, "ARROW_RIGHT");
  await uiKey(setup, "TAB");
}

export async function settingsRoute(setup: Setup, query: string) {
  await act(async () => setup.mockInput.pressKey("f", { ctrl: true }));
  await act(async () => {
    await setup.renderOnce();
  });
  await act(async () => {
    setup.mockInput.pressKey("a", { ctrl: true });
    setup.mockInput.pressKey("k", { ctrl: true });
    await setup.mockInput.pasteBracketedText(query);
  });
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
  await uiKey(setup, "RETURN");
}

export async function sidebarTab(
  setup: Setup,
  tab: "menu" | "context" | "agents",
) {
  const marked = (id: string) => {
    const node = setup.renderer.root.findDescendantById(`sidebar-tab-${id}`);
    const line = setup.captureCharFrame().split("\n")[node?.y ?? -1] ?? "";
    return !!node && terminalSlice(line, node.x, node.width).includes(">");
  };
  for (let i = 0; i < 16 && !["menu", "context", "agents"].some(marked); i++)
    await uiKey(setup, "TAB");
  for (let i = 0; i < 3 && !marked(tab); i++) await uiKey(setup, "ARROW_RIGHT");
  if (!marked(tab))
    throw new Error(`Недоступный раздел ${tab}\n${setup.captureCharFrame()}`);
  await uiKey(setup, "TAB");
}
