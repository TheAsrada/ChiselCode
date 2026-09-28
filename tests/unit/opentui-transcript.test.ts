import { expect, test } from "bun:test";
import {
  changedLinePreview,
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

test("diff preview shows at most five changed lines and sanitizes terminal controls", () => {
  const patch = [
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,4 @@",
    "-old",
    "+new",
    "+[31munsafe",
    "+third",
    "+fourth",
    "+fifth",
    "+sixth",
  ].join("\n");
  const preview = changedLinePreview({
    path: "a.ts",
    kind: "edit",
    additions: 6,
    deletions: 1,
    patch,
  });
  expect(preview).toHaveLength(5);
  expect(preview[0]).toBe("-old");
  expect(preview.join(" ")).not.toContain("\u001b");
  expect(preview.join(" ")).not.toContain("sixth");
  expect(terminalSafeText("x\u0000y")).toBe("x y");
});

test("split requires two actual fifty-column diff panes", () => {
  expect(diffViewForWidth(99)).toBe("unified");
  expect(diffViewForWidth(100)).toBe("split");
});
