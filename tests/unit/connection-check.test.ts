import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import { checkProviderConnection } from "../../src/commands/run.js";
import { saveGlobalConfig } from "../../src/config/load.js";
import type { SetupValues } from "../../src/ui/setup.js";
import { createTuiApprovalResolver, TuiApp } from "../../src/ui/tui.js";

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

describe("settings connection check", () => {
  test("check menu item shows the verdict without exiting", async () => {
    const stdout = createMockStdout(100, 30);
    const stdin = createMockStdin();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const resolver = createTuiApprovalResolver();
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: resolver,
        bindTranscript: () => {},
        onSubmit: async () => {},
        onStatus: async () => "status",
        onSwitchProject: async (path: string) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "✓ test-connection-ok",
        onCompleteSetup: async (_values: SetupValues) => {},
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
      for (const ch of "/settings") {
        stdin.write(ch);
        await tick(20);
      }
      stdin.write("\r");
      await tick(200);
      expect(stripAnsi(output)).toContain("Настройки");
      // provider(0), model(1), save(2), check(3): три шага вниз + Enter.
      for (let i = 0; i < 3; i += 1) {
        stdin.write("\x1b[B");
        await tick(100);
      }
      output = "";
      stdin.write("\r");
      await tick(400);
      expect(stripAnsi(output)).toContain("test-connection-ok");

      let exited = false;
      void instance.waitUntilExit().then(() => {
        exited = true;
      });
      await tick(150);
      expect(exited).toBe(false);
    } finally {
      instance.unmount();
    }
  });

  test("reports a missing API key without touching the network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-conn-"));
    const configPath = join(directory, "config.json");
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await saveGlobalConfig({ providers: {} }, configPath);
      const result = await checkProviderConnection(
        { provider: "openai-compatible" },
        { configPath },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Нет API-ключа");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports a missing base URL without touching the network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-conn-"));
    const configPath = join(directory, "config.json");
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      await saveGlobalConfig({ providers: {} }, configPath);
      const result = await checkProviderConnection(
        {
          provider: "openai-compatible",
          baseUrl: undefined,
          model: "gpt-5.6-sol",
        },
        { configPath },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("baseUrl");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports an unreachable server instead of hanging", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-conn-"));
    const configPath = join(directory, "config.json");
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      await saveGlobalConfig({ providers: {} }, configPath);
      const result = await checkProviderConnection(
        {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "gpt-5.6-sol",
        },
        { configPath },
      );
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
