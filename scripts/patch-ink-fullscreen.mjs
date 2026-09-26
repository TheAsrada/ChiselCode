import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

// Ink 7.1.1 clears every full-height Windows frame to work around terminals
// that scroll when the bottom-right cell is written. ChiselCode leaves that
// cell unused, so incremental frames are safe and keep the footer on the last
// row without flashing the entire console on every keystroke.
const require = createRequire(import.meta.url);
const inkPath = resolve(dirname(require.resolve("ink")), "ink.js");
const source = readFileSync(inkPath, "utf8");
const original = "if (isWindowsConsole && (wasFullscreen || isFullscreen)) {";
const patched = "if (isWindowsConsole && (wasOverflowing || isOverflowing)) {";
if (source.includes(patched)) process.exit(0);
if (!source.includes(original))
  throw new Error("Ink fullscreen patch no longer matches ink 7.1.1");
writeFileSync(inkPath, source.replace(original, patched));
