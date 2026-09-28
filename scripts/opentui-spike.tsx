/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import { OpenTuiSpike } from "../src/ui/opentui-spike.js";

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
  const classic = process.env.CHISEL_ALT_SCREEN === "0" || process.env.CHISEL_NO_ALT_SCREEN === "1";
  const renderer = await createCliRenderer({
    screenMode: classic ? "split-footer" : "alternate-screen",
    footerHeight: 12,
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const root = createRoot(renderer);
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const shutdown = () => finish?.();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    root.render(React.createElement(OpenTuiSpike, { onExit: shutdown }));
    await finished;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    root.unmount();
    renderer.destroy();
  }
}
