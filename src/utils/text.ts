const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
