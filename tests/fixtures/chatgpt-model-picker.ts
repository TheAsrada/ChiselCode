import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

export async function verifyChatGptModelPicker(configPath: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ui = await createTestRenderer({
    width: 112,
    height: 30,
    exitOnCtrlC: false,
  });
  let application: ReturnType<typeof runOpenTuiAgent> | undefined;
  const frame = () => ui.captureCharFrame();
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, frame());
      await act(async () => {
        await Bun.sleep(5);
        await ui.renderOnce();
      });
    }
  };
  const submit = async (value: string) => {
    await act(async () => ui.mockInput.pasteBracketedText(value));
    await act(async () => ui.mockInput.pressEnter());
  };
  try {
    await act(async () => {
      application = runOpenTuiAgent(
        { launcher: true, configPath, externalExtensions: false },
        undefined,
        false,
        false,
        undefined,
        async () => ui.renderer,
      );
    });
    await wait(
      () =>
        !!ui.renderer.currentFocusedEditor && frame().includes("gpt-6.1-sol"),
    );
    await submit("/model");
    await wait(
      () => frame().includes("GPT-6 Luna") && frame().includes("GPT-6.1 Terra"),
    );
    assert.ok(frame().includes("ChatGPT | work"));
    assert.ok(frame().includes("/ 3"));
    assert.ok(!frame().includes("Invalid entry"));
    assert.ok(!frame().includes("hidden-entry"));

    const folder = process.env.CHISEL_CHATGPT_CAPTURES;
    if (folder) {
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "chatgpt-models-112x30.txt"), frame());
      const spans = ui.captureSpans();
      await writeFile(
        join(folder, "chatgpt-models-112x30.json"),
        JSON.stringify({
          ...spans,
          lines: spans.lines.map(({ spans: lineSpans }) => ({
            spans: lineSpans.map((span) => ({
              ...span,
              fg: span.fg.toInts(),
              bg: span.bg.toInts(),
            })),
          })),
        }),
      );
    }

    await wait(() => ui.renderer.currentFocusedEditor?.id === "models-search");
    await act(async () => ui.mockInput.pasteBracketedText("Luna"));
    await wait(
      () =>
        frame().includes("GPT-6 Luna") && !frame().includes("GPT-6.1 Terra"),
    );
    await act(async () => ui.mockInput.pressEnter());
    await wait(
      () =>
        !ui.renderer.root.findDescendantById("models-popup") &&
        frame().includes("gpt-6-luna"),
    );
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.ui.lastModelSelection, {
      provider: "chatgpt",
      profileId: "work",
      model: "gpt-6-luna",
    });
    assert.equal(saved.profiles.work.defaultModel, "gpt-6.1-sol");
    console.log(
      "ChatGPT OpenTUI: full profile catalog, search and persisted selection verified",
    );
  } finally {
    if (application) {
      await act(async () => {
        process.emit("SIGTERM");
        await application;
      });
    } else ui.renderer.destroy();
  }
}
