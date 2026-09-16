import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import type { SetupValues } from "../../src/ui/setup.js";
import {
  createTuiApprovalResolver,
  TuiApp,
  type TuiTranscript,
} from "../../src/ui/tui.js";

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

/** Убирает управляющие последовательности Ink, оставляя видимый текст. */
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

describe("settings restart setup", () => {
  test("opens the setup wizard in-app without exiting", async () => {
    const stdout = createMockStdout(100, 30);
    const stdin = createMockStdin();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    let transcript: TuiTranscript | undefined;
    const resolver = createTuiApprovalResolver();
    const completed: SetupValues[] = [];
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: resolver,
        bindTranscript: (next: TuiTranscript) => {
          transcript = next;
        },
        onSubmit: async () => {},
        onStatus: async () => "status",
        onSwitchProject: async (path: string) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "ok",
        onCompleteSetup: async (values: SetupValues) => {
          completed.push(values);
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
      expect(transcript).toBeDefined();
      await tick();
      // Открываем настройки командой.
      for (const ch of "/settings") {
        stdin.write(ch);
        await tick(20);
      }
      stdin.write("\r");
      await tick(200);
      expect(stripAnsi(output)).toContain("Настройки");

      // provider(0), key(1), model(2), save(3), check(4), setup(5): пять шагов + Enter.
      for (let i = 0; i < 5; i += 1) {
        stdin.write("\x1b[B");
        await tick(100);
      }
      output = "";
      stdin.write("\r");
      await tick(300);

      // Мастер открылся в том же приложении: виден заголовок настройки,
      // а приложение НЕ вышло (иначе waitUntilExit завершился бы).
      const frame = stripAnsi(output);
      expect(frame).toContain("быстрая настройка");
      let exited = false;
      void instance.waitUntilExit().then(() => {
        exited = true;
      });
      await tick(150);
      expect(exited).toBe(false);

      // Ctrl+C отменяет встроенный мастер и возвращает в чат, не выходя.
      stdin.write("\x03");
      await tick(300);
      expect(stripAnsi(output)).toContain("Спросите что-нибудь");
      await tick(100);
      expect(exited).toBe(false);
      expect(completed).toHaveLength(0);
    } finally {
      instance.unmount();
    }
  });

  test("completing the in-app wizard updates runtime without exiting", async () => {
    const stdout = createMockStdout(100, 30);
    const stdin = createMockStdin();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const resolver = createTuiApprovalResolver();
    const completed: SetupValues[] = [];
    const instance = render(
      React.createElement(TuiApp, {
        approvalResolver: resolver,
        bindTranscript: () => {},
        onSubmit: async () => {},
        onStatus: async () => "status",
        onSwitchProject: async (path: string) => path,
        onSaveSettings: async () => "saved" as const,
        onCheckConnection: async () => "ok",
        onCompleteSetup: async (values: SetupValues) => {
          completed.push(values);
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
      for (const ch of "/settings") {
        stdin.write(ch);
        await tick(20);
      }
      stdin.write("\r");
      await tick(200);
      // provider(0), key(1), model(2), save(3), check(4), setup(5): пять шагов + Enter.
      for (let i = 0; i < 5; i += 1) {
        stdin.write("\x1b[B");
        await tick(100);
      }
      stdin.write("\r");
      await tick(300);
      expect(stripAnsi(output)).toContain("быстрая настройка");

      // Шаг провайдера: выбираем Anthropic (1).
      output = "";
      stdin.write("1");
      await tick(200);
      // Шаг ключа: вводим ключ + Enter.
      for (const ch of "test-key-123") {
        stdin.write(ch);
        await tick(15);
      }
      stdin.write("\r");
      await tick(300);
      // Шаг модели: предложенная модель уже введена, Enter сохраняет.
      output = "";
      stdin.write("\r");
      await tick(400);

      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        provider: "anthropic",
        apiKey: "test-key-123",
        model: "claude-opus-5",
      });
      // Вернулись в чат: видно поле ввода и итог в журнале.
      const frame = stripAnsi(output);
      expect(frame).toContain("Спросите что-нибудь");
      expect(frame).toContain("Настройка обновлена");

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
});
