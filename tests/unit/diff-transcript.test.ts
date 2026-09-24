import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render, renderToString } from "ink";
import React from "react";
import {
  createSession,
  loadSession,
  saveSession,
} from "../../src/sessions/store.js";
import { buildFileDiff } from "../../src/tools/file-diff.js";
import type { FileDiff } from "../../src/types/domain.js";
import { FileDiffView, fileDiffRows } from "../../src/ui/file-diff.js";
import {
  appendToolResult,
  replaySessionIntoTranscript,
  toolTranscriptHandlers,
} from "../../src/ui/tool-transcript.js";
import {
  createTuiApprovalResolver,
  type TranscriptTone,
  TuiApp,
  type TuiTranscript,
} from "../../src/ui/tui.js";

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
  const variable = process.platform === "win32" ? "APPDATA" : "XDG_CONFIG_HOME";
  const previous = process.env[variable];
  process.env[variable] = root;
  try {
    const session = createSession(root, "anthropic", "test");
    const diff = buildFileDiff("x", null, "new\n".repeat(400));
    session.fileDiffs = { "call-1": diff };
    await saveSession(session);
    expect((await loadSession(session.id)).fileDiffs?.["call-1"]).toEqual(diff);
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

test("NO_COLOR unified rendering stays readable and bounded at narrow widths", () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const diff = buildFileDiff("a.ts", "old\n", "new\n");
    const text = renderToString(
      React.createElement(FileDiffView, { fileDiff: diff, columns: 38 }),
      { columns: 38 },
    );
    expect(text).toContain("Update(a.ts)");
    expect(text).toContain("- old");
    expect(text).toContain("+ new");
    expect(text).not.toContain("\u001b[");
    expect(text.split("\n").length).toBe(fileDiffRows(diff));
    expect(text.split("\n").every((line) => line.length <= 38)).toBe(true);
    const big = buildFileDiff(
      "big.ts",
      null,
      `${"x".repeat(100_000)}\n${"new\n".repeat(400)}`,
    );
    const rendered = renderToString(
      React.createElement(FileDiffView, { fileDiff: big, columns: 38 }),
      { columns: 38 },
    );
    expect(rendered).toContain("202 more diff lines");
    expect(rendered).toContain("long lines shortened");
    expect(rendered.length).toBeLessThan(9000);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

for (const columns of [80, 24]) {
  test(`approval scrolls and applies diff at ${columns} columns`, async () => {
    const stdout = Object.assign(new PassThrough(), {
      columns,
      rows: 24,
      isTTY: true,
    });
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => {},
      ref: () => stdin,
      unref: () => stdin,
    });
    let latest = "";
    stdout.on("data", (chunk) => {
      if (chunk.toString().length > 50)
        latest = stripVTControlCharacters(chunk.toString());
    });
    const resolver = createTuiApprovalResolver();
    let view: TuiTranscript | undefined;
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: resolver,
        bindTranscript: (next) => {
          view = next;
        },
        onSubmit: async () => {},
        onStatus: async () => "ok",
        onSwitchProject: async (path) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "ok",
        onCompleteSetup: async () => {},
        provider: "anthropic",
        providerLabel: "Anthropic",
        model: "test",
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    const tick = () => new Promise((resolve) => setTimeout(resolve, 150));
    try {
      await tick();
      const diff = buildFileDiff(
        "test.ts",
        null,
        `${Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n")}\n`,
      );
      const handlers = toolTranscriptHandlers(() => view);
      handlers.onToolStart?.("write_file", { path: "test.ts" });
      const decision = resolver.requestApproval({
        tool: "write_file",
        preview: diff.patch,
        fileDiff: diff,
      });
      await tick();
      await tick();
      expect(latest).toContain("Create(test.ts)");
      expect(latest).toContain("Added 60 lines");
      expect(latest).toContain(columns < 40 ? "[y] Да" : "[y] разрешить");
      expect(latest).toContain(columns < 40 ? "[n] Нет" : "[n/Esc]");
      expect(latest).not.toContain("line-60");
      stdin.write("\u001b[F");
      await tick();
      await tick();
      expect(latest).toContain("line-60");
      expect(latest).toContain(columns < 40 ? "[y] Да" : "[y] разрешить");
      expect(latest).toContain(columns < 40 ? "[n] Нет" : "[n/Esc]");
      stdin.write("y");
      expect(await decision).toBe("approved");
      handlers.onToolResult?.("write_file", {
        output: "Wrote test.ts.",
        fileDiff: diff,
      });
      await tick();
      await tick();
      expect(latest).toContain("line-60");
      expect(latest).toContain("Спросите");
      expect(latest).not.toContain("Wrote test.ts.");
      stdin.write("\u001b[H");
      await tick();
      await tick();
      expect(latest).toContain("Create(test.ts)");
      expect(latest).not.toContain("write_file test.ts");
    } finally {
      instance.unmount();
    }
  });
}
