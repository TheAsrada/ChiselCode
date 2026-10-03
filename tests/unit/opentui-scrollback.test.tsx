/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { buildFileDiff } from "../../src/tools/file-diff.js";
import {
  attachTranscriptScrollback,
  scrollbackRows,
} from "../../src/ui/opentui-scrollback.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiController } from "../../src/ui/tui-controller.js";

test("split footer commits sanitized completed messages once", async () => {
  const controller = new TuiController(process.cwd());
  const setup = await testRender(
    <OpenTuiSpike onExit={() => {}} controller={controller} classic />,
    {
      width: 80,
      height: 24,
      screenMode: "split-footer",
      externalOutputMode: "capture-stdout",
      footerHeight: 12,
    },
  );
  const detach = attachTranscriptScrollback(controller, setup.renderer);
  try {
    act(() => controller.append("Привет\u001b[31m мир", "user"));
    await setup.renderOnce();
    const commits = setup.externalOutput.take();
    expect(commits).toHaveLength(1);
    expect(commits[0]?.text).toContain("Привет мир");
    expect(commits[0]?.text).not.toContain("[31m");
    expect(setup.captureCharFrame()).not.toContain("Привет мир");

    act(() => controller.appendToLast("поток"));
    expect(setup.externalOutput.take()).toHaveLength(0);
    act(() => controller.append("готово", "success"));
    await setup.renderOnce();
    expect(setup.externalOutput.takeText()).toContain("поток");
  } finally {
    detach();
    act(() => setup.renderer.destroy());
    controller.dispose();
  }
});

test("session switch resets scrollback and replays only the selected session", () => {
  const controller = new TuiController(process.cwd());
  let resets = 0;
  const committed: string[] = [];
  const renderer = {
    writeToScrollback: () => committed.push("commit"),
    resetSplitFooterForReplay: () => {
      resets++;
      committed.length = 0;
    },
  } as unknown as Pick<
    CliRenderer,
    "writeToScrollback" | "resetSplitFooterForReplay"
  >;
  const detach = attachTranscriptScrollback(controller, renderer);
  try {
    controller.append("первый", "user");
    controller.setDraft("черновик");
    expect(committed).toHaveLength(1);
    controller.switchSession({ id: "another", projectPath: process.cwd() });
    controller.append("второй", "assistant");
    expect(resets).toBe(1);
    expect(committed).toHaveLength(1);
  } finally {
    detach();
    controller.dispose();
  }
});

test("scrollback wraps wide Unicode and preserves line breaks", () => {
  expect(
    scrollbackRows({ id: 0, text: "абв\n🇷🇺x", tone: "assistant" }, 4),
  ).toEqual(["абв", "🇷🇺x"]);
  expect(
    scrollbackRows({ id: 0, text: "12345", tone: "assistant" }, 4),
  ).toEqual(["1234", "5"]);
});

test("classic history commits a bounded diff card including additions, removals and the full-view hint", async () => {
  const controller = new TuiController(process.cwd());
  const setup = await testRender(null, {
    width: 60,
    height: 24,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    footerHeight: 12,
  });
  const detach = attachTranscriptScrollback(controller, setup.renderer);
  try {
    act(() =>
      controller.append(
        "edit",
        "tool",
        buildFileDiff("src/test.txt", "old\n", "new\n"),
      ),
    );
    await act(async () => setup.flush());
    const text = setup.externalOutput.takeText();
    expect(text).toContain("src/test.txt");
    expect(text).toContain("old");
    expect(text).toContain("new");
    expect(text).toContain("Ctrl+D: полный дифф");
  } finally {
    detach();
    act(() => {
      setup.renderer.destroy();
      controller.dispose();
    });
  }
});

test("large session replay batches commits without losing entries", async () => {
  const controller = new TuiController(process.cwd());
  controller.replace(
    Array.from({ length: 130 }, (_, index) => ({ text: `entry ${index}` })),
  );
  const setup = await testRender(null, {
    width: 80,
    height: 24,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    footerHeight: 12,
  });
  const detach = attachTranscriptScrollback(controller, setup.renderer);
  try {
    await setup.renderOnce();
    const commits = setup.externalOutput.take();
    expect(commits).toHaveLength(3);
    expect(commits.map(({ text }) => text).join("\n")).toContain("entry 129");
    expect(commits[0]?.text).toContain("entry 63");
    expect(commits[1]?.text).toContain("entry 64");
  } finally {
    detach();
    act(() => setup.renderer.destroy());
    controller.dispose();
  }
});
