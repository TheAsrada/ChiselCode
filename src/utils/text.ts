const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Bound UTF-8 storage without decoding a partial code point. */
export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** Bound UTF-16 storage without splitting a user-perceived character. */
export function clipText(input: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (input.length <= limit) return input;
  return input.slice(0, graphemes.segment(input).containing(limit)?.index ?? 0);
}

/** Keep a bounded tail, excluding a partial grapheme at its left boundary. */
export function textTail(input: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (input.length <= limit) return input;
  if (!limit) return "";
  const start = input.length - limit;
  const item = graphemes.segment(input).containing(start);
  return item
    ? input.slice(item.index < start ? item.index + item.segment.length : start)
    : "";
}
