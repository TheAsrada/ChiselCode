import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import {
  deleteSession,
  formatSessionList,
  listSessions,
  resolveSessionRef,
  sessionTitleForPrompt,
} from "../../src/sessions/store.js";
import type { Session } from "../../src/types/domain.js";
import { createTuiApprovalResolver, TuiApp } from "../../src/ui/tui.js";

function makeSession(partial: Partial<Session> & { id: string }): Session {
  return {
    projectPath: "C:\\proj",
    messages: [],
    model: "gpt-5.6-sol",
    provider: "openai-compatible",
    totalTokens: {
      inputTokens: 0,
      outputTokens: 0,
    },
    totalCost: 0,
    undoStack: [],
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T12:00:00.000Z",
    ...partial,
  };
}

describe("session helpers", () => {
  test("legacy sessions copy into ChiselCode Home once without removing originals", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-sessions-home-"));
    const previousLocal = process.env.LOCALAPPDATA;
    const previousApp = process.env.APPDATA;
    const previousXdg = process.env.XDG_DATA_HOME;
    const previousConfig = process.env.XDG_CONFIG_HOME;
    process.env.LOCALAPPDATA = join(root, "local");
    process.env.APPDATA = join(root, "roaming");
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_CONFIG_HOME = join(root, "config");
    try {
      const legacy =
        process.platform === "win32"
          ? join(root, "roaming", "chiselcode", "sessions")
          : join(root, "config", "chiselcode", "sessions");
      await mkdir(legacy, { recursive: true });
      const id = "12345678-aaaa-bbbb-cccc-ddeeff001122";
      const projectPath = join(root, "project");
      const text = JSON.stringify(makeSession({ id, projectPath }));
      await writeFile(join(legacy, `${id}.json`), text);
      expect(
        (await listSessions(projectPath)).map((session) => session.id),
      ).toContain(id);
      expect(await readFile(join(legacy, `${id}.json`), "utf8")).toBe(text);
      await deleteSession(id, projectPath);
      expect(
        (await listSessions(projectPath)).map((session) => session.id),
      ).not.toContain(id);
      expect(await readFile(join(legacy, `${id}.json`), "utf8")).toBe(text);
    } finally {
      for (const [key, value] of [
        ["LOCALAPPDATA", previousLocal],
        ["APPDATA", previousApp],
        ["XDG_DATA_HOME", previousXdg],
        ["XDG_CONFIG_HOME", previousConfig],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  test("builds a title from the first prompt line", () => {
    expect(sessionTitleForPrompt("  почини баг  ")).toBe("почини баг");
    expect(sessionTitleForPrompt("первая строка\nвторая строка")).toBe(
      "первая строка",
    );
    expect(sessionTitleForPrompt("x".repeat(100))).toBe(`${"x".repeat(60)}…`);
    expect(sessionTitleForPrompt("")).toBe("");
  });

  test("formats an empty session list", () => {
    expect(formatSessionList([])).toContain("пока нет");
  });

  test("formats sessions with titles, tokens and short ids", () => {
    const text = formatSessionList([
      makeSession({
        id: "12345678-aaaa-bbbb-cccc-ddeeff001122",
        title: "почини баг",
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
        totalTokens: { inputTokens: 1000, outputTokens: 500 },
      }),
      makeSession({ id: "abcdef01-0000-0000-0000-000000000000" }),
    ]);
    expect(text).toContain("Сессии проекта:");
    expect(text).toContain("1. почини баг");
    expect(text).toContain("2 сообщ.");
    expect(text).toContain("1500 токенов");
    expect(text).toContain("12345678");
    expect(text).toContain("без названия");
  });

  test("resolves sessions by number or id prefix", () => {
    const first = makeSession({ id: "aaa11111-0000-0000-0000-000000000000" });
    const second = makeSession({ id: "bbb22222-0000-0000-0000-000000000000" });
    const list = [first, second];
    expect(resolveSessionRef(list, "1")).toBe(first);
    expect(resolveSessionRef(list, "2")).toBe(second);
    expect(resolveSessionRef(list, "bbb2")).toBe(second);
    expect(resolveSessionRef(list, "AAA11111")).toBe(first);
    expect(resolveSessionRef(list, "0")).toBeUndefined();
    expect(resolveSessionRef(list, "3")).toBeUndefined();
    expect(resolveSessionRef(list, "zzz")).toBeUndefined();
    expect(resolveSessionRef(list, "")).toBeUndefined();
    expect(resolveSessionRef(list, "  ")).toBeUndefined();
  });
});

type MockStdout = PassThrough & {
  columns: number;
  rows: number;
  isTTY: boolean;
};

type MockStdin = PassThrough & {
  isTTY: boolean;
  setRawMode(mode: boolean): void;
  ref(): unknown;
  unref(): unknown;
};

function createMockStdout(columns: number, rows: number): MockStdout {
  const stdout = new PassThrough() as MockStdout;
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = true;
  return stdout;
}

function createMockStdin(): MockStdin {
  const stdin = new PassThrough() as MockStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function stripAnsi(input: string): string {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const chunks = input.split(ESC);
  let result = chunks[0] ?? "";
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith("]")) {
      const end = chunk.indexOf(BEL);
      result += end === -1 ? "" : chunk.slice(end + 1);
      continue;
    }
    const csi = /^\[[0-9;?]*[A-Za-z]/.exec(chunk);
    if (csi) {
      result += chunk.slice(csi[0].length);
      continue;
    }
    if (
      chunk.startsWith("(") ||
      chunk.startsWith(")") ||
      chunk.startsWith("#")
    ) {
      result += chunk.slice(2);
      continue;
    }
    result += chunk.slice(1);
  }
  return result.replace(/\r/g, "");
}

const tick = (ms = 60): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function typeCommand(stdin: MockStdin, command: string): Promise<void> {
  for (const ch of command) {
    stdin.write(ch);
    await tick(20);
  }
  stdin.write("\r");
  await tick(400);
}

describe("tui session commands", () => {
  test("/clear does not start a new session", async () => {
    const stdout = createMockStdout(100, 30);
    const stdin = createMockStdin();
    let newCalls = 0;
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: createTuiApprovalResolver(),
        bindTranscript: () => {},
        onSubmit: async () => {},
        onStatus: async () => "status",
        onSwitchProject: async (path: string) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "ok",
        onCompleteSetup: async () => {},
        onNewSession: async () => {
          newCalls += 1;
          return "new";
        },
        provider: "anthropic",
        providerLabel: "Anthropic",
        model: "test-model",
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    );
    try {
      await tick();
      await typeCommand(stdin, "/clear");
      expect(newCalls).toBe(0);
    } finally {
      instance.unmount();
    }
  });
  test("/resume opens the project picker without asking for an ID", async () => {
    const stdout = createMockStdout(100, 30);
    const stdin = createMockStdin();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const id = "12345678-aaaa-bbbb-cccc-ddeeff001122";
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: createTuiApprovalResolver(),
        bindTranscript: () => {},
        onSubmit: async () => {},
        onStatus: async () => "status",
        onSwitchProject: async (path: string) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "ok",
        onCompleteSetup: async () => {},
        onSessionSummaries: async () => [
          {
            id,
            title: "Исправить вход",
            titleSource: "auto" as const,
            createdAt: "2026-09-14T10:00:00.000Z",
            updatedAt: "2026-09-14T12:00:00.000Z",
            provider: "anthropic" as const,
            model: "test-model",
            messageCount: 2,
            totalTokens: { inputTokens: 2, outputTokens: 2 },
            lastUserMessage: "проверить логин",
          },
        ],
        onPreviewSession: async () => makeSession({ id }),
        onResumeSession: async () => "resumed",
        provider: "anthropic",
        providerLabel: "Anthropic",
        model: "test-model",
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    );
    try {
      await tick();
      await typeCommand(stdin, "/resume");
      expect(stripAnsi(output)).toContain("Возобновить сессию");
      expect(stripAnsi(output)).toContain("Исправить вход");
    } finally {
      instance.unmount();
    }
  });
  test("/new clears the view and starts a new session", async () => {
    const stdout = createMockStdout(100, 30);
    const stdin = createMockStdin();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    let newCalls = 0;
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: createTuiApprovalResolver(),
        bindTranscript: () => {},
        onSubmit: async () => {},
        onStatus: async () => "status",
        onSwitchProject: async (path: string) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "ok",
        onCompleteSetup: async () => {},
        onNewSession: async () => {
          newCalls += 1;
          return "new-session-ok";
        },
        provider: "anthropic",
        providerLabel: "Anthropic (Claude)",
        model: "test-model",
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    );
    try {
      await tick();
      await typeCommand(stdin, "/new");
      expect(newCalls).toBe(1);
      expect(stripAnsi(output)).toContain("new-session-ok");
    } finally {
      instance.unmount();
    }
  });

  test("/sessions prints the list and /resume passes its argument", async () => {
    const stdout = createMockStdout(100, 30);
    const stdin = createMockStdin();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const resumed: string[] = [];
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: createTuiApprovalResolver(),
        bindTranscript: () => {},
        onSubmit: async () => {},
        onStatus: async () => "status",
        onSwitchProject: async (path: string) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "ok",
        onCompleteSetup: async () => {},
        onListSessions: async () => "1. почини баг",
        onResumeSession: async (ref: string) => {
          resumed.push(ref);
          return `resumed:${ref}`;
        },
        provider: "anthropic",
        providerLabel: "Anthropic (Claude)",
        model: "test-model",
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    );
    try {
      await tick();
      await typeCommand(stdin, "/sessions");
      expect(stripAnsi(output)).toContain("почини баг");
      output = "";
      await typeCommand(stdin, "/resume 1");
      expect(resumed).toEqual(["1"]);
      expect(stripAnsi(output)).toContain("resumed:1");
    } finally {
      instance.unmount();
    }
  });
});
