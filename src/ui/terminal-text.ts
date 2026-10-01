import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { clipText } from "../utils/text.js";

export { clipText } from "../utils/text.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Bun's node:util implementation can leave OSC payloads containing spaces.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Explicit terminal OSC delimiters are stripped before rendering.
const osc = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;

/** Sanitize only the display; original messages, paths and patches stay intact. */
export function terminalSafeText(input: string, maxChars = 100_000): string {
  const clean = stripVTControlCharacters(
    input.replace(osc, "").replaceAll("\r\n", "\n"),
  )
    // Keep LF and TAB for multiline content, remove C0/C1 terminal controls.
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : " ",
    );
  const valid = Array.from(clean, (character) => {
    const code = character.charCodeAt(0);
    return character.length === 1 && code >= 0xd800 && code <= 0xdfff
      ? "?"
      : character;
  }).join("");
  return clipText(valid, maxChars);
}

/** Fit one UI line to terminal cells, preserving emoji and combining sequences. */
export function terminalLine(input: string, maxColumns: number): string {
  const limit = Math.max(0, Math.floor(maxColumns));
  const clean = terminalSafeText(input).replace(/[\t\n]/g, " ");
  if (stringWidth(clean) <= limit) return clean;
  if (!limit) return "";
  const suffix = ".".repeat(Math.min(3, limit));
  let text = "";
  let columns = 0;
  for (const { segment } of graphemes.segment(clean)) {
    const cells = stringWidth(segment);
    if (columns + cells > limit - suffix.length) break;
    text += segment;
    columns += cells;
  }
  return text + suffix;
}
