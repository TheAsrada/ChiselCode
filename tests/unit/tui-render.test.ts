import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import { LOGO_WIDTH, renderLogoRows } from "../../src/ui/logo.js";
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
  unmount(): void;
}

async function startApp(
  columns: number,
  rows: number,
  hooks?: {
    cwd?: string;
    onSubmit?: (prompt: string, display?: string) => Promise<void>;
  },
): Promise<Harness> {
  const stdout = createMockStdout(columns, rows);
  const stdin = createMockStdin();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
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
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      // debug: Ink пишет каждый кадр статичным текстом без кодов
      // перерисовки — одинаково локально и в CI, где интерактивный
      // режим отключён и кадры иначе не прочитать из потока.
      debug: true,
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
    unmount: () => instance.unmount(),
  };
}

describe("tui scrollback render", () => {
  test("startup prints the welcome block, status line and input", async () => {
    // Стартовый блок как в classic-режиме Claude Code: арт-логотип, мета,
    // подсказки — печатается один раз и дальше уплывает вверх с диалогом.
    const app = await startApp(100, 30);
    try {
      const text = app.chunks();
      for (const artLine of renderLogoRows()) expect(text).toContain(artLine);
      expect(text).toContain("test-model");
      // Статус-строка над вводом: модель и проект видны всегда,
      // даже когда стартовый блок уплыл из вида.
      expect(text).toContain("Спросите что-нибудь");
      expect(text).toContain("Shift+Enter");
      expect(text).not.toContain("колесо");
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

  test("history stays in scrollback in order, newest last", async () => {
    // Нативный scrollback вместо кастомного окна: раннее напечатанное
    // остаётся выше позднего, шапка-арт — самой первой.
    const app = await startApp(100, 30);
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
    // Скилл из .chisel/skills: выполняются инструкции из SKILL.md,
    // а в журнале виден короткий `/имя args`.
    const root = await mkdtemp(join(tmpdir(), "chiselcode-tui-cmd-"));
    const dir = join(root, ".chisel", "skills", "hello");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
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
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skills browser lists skills and opens details", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-tui-skills-"));
    const dir = join(root, ".chisel", "skills", "hello");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
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
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skills browser toggles activation into the next request", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-tui-active-"));
    const dir = join(root, ".chisel", "skills", "hello");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
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
    const dir = join(root, ".chisel", "skills", "salsa");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
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
      await rm(root, { recursive: true, force: true });
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
