/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import { loadGlobalConfig, saveGlobalConfig } from "../src/config/load.js";
import type { GlobalConfig } from "../src/types/domain.js";
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
    process.stdout.write("OpenTUI native smoke: OK\n");
  } finally {
    act(() => { setup.renderer.destroy(); });
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
      initialMode: config.ui?.sidebarMode ?? "auto",
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
    controller.dispose();
    renderer.destroy();
    await pendingSave;
  }
}
