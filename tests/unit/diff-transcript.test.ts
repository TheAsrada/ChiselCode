import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  loadSession,
  saveSession,
} from "../../src/sessions/store.js";
import { buildFileDiff } from "../../src/tools/file-diff.js";
import type { FileDiff } from "../../src/types/domain.js";
import {
  appendToolResult,
  replaySessionIntoTranscript,
  toolTranscriptHandlers,
} from "../../src/ui/tool-transcript.js";
import type {
  TranscriptTone,
  TuiTranscript,
} from "../../src/ui/tui-contract.js";

function sink() {
  const entries: {
    text: string;
    tone?: TranscriptTone;
    fileDiff?: FileDiff;
  }[] = [];
  let activity: string | undefined;
  const view: TuiTranscript = {
    append: (text, tone, fileDiff) => {
      entries.push({ text, tone, fileDiff });
    },
    appendToLast: () => {},
    clear: () => {
      entries.length = 0;
    },
    setToolActivity: (text) => {
      activity = text;
    },
  };
  return { entries, view, activity: () => activity };
}

test("session storage round-trips complete diff metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-diff-session-"));
  const variable =
    process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
  const previous = process.env[variable];
  process.env[variable] = root;
  try {
    const session = createSession(root, "anthropic", "test");
    const diff = buildFileDiff("x", null, "new\n".repeat(400));
    session.fileDiffs = { "call-1": diff };
    await saveSession(session);
    expect((await loadSession(session.id, root)).fileDiffs?.["call-1"]).toEqual(
      diff,
    );
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("successful tool result replaces activity with one structured entry; errors stay errors", () => {
  const { view, entries, activity } = sink();
  const handlers = toolTranscriptHandlers(() => view);
  handlers.onToolStart?.("edit_file", {
    path: "a.ts",
    old_str: "old",
    new_str: "new",
  });
  expect(activity()).toContain("a.ts");
  expect(entries).toHaveLength(0);
  const diff = buildFileDiff("a.ts", "old", "new");
  handlers.onToolResult?.("edit_file", {
    output: "Edited a.ts.",
    fileDiff: diff,
  });
  expect(activity()).toBeUndefined();
  expect(entries).toHaveLength(1);
  expect(entries[0]?.fileDiff).toBe(diff);
  expect(entries[0]?.text).not.toContain("Edited a.ts.");
  handlers.onToolResult?.("edit_file", {
    output: "denied",
    isError: true,
    fileDiff: diff,
  });
  expect(entries[1]?.tone).toBe("error");
  expect(entries[1]?.fileDiff).toBeUndefined();
  appendToolResult(view, "write_file", { output: "No changes to a.ts." });
  expect(entries[2]?.text).toContain("No changes");
});

test("resume restores separate UI diffs and still replays legacy sessions", () => {
  const session = createSession("/project", "anthropic", "test");
  session.messages = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "c1",
          name: "edit_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "c1", content: "Edited a.ts." },
      ],
    },
  ];
  const diff = buildFileDiff("a.ts", "old", "new");
  session.fileDiffs = { c1: diff };
  const { view, entries } = sink();
  replaySessionIntoTranscript(view, JSON.parse(JSON.stringify(session)));
  expect(entries).toHaveLength(1);
  expect(entries[0]?.fileDiff).toEqual(diff);
  view.clear();
  delete session.fileDiffs;
  replaySessionIntoTranscript(view, session);
  expect(entries[0]?.text).toContain("edit_file a.ts");
  expect(entries.every((entry) => !entry.fileDiff)).toBe(true);
});
