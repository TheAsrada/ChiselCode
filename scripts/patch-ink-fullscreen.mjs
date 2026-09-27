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
            this.throttledLog.cancel?.();
            this.options.stdout.write('\\x1b[2J\\x1b[H');
            this.log.reset();
            this.lastOutput = '';
            this.lastOutputToRender = '';
            this.lastOutputHeight = 0;
        } else if (currentWidth < this.lastTerminalWidth) {`;
if (!source.includes(reset)) {
  const oldReset = `if (this.alternateScreen) {
            this.options.stdout.write('\\x1b[2J\\x1b[H');`;
  if (source.includes(oldReset)) {
    source = source.replace(oldReset, `if (this.alternateScreen) {
            this.throttledLog.cancel?.();
            this.options.stdout.write('\\x1b[2J\\x1b[H');`);
  } else {
    if (!source.includes(resize)) throw new Error("Ink resize patch no longer matches");
    source = source.replace(resize, reset);
  }
}
writeFileSync(inkPath, source);

// Relative cursor movement in Ink's incremental writer assumes that the
// previous frame left the console cursor on its last row. Native Windows
// consoles can move it while the buffer is activated or resized, especially
// during startup. Address changed rows directly so a shifted cursor cannot
// paint an old prompt over the input border.
const logPath = resolve(dirname(require.resolve("ink")), "log-update.js");
let logSource = readFileSync(logPath, "utf8");
const cursorOnly = "if (str === previousOutput && cursorChanged) {";
const safeCursorOnly =
  "if (str === previousOutput && cursorChanged && !(process.platform === 'win32' && stream.isTTY)) {";
const incrementalStart = "const createIncremental = (stream, { showCursor = false } = {}) => {";
const incrementalIndex = logSource.indexOf(incrementalStart);
if (incrementalIndex < 0)
  throw new Error("Ink incremental patch no longer matches ink 7.1.1");
const standardSource = logSource.slice(0, incrementalIndex);
let incrementalSource = logSource.slice(incrementalIndex);
if (!incrementalSource.includes(safeCursorOnly)) {
  if (!incrementalSource.includes(cursorOnly))
    throw new Error("Ink cursor patch no longer matches");
  incrementalSource = incrementalSource.replace(cursorOnly, safeCursorOnly);
}
const rowMarker =
  "        const returnPrefix = buildReturnToBottomPrefix(cursorWasShown, previousLines.length, previousCursorPosition);";
const absoluteRows = `        if (process.platform === 'win32' && stream.isTTY) {
            const buffer = [];
            if (cursorWasShown) buffer.push(hideCursorEscape);
            const rows = Math.max(previousVisible, visibleCount);
            for (let i = 0; i < rows; i++) {
                const next = i < visibleCount ? nextLines[i] : '';
                if (next === previousLines[i]) continue;
                buffer.push(\`\\x1b[\${i + 1};1H\`, next, ansiEscapes.eraseEndLine);
            }
            if (activeCursor) {
                buffer.push(\`\\x1b[\${activeCursor.y + 1};\${activeCursor.x + 1}H\\x1b[?25h\`);
            } else {
                buffer.push(\`\\x1b[\${Math.max(1, visibleCount)};1H\`);
            }
            stream.write(buffer.join(''));
            cursorWasShown = activeCursor !== undefined;
            previousCursorPosition = activeCursor ? { ...activeCursor } : undefined;
            previousOutput = str;
            previousLines = nextLines;
            return true;
        }
`;
if (!incrementalSource.includes(absoluteRows)) {
  if (!incrementalSource.includes(rowMarker))
    throw new Error("Ink row patch no longer matches");
  incrementalSource = incrementalSource.replace(rowMarker, absoluteRows + rowMarker);
}
logSource = standardSource + incrementalSource;
writeFileSync(logPath, logSource);
