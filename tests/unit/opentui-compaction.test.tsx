/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect, useState } from "react";
import type { ContextCompactionRecord } from "../../src/context/types.js";
import { THEMES } from "../../src/ui/appearance.js";
import { ContextCompactionMessage } from "../../src/ui/opentui-compaction.js";
import { attachTranscriptScrollback } from "../../src/ui/opentui-scrollback.js";
import { OpenTuiTranscript } from "../../src/ui/opentui-transcript.js";
import { TuiController } from "../../src/ui/tui-controller.js";

const record: ContextCompactionRecord = {
  id: "compaction-one",
  afterMessage: 4,
  beforeTokens: 178_240,
  afterTokens: 24_830,
  estimated: true,
  durationMs: 2300,
  reason: "auto",
  source: "model",
  createdAt: new Date().toISOString(),
};
for (const [theme, palette] of Object.entries(THEMES)) {
  for (const width of [40, 80, 120]) {
    test(`compaction cards stay compact and readable in ${theme} at ${width} columns`, async () => {
      const controller = new TuiController(process.cwd());
      controller.beginCompaction(record.id);
      function Harness() {
        const [view, setView] = useState(controller.snapshot);
        useEffect(() => controller.subscribe(setView), []);
        return (
          <box id="feed" width="100%" flexDirection="column">
            <OpenTuiTranscript
              entries={view.transcript}
              contentWidth={width}
              palette={palette}
            />
            {view.compaction && (
              <ContextCompactionMessage
                text={"Сжимаю контекст...\nСохраняю задачу и результаты работы"}
                palette={palette}
              />
            )}
          </box>
        );
      }
      const setup = await testRender(<Harness />, { width, height: 20 });
      try {
        await act(async () => {
          await setup.renderOnce();
          await setup.renderOnce();
        });
        expect(setup.captureCharFrame()).toContain("Сжимаю контекст...");
        expect(setup.captureCharFrame()).not.toContain(
          "Контекст сжат автоматически",
        );
        act(() => controller.finishCompaction(record));
        await act(async () => {
          await setup.renderOnce();
          await setup.renderOnce();
        });
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Контекст сжат автоматически");
        expect(frame).not.toContain("Сжимаю контекст...");
        expect(frame.replace(/\s/g, "")).toContain("~178240->~24830токенов");
        expect(frame).not.toMatch(/[\ufffd\p{Cs}\u2500-\u259f]/u);
        const feed = setup.renderer.root.findDescendantById("feed");
        if (!feed) throw new Error("Missing compaction card");
        const rows = frame.split("\n").slice(feed.y, feed.y + feed.height);
        expect(rows.every((row) => row.trim().length > 0)).toBe(true);
        expect(rows.length).toBe(width === 40 ? 3 : 2);
      } finally {
        act(() => setup.renderer.destroy());
        controller.dispose();
      }
    });
  }
}

test("native scrollback commits a completed card once and never commits a pending or failed card", async () => {
  const controller = new TuiController(process.cwd());
  const setup = await testRender(null, {
    width: 80,
    height: 24,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    footerHeight: 12,
  });
  const detach = attachTranscriptScrollback(controller, setup.renderer);
  try {
    controller.beginCompaction("failed");
    controller.abortCompaction("failed");
    expect(setup.externalOutput.take()).toHaveLength(0);
    controller.beginCompaction(record.id);
    controller.finishCompaction(record);
    controller.finishCompaction(record);
    await setup.renderOnce();
    const commits = setup.externalOutput.take();
    expect(commits).toHaveLength(1);
    expect(commits[0]?.text).toContain("Контекст сжат автоматически");
    expect(commits[0]?.text).not.toContain("Сжимаю");
    expect(commits[0]?.text.replace(/\s/g, "")).toContain(
      "~178240->~24830токенов",
    );
  } finally {
    detach();
    act(() => setup.renderer.destroy());
    controller.dispose();
  }
});
