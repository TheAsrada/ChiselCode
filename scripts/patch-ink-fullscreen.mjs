import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

// Ink 7.1.1 clears every full-height Windows frame to work around terminals
// that scroll when the bottom-right cell is written. ChiselCode leaves that
// cell unused, so incremental frames are safe and keep the footer on the last
// row without flashing the entire console on every keystroke.
const require = createRequire(import.meta.url);
const inkPath = resolve(dirname(require.resolve("ink")), "ink.js");
let source = readFileSync(inkPath, "utf8");
const original = "if (isWindowsConsole && (wasFullscreen || isFullscreen)) {";
const patched = "if (isWindowsConsole && (wasOverflowing || isOverflowing)) {";
if (!source.includes(patched) && !source.includes(original))
  throw new Error("Ink fullscreen patch no longer matches ink 7.1.1");
source = source.replace(original, patched);
// A resize invalidates cursor-relative diffs on BOTH axes. The host may have
// reflowed or cropped the old buffer. Start the next frame at an absolute origin.
const resize = "if (currentWidth < this.lastTerminalWidth) {";
const reset = `if (this.alternateScreen) {
            this.options.stdout.write('\\x1b[2J\\x1b[H');
            this.log.reset();
            this.lastOutput = '';
            this.lastOutputToRender = '';
            this.lastOutputHeight = 0;
        } else if (currentWidth < this.lastTerminalWidth) {`;
if (!source.includes(reset)) {
  if (!source.includes(resize)) throw new Error("Ink resize patch no longer matches");
  source = source.replace(resize, reset);
}
writeFileSync(inkPath, source);
