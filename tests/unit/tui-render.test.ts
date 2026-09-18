import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";
import {
  createTuiApprovalResolver,
  syncTerminalSizeToStdout,
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

function visualWidth(line: string): number {
  return Array.from(line).length;
}

const tick = (ms = 60): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Режет строки по границам склеенных кадров: в debug-режиме конец одного
 * кадра и начало следующего идут без перевода строки, и следующий кадр
 * всегда начинается с перепечатки Static — то есть с маркера шапки.
 */
function unglued(lines: string[]): string[] {
  return lines.flatMap((line) => line.split("◈ ChiselCode"));
}

interface Harness {
  stdin: MockStdin;
  stdout: MockStdout;
  transcript?: TuiTranscript;
  chunks(): string;
  /** Сырой вывод без чистки ANSI: для управляющих кодов (очистка экрана). */
  raw(): string;
  /** Весь вывод построчно. */
  lines(): string[];
  /**
   * Строки последнего записанного кадра. В debug-режиме Ink пишет кадр
   * одним stdout.write: это единственный способ увидеть целостный кадр —
   * склейка всего вывода рвётся на переходных рендерах (stale-пропсы
   * + свежий Yoga-рут), которых в живом терминале не видно.
   * Расклеиваем по маркеру: следующий кадр всегда начинается
   * с перепечатки Static, то есть с шапки бренда.
   */
  lastWrite(): string[];
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
  const writes: string[] = [];
  stdout.on("data", (chunk) => {
    output += chunk.toString();
    writes.push(chunk.toString());
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
    raw: () => output,
    lines: () => stripAnsi(output).split("\n"),
    lastWrite: () => unglued(stripAnsi(writes.at(-1) ?? "").split("\n")),
    unmount: () => instance.unmount(),
  };
}

describe("tui fullscreen render", () => {
  test("idle output prints brand header once with input below", async () => {
    const app = await startApp(100, 30);
    try {
      await tick(150);
      const text = app.chunks();
      // Шапка бренда печатается при старте; прибитого хедера больше нет,
      // контекст живёт в scrollback. В debug-режиме Ink дублирует Static
      // при каждом ре-рендере — считаем не копии, а наличие и порядок.
      expect(text).toContain("◈ ChiselCode");
      expect(text).toContain("Anthropic (Claude)");
      expect(text).toContain("test-model");
      // Разделитель шапки — во всю ширину окна.
      expect(text).toContain("─".repeat(100));
      for (const line of unglued(app.lines())) {
        expect(visualWidth(line)).toBeLessThanOrEqual(100);
      }
      // Поле ввода — в конце вывода.
      const bottom = app.lines().slice(-6).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
      expect(bottom).toContain("Enter — отправить");
    } finally {
      app.unmount();
    }
  });

  test("fullscreen output keeps brand header with input below", async () => {
    const app = await startApp(200, 60);
    try {
      await tick(150);
      const text = app.chunks();
      expect(text).toContain("◈ ChiselCode");
      for (const line of unglued(app.lines())) {
        expect(visualWidth(line)).toBeLessThanOrEqual(200);
      }
      const bottom = app.lines().slice(-6).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("output adapts after window resize without overflow", async () => {
    const app = await startApp(100, 30);
    try {
      const before = new Set(app.lines());
      app.stdout.columns = 60;
      app.stdout.rows = 20;
      app.stdout.emit("resize");
      await tick(150);
      // Один символ ввода — гарантированно свежий кадр с новым размером.
      // Старый Static не переформатируется (норма scrollback) — его строки,
      // совпадающие с доресайзными, исключаем.
      app.stdin.write("z");
      await tick(200);
      const frame = app.lastWrite();
      expect(frame.join("\n")).toContain("Enter — отправить");
      const fresh = frame.filter((line) => !before.has(line));
      expect(fresh.length).toBeGreaterThan(0);
      for (const line of fresh) {
        expect(visualWidth(line)).toBeLessThanOrEqual(60);
      }
    } finally {
      app.unmount();
    }
  });

  test("output survives rapid shrink-grow without overflow", async () => {
    // Регрессия искажения при ресайзе: свежие кадры динамической зоны
    // никогда не шире живого окна — иначе терминал переносит длинные
    // строки сам. Уже напечатанная история не переформатируется
    // (нормально для scrollback) — её строки исключаем по совпадению.
    // Кадр берём последним записанным: склейка всего вывода рвётся
    // на переходных рендерах, которых в живом терминале не видно.
    const app = await startApp(100, 30);
    try {
      for (let i = 0; i < 20; i += 1) {
        app.transcript?.append(
          `длинная строка истории номер ${i} для проверки переоборачивания при изменении ширины окна терминала`,
          "info",
        );
      }
      await tick(150);
      const beforeNarrow = new Set(app.lines());
      app.stdout.columns = 60;
      app.stdout.rows = 20;
      app.stdout.emit("resize");
      await tick(150);
      app.stdin.write("z");
      await tick(200);
      const narrowFrame = app.lastWrite();
      expect(narrowFrame.join("\n")).toContain("Enter — отправить");
      const narrowFresh = narrowFrame.filter((line) => !beforeNarrow.has(line));
      expect(narrowFresh.length).toBeGreaterThan(0);
      for (const line of narrowFresh) {
        expect(visualWidth(line)).toBeLessThanOrEqual(60);
      }
      const beforeWide = new Set(app.lines());
      app.stdout.columns = 120;
      app.stdout.rows = 40;
      app.stdout.emit("resize");
      await tick(150);
      app.stdin.write("y");
      await tick(200);
      const wideFrame = app.lastWrite();
      expect(wideFrame.join("\n")).toContain("Enter — отправить");
      const wideFresh = wideFrame.filter((line) => !beforeWide.has(line));
      expect(wideFresh.length).toBeGreaterThan(0);
      for (const line of wideFresh) {
        expect(visualWidth(line)).toBeLessThanOrEqual(120);
      }
    } finally {
      app.unmount();
    }
  });

  test("long history prints every line once with input below", async () => {
    // Scrollback-модель: каждая запись уходит в Static и остаётся в выводе
    // навсегда; пейджинга клавишами больше нет — это делает сам терминал.
    // В debug-режиме кадры дублируют Static, поэтому проверяем наличие
    // всех записей по порядку, а не число копий.
    const app = await startApp(80, 24);
    try {
      for (let i = 0; i < 50; i += 1) {
        app.transcript?.append(`строка истории номер ${i}`, "info");
      }
      await tick(150);
      for (const line of unglued(app.lines())) {
        expect(visualWidth(line)).toBeLessThanOrEqual(80);
      }
      const text = app.chunks();
      let pos = -1;
      for (let i = 0; i < 50; i += 1) {
        const next = text.indexOf(`строка истории номер ${i}`, pos + 1);
        expect(next).toBeGreaterThan(pos);
        pos = next;
      }
      const bottom = app.lines().slice(-6).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
      expect(bottom).toContain("Enter — отправить");
    } finally {
      app.unmount();
    }
  });

  test("narrow window with long history drops no lines", async () => {
    const app = await startApp(60, 20);
    try {
      for (let i = 0; i < 50; i += 1) {
        app.transcript?.append(`строка истории номер ${i}`, "info");
      }
      await tick(150);
      for (const line of unglued(app.lines())) {
        expect(visualWidth(line)).toBeLessThanOrEqual(60);
      }
      const text = app.chunks();
      let pos = -1;
      for (let i = 0; i < 50; i += 1) {
        const next = text.indexOf(`строка истории номер ${i}`, pos + 1);
        expect(next).toBeGreaterThan(pos);
        pos = next;
      }
      const bottom = app.lines().slice(-8).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("narrow window wraps long error lines without overflow", async () => {
    const app = await startApp(60, 20);
    try {
      app.transcript?.append(
        'Anthropic API error (503): 503 {"error":{"code":"model_not_found","message":"No available channel for model gpt-5-6-sol under group default (distributor) (request id: 20260913074845429824002868d9d60KCSdWH1)","type":"new_api_error"}}',
        "error",
      );
      await tick(150);
      const text = app.chunks();
      expect(text).toContain("model_not_found");
      for (const line of unglued(app.lines())) {
        expect(visualWidth(line)).toBeLessThanOrEqual(60);
      }
      const bottom = app.lines().slice(-6).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("clear wipes the terminal and restarts history from brand", async () => {
    // Static-вывод уже ушёл в scrollback: одного сброса стейта мало —
    // /clear пишет настоящую очистку терминала и перемонтирует Static
    // новым ключом (схлопнувшийся массив Ink иначе молчит навсегда).
    const app = await startApp(80, 24);
    try {
      for (let i = 0; i < 5; i += 1) {
        app.transcript?.append(`строка истории номер ${i}`, "info");
      }
      await tick(150);
      expect(app.chunks()).toContain("строка истории номер 4");
      for (const ch of "/clear") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      // Очистка реально ушла в stdout (сырой вывод, ANSI не чистим).
      expect(app.raw()).toContain("2J");
      // В debug-режиме кадры дублируют Static, поэтому про «не
      // перепечаталось» судим по порядку: последнее появление новой
      // записи — строго после последнего появления старой.
      const grown = app.chunks();
      expect(grown).toContain("◈ ChiselCode");
      expect(grown).toContain("Экран очищен.");
      expect(grown.lastIndexOf("Экран очищен.")).toBeGreaterThan(
        grown.lastIndexOf("строка истории номер 4"),
      );
      // Новые записи печатаются как обычно.
      app.transcript?.append("строка истории номер 100", "info");
      await tick(150);
      const tail = app.chunks();
      expect(tail.lastIndexOf("строка истории номер 100")).toBeGreaterThan(
        tail.lastIndexOf("Экран очищен."),
      );
      expect(app.chunks()).toContain("Спросите что-нибудь");
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
      expect(app.lines().slice(-6).join("\n")).toContain("Спросите что-нибудь");
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

  test("frame recovers from lost resize event without input", async () => {
    // Регрессия «съезжания» при fullscreen/resize на Windows: событие
    // resize ОС потеряно (conhost/Bun его часто не шлёт) и ввода нет —
    // кадр обязан сам перестроиться по опросу живого размера, а не висеть
    // кривым до первой нажатой клавиши. Симулируем именно потерю события:
    // живой сисколл getWindowSize() уже отдаёт новый размер, а emit
    // 'resize' никто не делает и в stdin ничего не пишем.
    //
    // Важно: тихий синхрон пути рендера (TuiApp, emitResize=false) уже
    // прописал новый размер в stdout.columns БЕЗ эмита — как бывает при
    // любом конкурентном рендере до тика опроса. Старый код после этого
    // видел changed=false и НЕ уведомлял Ink вообще (корень Yoga и счётчики
    // строк log-update оставались stale — визуальное «съезжание» на живом
    // терминале, которое в debug-моках не видно, там нет erase-логики).
    // Новый код уведомляет по ref-флагу последнего уведомлённого размера,
    // а не по сравнению с полями TTY — эмит обязан произойти.
    const realStdout = process.stdout as unknown as {
      getWindowSize?: () => [number, number];
      columns?: number;
      rows?: number;
      emit?: (event: string) => boolean;
    };
    const hadGetWindowSize = typeof realStdout.getWindowSize === "function";
    const prevGetWindowSize = realStdout.getWindowSize;
    const prevColumns = realStdout.columns;
    const prevRows = realStdout.rows;
    const prevEmit = realStdout.emit?.bind(realStdout) as
      | ((event: string, ...args: unknown[]) => boolean)
      | undefined;
    let liveColumns = 100;
    let liveRows = 30;
    let resizeEmits = 0;
    realStdout.getWindowSize = () => [liveColumns, liveRows];
    realStdout.emit = ((event: string, ...args: unknown[]) => {
      if (event === "resize") resizeEmits += 1;
      return prevEmit?.(event, ...args) ?? false;
    }) as typeof realStdout.emit;
    const app = await startApp(100, 30);
    try {
      // Стартовый вывод: шапка бренда один раз + ввод.
      expect(app.chunks()).toContain("◈ ChiselCode");
      // Счётчик эмитов сбрасываем после монтирования: дальше считаем только
      // уведомления, вызванные самим ресайзом.
      resizeEmits = 0;
      // Окно сузили, событие потеряно; конкурентный рендер уже тихо
      // протолкнул новый размер в stdout.columns без эмита.
      liveColumns = 60;
      liveRows = 20;
      syncTerminalSizeToStdout(false);
      // Свежие кадры влезают в новое окно, ввод на месте. Старый Static
      // не переформатируется (норма scrollback) — смотрим только новое:
      // строки, которых не было до ресайза.
      // Свежие кадры влезают в новое окно, ввод на месте. Старый Static
      // не переформатируется (норма scrollback) — смотрим только новое:
      // строки, которых не было до ресайза.
      const before = new Set(app.lines());
      // Ждём тик опроса (VIEWPORT_POLL_MS) + перерисовку — без emit и ввода.
      await tick(900);
      // Опрос обязан уведомить Ink штатным путём resized() — иначе корень
      // Yoga и счётчики строк останутся stale навсегда (старый код: 0).
      expect(resizeEmits).toBeGreaterThanOrEqual(1);
      // Но без шторма: одно изменение — пара уведомлений максимум
      // (опрос + догоняющий эффект), а не цикл.
      expect(resizeEmits).toBeLessThanOrEqual(3);
      const healed = app.lastWrite().filter((line) => !before.has(line));
      for (const line of unglued(healed)) {
        expect(visualWidth(line)).toBeLessThanOrEqual(60);
      }
      const bottom = healed.slice(-6).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
      if (hadGetWindowSize) {
        realStdout.getWindowSize = prevGetWindowSize;
      } else {
        delete realStdout.getWindowSize;
      }
      realStdout.columns = prevColumns;
      realStdout.rows = prevRows;
      if (prevEmit !== undefined) realStdout.emit = prevEmit;
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
});
