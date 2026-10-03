import { expect, test } from "bun:test";
import {
  diffViewForWidth,
  terminalSafeText,
  visibleTranscriptWindow,
} from "../../src/ui/opentui-transcript.js";

test("large transcripts prepare only the visible window and retain older pages", () => {
  const entries = Array.from({ length: 10_000 }, (_, id) => ({
    id,
    text: `line ${id}`,
    tone: "assistant" as const,
  }));
  const latest = visibleTranscriptWindow(entries);
  expect(latest.entries).toHaveLength(240);
  expect(latest.start).toBe(9760);
  const older = visibleTranscriptWindow(entries, 500);
  expect(older.entries[0]?.id).toBe(260);
  expect(older.entries.at(-1)?.id).toBe(499);
});

test("split requires two actual fifty-column diff panes", () => {
  expect(diffViewForWidth(99)).toBe("unified");
  expect(diffViewForWidth(100)).toBe("split");
});
test("terminal display normalizes CRLF without inserting spaces into full-width lines", () => {
  expect(terminalSafeText("Первая\r\nВторая\r\n")).toBe("Первая\nВторая\n");
  expect(terminalSafeText("x\ry")).toBe("x y");
});
