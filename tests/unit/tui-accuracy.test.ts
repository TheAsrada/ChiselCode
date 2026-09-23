import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import React from "react";
import {
  estimateLineRows,
  TranscriptLineView,
  type TuiTranscriptLine,
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

const tick = (ms = 80): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Реальная высота рендера строки в клетках: смета обязана её покрывать. */
async function actualRows(
  line: TuiTranscriptLine,
  columns: number,
): Promise<number> {
  const stdout = createMockStdout(columns, 40);
  const stdin = createMockStdin();
  // В debug Ink печатает один и тот же кадр дважды подряд без разделителя
  // (один write на кадр — проверено дампом чанков): меряем строго первый.
  const chunks: string[] = [];
  stdout.on("data", (chunk) => {
    chunks.push(chunk.toString());
  });
  const instance = render(
    React.createElement(
      Box,
      { width: columns },
      React.createElement(TranscriptLineView, { line, columns }),
    ),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await tick();
  instance.unmount();
  await tick(20);
  const text = stripAnsi(chunks[0] ?? "");
  const parts = text.split("\n");
  // Ink завершает кадр переводом строки — висячий хвост не строка.
  return parts.length - (parts.at(-1) === "" ? 1 : 0);
}

interface Case {
  name: string;
  line: TuiTranscriptLine;
  columns: number;
}

const CASES: Case[] = [
  {
    name: "info short",
    line: { id: 1, text: "hello", tone: "info" },
    columns: 100,
  },
  {
    name: "info wrap",
    line: { id: 2, text: "x".repeat(250), tone: "info" },
    columns: 100,
  },
  {
    name: "info multiline",
    line: { id: 3, text: "a\nb\nc", tone: "info" },
    columns: 100,
  },
  {
    name: "assistant paragraph",
    line: { id: 4, text: "Короткий ответ.", tone: "assistant" },
    columns: 100,
  },
  {
    name: "assistant long wrap",
    line: { id: 5, text: `${"слово ".repeat(60).trim()}`, tone: "assistant" },
    columns: 100,
  },
  {
    name: "assistant code",
    line: {
      id: 6,
      text: "```ts\nconst x = 1;\nconst y = 2;\n```",
      tone: "assistant",
    },
    columns: 100,
  },
  {
    name: "assistant list",
    line: { id: 7, text: "- раз\n- два\n- три", tone: "assistant" },
    columns: 100,
  },
  {
    name: "assistant quote",
    line: { id: 8, text: "> цитата\n> вторая", tone: "assistant" },
    columns: 100,
  },
  {
    name: "assistant heading",
    line: { id: 9, text: "# Заголовок", tone: "assistant" },
    columns: 100,
  },
  {
    name: "assistant hr",
    line: { id: 10, text: "---", tone: "assistant" },
    columns: 100,
  },
  {
    name: "assistant narrow wrap",
    line: { id: 11, text: "коротко", tone: "assistant" },
    columns: 40,
  },
  {
    name: "assistant code narrow",
    line: {
      id: 12,
      text: "```\nopen fence line here\n```",
      tone: "assistant",
    },
    columns: 40,
  },
  {
    name: "user short",
    line: { id: 13, text: "❯ сделай дело", tone: "user" },
    columns: 100,
  },
  {
    name: "user long",
    line: { id: 14, text: "❯ сделай дело пожалуйста", tone: "user" },
    columns: 100,
  },
  {
    name: "user long wrap",
    line: { id: 15, text: `❯ ${"слово ".repeat(40).trim()}`, tone: "user" },
    columns: 100,
  },
  {
    name: "tool",
    line: { id: 16, text: "[chisel] read_file src/ui/tui.tsx", tone: "tool" },
    columns: 100,
  },
  {
    name: "dim separator",
    line: { id: 17, text: "─".repeat(100), tone: "dim" },
    columns: 100,
  },
  {
    name: "logo",
    line: {
      id: 18,
      text: "  ▀█▄ ██▄ ▄█▀   ▀███████ ██ ██ ██▄ ▄▄▄█▀ ▀█▄▄▄ ██ ▀███████ ▀███▀ ▀████ ▀█▄▄▄",
      tone: "logo",
    },
    columns: 100,
  },
  {
    name: "success",
    line: { id: 19, text: "✓ Готово за 5с · 100 токенов", tone: "success" },
    columns: 100,
  },
  {
    name: "info narrow",
    line: { id: 20, text: "x".repeat(90), tone: "info" },
    columns: 40,
  },
];

describe("estimator vs actual ink render", () => {
  for (const { name, line, columns } of CASES) {
    test(`${name} @${columns}: covers render without big voids`, async () => {
      const estimated = estimateLineRows(line, columns);
      const actual = await actualRows(line, columns);
      // Смета НИКОГДА не меньше рендера: иначе Ink обрежет свежие строки.
      expect(actual).toBeLessThanOrEqual(estimated);
      // ...и не больше чем на 2 строки: иначе вьюпорт дырявый.
      expect(estimated - actual).toBeLessThanOrEqual(2);
    });
  }
});
