/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import { loadGlobalConfig, saveGlobalConfig } from "../src/config/load.js";
import type { GlobalConfig } from "../src/types/domain.js";
import { attachTranscriptScrollback } from "../src/ui/opentui-scrollback.js";
import { OpenTuiSpike } from "../src/ui/opentui-spike.js";
import { TuiController } from "../src/ui/tui-controller.js";

if (process.argv.includes("--version")) {
  process.stdout.write("ChiselCode OpenTUI probe 0.5.12\n");
} else if (process.argv.includes("--smoke")) {
  const { testRender } = await import("@opentui/react/test-utils");
  const { act } = await import("react");
  const setup = await testRender(React.createElement(OpenTuiSpike, { onExit: () => {} }), { width: 80, height: 24 });
  try {
    await setup.renderOnce();
    if (!setup.captureCharFrame().includes("ChiselCode")) throw new Error("OpenTUI native frame is empty");
    await act(async () => { setup.resize(120, 30); });
    await setup.renderOnce();
    if (!setup.captureCharFrame().includes("Контекст")) throw new Error("OpenTUI resize failed");
  } finally {
    act(() => { setup.renderer.destroy(); });
  }
  const classicController = new TuiController(process.cwd());
  const classicSetup = await testRender(
    React.createElement(OpenTuiSpike, { onExit: () => {}, controller: classicController, classic: true }),
    { width: 80, height: 24, screenMode: "split-footer", externalOutputMode: "capture-stdout", footerHeight: 12 },
  );
  const detach = attachTranscriptScrollback(classicController, classicSetup.renderer);
  try {
    act(() => classicController.append("Native scrollback ✓", "assistant"));
    await classicSetup.renderOnce();
    if (!classicSetup.externalOutput.takeText().includes("Native scrollback ✓"))
      throw new Error("OpenTUI split-footer scrollback failed");
    if (classicSetup.captureCharFrame().includes("Native scrollback ✓"))
      throw new Error("OpenTUI split-footer duplicated transcript in footer");
    process.stdout.write("OpenTUI native smoke: OK\n");
  } finally {
    detach();
    act(() => classicSetup.renderer.destroy());
    classicController.dispose();
  }
  const largeController = new TuiController(process.cwd());
  largeController.replace(
    Array.from({ length: 10_000 }, (_, index) => ({ text: `line ${index}` })),
  );
  const largeSetup = await testRender(null, {
    width: 80,
    height: 24,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    footerHeight: 12,
  });
  const startedAt = performance.now();
  const detachLarge = attachTranscriptScrollback(largeController, largeSetup.renderer);
  try {
    await largeSetup.renderOnce();
    const commits = largeSetup.externalOutput.take();
    if (commits.length !== 157 || !commits.at(-1)?.text.includes("line 9999"))
      throw new Error(`OpenTUI large scrollback replay lost entries: ${commits.length} commits`);
    process.stdout.write(
      `OpenTUI 10,000-entry native scrollback replay: ${Math.round(performance.now() - startedAt)} ms (${commits.length} commits)\n`,
    );
  } finally {
    detachLarge();
    act(() => largeSetup.renderer.destroy());
    largeController.dispose();
  }
} else {
  const controller = new TuiController(process.cwd());
  controller.refreshGitChanges();
  const config: GlobalConfig = await loadGlobalConfig().catch(() => ({ providers: {} }));
  const classic = process.env.CHISEL_ALT_SCREEN === "0" || process.env.CHISEL_NO_ALT_SCREEN === "1";
  const renderer = await createCliRenderer({
    screenMode: classic ? "split-footer" : "alternate-screen",
    footerHeight: 12,
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const root = createRoot(renderer);
  const detachScrollback = classic ? attachTranscriptScrollback(controller, renderer) : undefined;
  let pendingSave: Promise<void> = Promise.resolve();
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const shutdown = () => finish?.();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    root.render(React.createElement(OpenTuiSpike, {
      onExit: shutdown,
      controller,
      classic,
      initialMode: config.ui?.sidebarMode ?? "auto",
      initialUnicodeDecorations: config.ui?.unicodeDecorations === true,
      onUnicodeDecorationsChange: async (unicodeDecorations) => {
        const saved = pendingSave.then(async () => {
          const current = await loadGlobalConfig();
          await saveGlobalConfig({ ...current, ui: { ...current.ui, unicodeDecorations } });
        });
        pendingSave = saved.catch(() => {});
        return saved;
      },
      onModeChange: (mode) => {
        pendingSave = pendingSave.then(async () => {
          const current = await loadGlobalConfig();
          await saveGlobalConfig({ ...current, ui: { ...current.ui, sidebarMode: mode } });
        }).catch(() => {});
      },
    }));
    await finished;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    root.unmount();
    detachScrollback?.();
    controller.dispose();
    renderer.destroy();
    await pendingSave;
  }
}
