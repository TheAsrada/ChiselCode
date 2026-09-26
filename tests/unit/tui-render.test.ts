import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import { userSkillsDir } from "../../src/paths/home.js";
import { LOGO_WIDTH, renderLogoRows } from "../../src/ui/logo.js";
import {
  createTuiApprovalResolver,
  shouldUseAltScreen,
  TuiApp,
  type TuiTranscript,
} from "../../src/ui/tui.js";

async function prepareUserSkill(
  root: string,
  name: string,
  content: string,
): Promise<() => void> {
  const envName =
    process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
  const previous = process.env[envName];
  process.env[envName] = root;
  const dir = join(userSkillsDir(), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content);
  return () => {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  };
}

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
      // OSC-последовательность — всё до BEL.
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
    // Одиночные управляющие (M, =, >, 7, 8 …) — пропускаем первый символ.
    result += chunk.slice(1);
  }
  return result.replace(/\r/g, "");
}

const tick = (ms = 60): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  stdin: MockStdin;
  stdout: MockStdout;
  transcript?: TuiTranscript;
  chunks(): string;
  raw(): string;
  frame(): string;
  unmount(): void;
}

async function startApp(
  columns: number,
  rows: number,
  hooks?: {
    cwd?: string;
    classic?: boolean;
    debug?: boolean;
    onSubmit?: (prompt: string, display?: string) => Promise<void>;
  },
): Promise<Harness> {
  const stdout = createMockStdout(columns, rows);
  const stdin = createMockStdin();
  let output = "";
  let frame = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
    const visible = stripAnsi(chunk.toString());
    if (visible.trim()) frame = visible;
  });
  let transcript: TuiTranscript | undefined;
  const resolver = createTuiApprovalResolver();
  const instance = render(
    React.createElement(TuiApp, {
      approvalResolver: resolver,
      bindTranscript: (next: TuiTranscript) => {
        transcript = next;
      },
      onSubmit: hooks?.onSubmit ?? (async () => {}),
      onStatus: async () => "status",
      onSwitchProject: async (path: string) => path,
      onSaveSettings: async () => "saved" as const,
      onCheckConnection: async () => "ok",
      onCompleteSetup: async () => {},
      provider: "anthropic",
      providerLabel: "Anthropic (Claude)",
      model: "test-model",
      cwd: hooks?.cwd,
      classic: hooks?.classic ?? false,
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      // debug: Ink пишет каждый кадр статичным текстом без кодов
      // перерисовки — одинаково локально и в CI, где интерактивный
      // режим отключён и кадры иначе не прочитать из потока.
      debug: hooks?.debug ?? true,
      interactive: hooks?.debug === false ? true : undefined,
      alternateScreen: hooks?.debug === false && !hooks?.classic,
      incrementalRendering: hooks?.debug === false && !hooks?.classic,
    },
  );
  await tick();
  return {
    stdin,
    stdout,
    get transcript() {
      return transcript;
    },
    chunks: () => stripAnsi(output),
    raw: () => output,
    frame: () => frame,
    unmount: () => instance.unmount(),
  };
}

describe("tui render", () => {
  test("full-height Windows frame updates without clearing the whole screen", async () => {
    const app = await startApp(80, 24, { debug: false });
    try {
      await tick(250);
      const before = app.raw().length;
      app.stdin.write("x");
      await tick(250);
      expect(app.raw().slice(before)).not.toContain("\x1b[2J");
    } finally {
      app.unmount();
    }
  });

  test("Windows shortcut defaults to pinned input with no scrolling beyond content", async () => {
    const app = await startApp(80, 24, {
      classic: !shouldUseAltScreen({}, "win32"),
    });
    const inputRow = () =>
      app
        .frame()
        .split("\n")
        .findIndex((row) => row.includes("Спросите что-нибудь"));
    try {
      const initial = app.frame();
      const row = inputRow();
      expect(row).toBe(21);
      expect(app.frame().trimEnd().split("\n").at(-1)).toContain("Tab/");
      expect(app.frame().trimEnd().split("\n")).toHaveLength(24);
      const hintWidth = app.frame().trimEnd().split("\n").at(-1)?.length ?? 0;
      expect(hintWidth).toBeLessThanOrEqual(
        process.platform === "win32" ? 79 : 80,
      );
      const writtenBeforeTyping = app.raw().length;
      app.stdin.write("x");
      await tick(100);
      expect(app.raw().slice(writtenBeforeTyping)).not.toContain("\x1b[2J");
      app.stdin.write("\x7f");
      await tick(100);
      for (const key of [
        "\x1b[<65;1;1M",
        "\x1b[6~",
        "\x1b[F",
        "\x1b[<64;1;1M",
      ]) {
        app.stdin.write(key);
        await tick(100);
        expect(app.frame()).toBe(initial);
      }
      app.transcript?.appendToLast(
        Array.from({ length: 70 }, (_, i) => `MESSAGE-${i}`).join("\n"),
      );
      await tick(200);
      expect(app.frame()).toContain("MESSAGE-69");
      expect(inputRow()).toBe(row);
      const bottom = app.frame();
      for (let i = 0; i < 6; i++) app.stdin.write("\x1b[<65;1;1M");
      await tick(200);
      expect(app.frame()).toBe(bottom);
      app.stdin.write("\x1b[5~");
      await tick(200);
      expect(app.frame()).not.toContain("MESSAGE-69");
      expect(inputRow()).toBe(row);
      app.stdin.write("\x1b[F");
      await tick(200);
      expect(app.frame()).toBe(bottom);
      app.transcript?.appendToLast("\nMESSAGE-70");
      await tick(200);
      expect(app.frame()).toContain("MESSAGE-70");
      expect(inputRow()).toBe(row);
      app.transcript?.clear();
      await tick(200);
      const empty = app.frame();
      app.stdin.write("\x1b[6~");
      await tick(100);
      expect(app.frame()).toBe(empty);
      expect(inputRow()).toBe(row);
    } finally {
      app.unmount();
    }
  });

  test("a long response scrolls by terminal rows, including its tail", async () => {
    const app = await startApp(60, 20);
    const numbered = Array.from(
      { length: 80 },
      (_, i) => `ROW-${String(i).padStart(3, "0")}`,
    ).join("\n");
    const visibleRows = () => app.frame().match(/ROW-\d{3}/g) ?? [];
    try {
      app.transcript?.append(numbered, "assistant");
      await tick(250);
      expect(visibleRows().at(-1)).toBe("ROW-079");
      const before = visibleRows();
      app.stdin.write("\x1b[<64;1;1M");
      await tick(250);
      const after = visibleRows();
      expect(Number(after[0]?.slice(4))).toBe(Number(before[0]?.slice(4)) - 3);
      expect(after.at(-1)).toBe("ROW-076");
      app.transcript?.appendToLast("STREAM-NEW");
      await tick(200);
      expect(visibleRows()).toEqual(after);
      app.transcript?.appendToLast("\nSTREAM-NEXT");
      await tick(200);
      expect(visibleRows()).toEqual(after);
      app.stdin.write("\x1b[F");
      await tick(200);
      expect(app.frame()).toContain("STREAM-NEXT");
      expect(app.frame()).toContain("Спросите что-нибудь");
      expect(app.frame().trimEnd().split("\n").length).toBeLessThanOrEqual(20);
    } finally {
      app.unmount();
    }
  });

  test("shift wheel preserves direction and pager scrolls within a message", async () => {
    const app = await startApp(60, 20);
    try {
      app.transcript?.append(
        Array.from({ length: 80 }, (_, i) => `LINE-${i}`).join("\n"),
        "info",
      );
      await tick(200);
      const tail = app.frame();
      app.stdin.write("\x1b[<68;1;1M");
      await tick(200);
      expect(app.frame()).not.toContain("LINE-79");
      app.stdin.write("\x1b[<69;1;1M");
      await tick(200);
      expect(app.frame()).toBe(tail);
      app.stdin.write("\x0f");
      await tick(200);
      expect(app.frame()).toContain("LINE-79");
      app.stdin.write("\x1b[<64;1;1M");
      await tick(200);
      expect(app.frame()).toContain("LINE-76");
      expect(app.frame()).not.toContain("LINE-79");
      app.stdin.write("g");
      await tick(200);
      expect(app.frame()).toContain("ChiselCode");
    } finally {
      app.unmount();
    }
  });

  test("resize keeps the frame bounded and input on the last row", async () => {
    const app = await startApp(100, 30);
    try {
      app.transcript?.append(
        "中文 👩‍💻 длинный текст ".repeat(300),
        "assistant",
      );
      await tick(200);
      app.stdout.columns = 45;
      app.stdout.rows = 16;
      app.stdout.emit("resize");
      await tick(250);
      expect(app.frame().trimEnd().split("\n").length).toBeLessThanOrEqual(16);
      expect(app.frame()).not.toContain("test-model");
      expect(app.frame()).toContain("Спросите что-нибудь");
      app.stdin.write("x".repeat(3000));
      await tick(200);
      expect(app.frame().trimEnd().split("\n").length).toBeLessThanOrEqual(16);
      expect(app.frame().trimEnd().split("\n").at(-1)).toContain("Tab/");
      expect(app.frame()).toContain("█");
    } finally {
      app.unmount();
    }
  });

  test("classic mode transcript opens and returns to the draft", async () => {
    const app = await startApp(60, 20, { classic: true });
    try {
      app.stdin.write("draft");
      await tick(200);
      app.stdin.write("\x0f");
      await tick(200);
      expect(app.frame()).toContain("Транскрипт");
      app.stdin.write("q");
      await tick(200);
      expect(app.frame()).toContain("draft");
      expect(app.frame()).not.toContain("Транскрипт ·");
    } finally {
      app.unmount();
    }
  });

  test("startup prints the welcome block and pinned input", async () => {
    // Шапка — первое сообщение ленты: арт-логотип, мета, ввод снизу.
    const app = await startApp(100, 30);
    try {
      const text = app.chunks();
      for (const artLine of renderLogoRows()) expect(text).toContain(artLine);
      expect(text).toContain("test-model");
      expect(text).toContain("Спросите что-нибудь");
      expect(text).toContain("Shift+Enter");
      expect(text).not.toContain("колесо");
    } finally {
      app.unmount();
    }
  });

  test("welcome is the first message with no pinned duplicate", async () => {
    // Регрессия скриншота: закреплённая шапка дублировала welcome
    // (заголовок сверху + тот же арт/мета снизу) с пустотой между ними.
    // Шапка — первое сообщение ленты и всё: в арт-режиме слим-заголовка
    // `</> ChiselCode` нет вообще, арт и ввод на месте.
    // (Замер зазора тут бессмыслен: кадры alt-screen фиксированной высоты
    // добиваются пустыми строками по дизайну, в debug они копятся.)
    const app = await startApp(100, 30);
    try {
      const text = app.chunks();
      for (const artLine of renderLogoRows()) expect(text).toContain(artLine);
      expect(text).not.toContain("</> ChiselCode");
      expect(text).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("narrow window falls back to the slim welcome title", async () => {
    // Окно уже логотипа (76 клеток): вместо арта — слим-строка.
    expect(LOGO_WIDTH).toBe(76);
    const app = await startApp(60, 20);
    try {
      const text = app.chunks();
      expect(text).toContain("</> ChiselCode");
      expect(text).toContain("test-model");
      expect(text).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("history stays in viewport in order, newest last", async () => {
    // Fullscreen alt-screen: лента — срез с привязкой к низу,
    // раннее выше позднего. Высокое окно чтобы вьюпорт всё вместил.
    const app = await startApp(100, 60);
    try {
      for (let i = 0; i < 30; i += 1) {
        app.transcript?.append(`строка истории номер ${i}`, "info");
      }
      await tick(150);
      const text = app.chunks();
      const artIndex = text.indexOf(renderLogoRows()[0] ?? "");
      const firstIndex = text.indexOf("строка истории номер 0");
      const lastIndex = text.indexOf("строка истории номер 29");
      expect(artIndex).toBeGreaterThanOrEqual(0);
      expect(firstIndex).toBeGreaterThan(artIndex);
      expect(lastIndex).toBeGreaterThan(firstIndex);
      expect(text).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("pgup pins the viewport, new lines wait quietly", async () => {
    // Скролл вверх ставит вид на паузу без счётчиков: новые строки
    // копятся скрытыми, PgDn возвращает к живому краю.
    const app = await startApp(100, 30);
    try {
      for (let i = 0; i < 30; i += 1) {
        app.transcript?.append(`строка истории номер ${i}`, "info");
      }
      await tick(150);
      app.stdin.write("\x1b[5~");
      await tick(300);
      app.transcript?.append("самая новая строка", "info");
      await tick(300);
      // Вид стоит на месте: новейшей строки не видно, пилюли нет.
      expect(app.chunks()).not.toContain("самая новая строка");
      expect(app.chunks()).not.toContain("новых");
      // Шаг PgDn — пол-экрана (10 при 30 строках): скрыто было 11,
      // поэтому два PgDn чтобы вернуться к живому краю.
      app.stdin.write("\x1b[6~");
      await tick(300);
      app.stdin.write("\x1b[6~");
      await tick(300);
      expect(app.chunks()).toContain("самая новая строка");
    } finally {
      app.unmount();
    }
  });

  test("home shows the head of the feed instead of a blank screen", async () => {
    // Регрессия чёрного экрана: срез [0,0) давал пустой вьюпорт вместо шапки.
    // Высокое окно чтобы голова целиком влезла в кадр.
    const app = await startApp(100, 60);
    try {
      for (let i = 0; i < 30; i += 1) {
        app.transcript?.append(`строка истории номер ${i}`, "info");
      }
      await tick(150);
      app.stdin.write("\x1b[H");
      await tick(300);
      const text = app.chunks();
      for (const artLine of renderLogoRows()) expect(text).toContain(artLine);
      expect(text).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("mixed markdown feed keeps the tail visible while following", async () => {
    // Живой сценарий из репорта: юзер + ответ с кодом и списком + шум.
    // Хвост с точной сметой обязан показать код целиком и свежие строки,
    // ничего не обрезав снизу.
    const app = await startApp(100, 40);
    try {
      app.transcript?.append("❯ объясни код", "user");
      app.transcript?.append(
        "Вот разбор:\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\n- раз\n- два",
        "assistant",
      );
      for (let i = 0; i < 20; i += 1) {
        app.transcript?.append(`строка ${i}`, "info");
      }
      await tick(200);
      const text = app.chunks();
      expect(text).toContain("const x = 1;");
      expect(text).toContain("const y = 2;");
      expect(text).toContain("строка 19");
      expect(text).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("classic conhost prints welcome once with input below", async () => {
    // Legacy conhost: Static дописывается в scrollback, перерисовок нет —
    // шапка первым сообщением, ввод сразу под ней, дублей и пустот нет.
    const app = await startApp(100, 30, { classic: true });
    try {
      const text = app.chunks();
      for (const artLine of renderLogoRows()) expect(text).toContain(artLine);
      expect(text).not.toContain("</> ChiselCode");
      expect(text).toContain("test-model");
      expect(text).toContain("Спросите что-нибудь");
      // История дописывается следом, порядок прямой.
      app.transcript?.append("первая строка", "info");
      await tick(150);
      app.transcript?.append("вторая строка", "info");
      await tick(150);
      const after = app.chunks();
      expect(after.indexOf("первая строка")).toBeLessThan(
        after.indexOf("вторая строка"),
      );
    } finally {
      app.unmount();
    }
  });

  test("ctrl-o opens the transcript overlay and q goes back", async () => {
    // Как у Claude: Ctrl+O — полноэкранный просмотр вместо чата,
    // q — назад к вводу (черновик цел, лента на месте).
    const app = await startApp(100, 30);
    try {
      app.transcript?.append("какая-то история", "info");
      await tick(150);
      expect(app.chunks()).not.toContain("Транскрипт");
      app.stdin.write("\x0f");
      await tick(300);
      expect(app.chunks()).toContain("Транскрипт");
      app.stdin.write("q");
      await tick(300);
      expect(app.chunks()).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("wheel scrolls the feed without typing into input", async () => {
    // SGR-колесо (как шлёт терминал с 1006): вверх ставит вид на паузу
    // без счётчиков, последовательность в редактор не попадает.
    const app = await startApp(100, 30);
    try {
      for (let i = 0; i < 30; i += 1) {
        app.transcript?.append(`строка истории номер ${i}`, "info");
      }
      await tick(150);
      app.stdin.write("[<64;1;1M");
      await tick(300);
      app.transcript?.append("самая новая строка", "info");
      await tick(300);
      expect(app.chunks()).not.toContain("самая новая строка");
      // Мусора SGR в поле ввода нет.
      expect(app.chunks()).not.toContain("[<64");
    } finally {
      app.unmount();
    }
  });

  test("typed prompt is submitted with Enter", async () => {
    let submitted: string | undefined;
    const app = await startApp(100, 30, {
      onSubmit: async (prompt: string) => {
        submitted = prompt;
      },
    });
    try {
      for (const ch of "сделай дело") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      expect(submitted).toBe("сделай дело");
      // Ввод виден в поле (эхо), пустой ввод не отправляется.
      expect(app.chunks()).toContain("сделай дело");
    } finally {
      app.unmount();
    }
  });

  test("input stays visible while busy and follow-ups queue up", async () => {
    // Как в Claude Code: ввод зафиксирован внизу и не исчезает в работе
    // (спиннер — отдельной строкой), а Enter во время работы встаёт
    // в очередь и уходит следующим по порядку.
    const submitted: string[] = [];
    let releaseCurrent = (): void => {};
    const app = await startApp(100, 30, {
      onSubmit: async (prompt: string) => {
        submitted.push(prompt);
        await new Promise<void>((resolve) => {
          releaseCurrent = resolve;
        });
      },
    });
    try {
      for (const ch of "первая") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      expect(submitted).toEqual(["первая"]);
      // Агент занят, но поле ввода на месте, спиннер — отдельно.
      expect(app.chunks()).toContain("Думаю");
      expect(app.chunks()).toContain("Спросите что-нибудь");
      // Второй Enter во время работы — в очередь, агент его ещё не видел.
      for (const ch of "вторая") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      expect(submitted).toEqual(["первая"]);
      expect(app.chunks()).toContain("В очереди (1)");
      // Агент закончил первую — вторая ушла сама, порядок сохранён.
      releaseCurrent();
      await tick(500);
      expect(submitted).toEqual(["первая", "вторая"]);
    } finally {
      try {
        releaseCurrent();
      } catch {
        // Уже отпущен — нечего освобождать.
      }
      app.unmount();
    }
  });

  test("streaming chunks stay in one assistant line", async () => {
    // Регрессия скрина: первый чанк через append рвал ответ —
    // одиночные "I"/"The" отдельными строками. Теперь весь onText
    // идёт через appendToLast в одну незавершённую строку.
    const app = await startApp(100, 30);
    try {
      app.transcript?.appendToLast("I");
      await tick(100);
      app.transcript?.appendToLast(" need to understand");
      await tick(100);
      app.transcript?.appendToLast(" what you mean.");
      await tick(200);
      const text = app.chunks();
      expect(text).toContain("I need to understand what you mean.");
      // Инструмент коммитит стриминг, следующий текст — новая строка.
      app.transcript?.append("[chisel] read_file README.txt", "tool");
      await tick(100);
      app.transcript?.appendToLast("The file says hello.");
      await tick(200);
      const after = app.chunks();
      expect(after).toContain("I need to understand what you mean.");
      expect(after).toContain("The file says hello.");
    } finally {
      app.unmount();
    }
  });

  test("skill slash command expands and runs with short echo", async () => {
    // Пользовательский навык из ChiselCode Home: инструкции из SKILL.md,
    // а в журнале виден короткий `/имя args`.
    const root = await mkdtemp(join(tmpdir(), "chiselcode-tui-cmd-"));
    const restore = await prepareUserSkill(
      root,
      "hello",
      "---\nname: hello\ndescription: Поздороваться\n---\nСкажи $ARGUMENTS громко\n",
    );
    let submitted: { prompt: string; display?: string } | undefined;
    const app = await startApp(100, 30, {
      cwd: root,
      onSubmit: async (prompt: string, display?: string) => {
        submitted = { prompt, display };
      },
    });
    try {
      for (const ch of "/hello world") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      expect(submitted?.prompt).toBe("Скажи world громко");
      expect(submitted?.display).toBe("/hello world");
      expect(app.chunks()).toContain("❯ /hello world");
      expect(app.chunks()).not.toContain("Скажи world громко");
    } finally {
      app.unmount();
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skills browser lists skills and opens details", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-tui-skills-"));
    const restore = await prepareUserSkill(
      root,
      "hello",
      "---\nname: hello\ndescription: Поздороваться\n---\nСкажи привет\n",
    );
    const app = await startApp(100, 30, { cwd: root });
    try {
      for (const ch of "/skills") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      expect(app.chunks()).toContain("◈ Скиллы");
      expect(app.chunks()).toContain("/hello");
      expect(app.chunks()).toContain("Поздороваться");
      // Enter — детали скилла с инструкциями.
      app.stdin.write("\r");
      await tick(300);
      expect(app.chunks()).toContain("Скажи привет");
      // Esc — назад к списку, второй Esc — закрыть браузер.
      app.stdin.write("\x1b");
      await tick(200);
      app.stdin.write("\x1b");
      await tick(200);
      expect(app.chunks()).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skills browser toggles activation into the next request", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-tui-active-"));
    const restore = await prepareUserSkill(
      root,
      "hello",
      "---\nname: hello\ndescription: Поздороваться\n---\nСкажи привет\n",
    );
    const prompts: { prompt: string; display?: string }[] = [];
    const app = await startApp(100, 30, {
      cwd: root,
      onSubmit: async (prompt: string, display?: string) => {
        prompts.push({ prompt, display });
      },
    });
    try {
      for (const ch of "/skills") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      // Enter — детали, Enter — задействовать.
      app.stdin.write("\r");
      await tick(200);
      app.stdin.write("\r");
      await tick(200);
      expect(app.chunks()).toContain("задействован");
      app.stdin.write("\x1b");
      await tick(200);
      app.stdin.write("\x1b");
      await tick(200);
      // Панель закрыта — видна инфо-строка о задействовании.
      expect(app.chunks()).toContain("◈ Скилл /hello задействован");
      for (const ch of "сделай дело") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.prompt).toContain("◈ Активные скиллы: /hello");
      expect(prompts[0]?.prompt).toContain("Скажи привет");
      expect(prompts[0]?.prompt.endsWith("сделай дело")).toBe(true);
      expect(prompts[0]?.display).toBeUndefined();
      // В журнале — только короткий запрос, без инструкций.
      expect(app.chunks()).toContain("❯ сделай дело");
      // Отключаем: следующий запрос идёт чистым.
      for (const ch of "/skills") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      app.stdin.write("\r");
      await tick(200);
      app.stdin.write("\r");
      await tick(200);
      app.stdin.write("\x1b");
      await tick(200);
      app.stdin.write("\x1b");
      await tick(200);
      // Панель закрыта — видна инфо-строка об отключении.
      expect(app.chunks()).toContain("◈ Скилл /hello отключён");
      for (const ch of "второй") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]?.prompt).toBe("второй");
    } finally {
      app.unmount();
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hidden skills are not slash commands", async () => {
    // Скилл с user-invocable: false не выполняется как /имя,
    // но остаётся в каталоге и браузере.
    const root = await mkdtemp(join(tmpdir(), "chiselcode-tui-hidden-"));
    const dir = join(root, ".chisel", "skills", "secret");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: secret\ndescription: Скрытый\nuser-invocable: false\n---\nСекрет\n",
    );
    const app = await startApp(100, 30, { cwd: root });
    try {
      for (const ch of "/secret") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      expect(app.chunks()).toContain("Неизвестная команда: /secret");
    } finally {
      app.unmount();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unknown command hints the closest match", async () => {
    // Enter больше не дополняет префикс молча: опечатка уходит в ошибку
    // с подсказкой «возможно, вы имели в виду».
    let submitted: string | undefined;
    const app = await startApp(100, 30, {
      onSubmit: async (prompt: string) => {
        submitted = prompt;
      },
    });
    try {
      for (const ch of "/sessons") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      expect(submitted).toBeUndefined();
      expect(app.chunks()).toContain("Возможно, вы имели в виду /sessions?");
    } finally {
      app.unmount();
    }
  });

  test("arrows select suggestion like Claude Code, tab/enter accepts", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-tui-tab-"));
    const restore = await prepareUserSkill(
      root,
      "salsa",
      "---\nname: salsa\ndescription: Танцевать\n---\nТанцуй $ARGUMENTS\n",
    );
    let submitted: { prompt: string; display?: string } | undefined;
    const app = await startApp(100, 30, {
      cwd: root,
      onSubmit: async (prompt: string, display?: string) => {
        submitted = { prompt, display };
      },
    });
    try {
      for (const ch of "/s") {
        app.stdin.write(ch);
        await tick(20);
      }
      // Даём состоянию ввода закоммититься (троттлинг рендера Ink иначе
      // подставит Tab в устаревший список подсказок).
      await tick(300);
      // /s: settings, skills, status, sessions, salsa. Четыре ↓ — до salsa.
      for (let i = 0; i < 4; i += 1) {
        app.stdin.write("\x1b[B");
        await tick(150);
      }
      app.stdin.write("\t");
      await tick(200);
      app.stdin.write("\r");
      await tick(400);
      expect(submitted?.display).toBe("/salsa");
      expect(submitted?.prompt).toContain("Танцуй");
    } finally {
      app.unmount();
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bracketed multi-line paste stays in the draft until Enter", async () => {
    let submitted: string | undefined;
    const app = await startApp(100, 30, {
      onSubmit: async (prompt) => {
        submitted = prompt;
      },
    });
    try {
      await tick(100);
      app.stdin.write("\x1b[200~первая строка\r\nвторая строка\x1b[201~");
      await tick(200);
      expect(submitted).toBeUndefined();
      app.stdin.write("\r");
      await tick(200);
      expect(submitted).toBe("первая строка\nвторая строка");
    } finally {
      app.unmount();
    }
  });

  test("enter on prefix accepts highlighted command instead of error", async () => {
    const app = await startApp(100, 30);
    try {
      for (const ch of "/set") {
        app.stdin.write(ch);
        await tick(20);
      }
      await tick(300);
      // Первый Enter — принять /settings (без отправки и без ошибки).
      app.stdin.write("\r");
      await tick(300);
      expect(app.chunks()).not.toContain("Неизвестная команда");
      expect(app.chunks()).toContain("/settings");
    } finally {
      app.unmount();
    }
  });

  test("suggestion list is capped with an overflow counter", async () => {
    // Голое "/" даёт все 13+ команд: видно максимум 6 строк и счётчик.
    const app = await startApp(100, 30);
    try {
      app.stdin.write("/");
      await tick(300);
      const text = app.chunks();
      expect(text).toContain("…и ещё ");
      expect(text).toContain("/help");
    } finally {
      app.unmount();
    }
  });
});
