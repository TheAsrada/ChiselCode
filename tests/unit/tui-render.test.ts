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

/** Первая строка каждого полного кадра — шапка приложения. */
const FRAME_MARKER = "◈ ChiselCode";

/** Номера «строка истории номер N», видимые в кадре, по порядку. */
function historyNumbers(frame: string[]): number[] {
  const result: number[] = [];
  for (const line of frame) {
    const match = /строка истории номер (\d+)/.exec(line);
    if (match?.[1] !== undefined) result.push(Number(match[1]));
  }
  return result;
}

const tick = (ms = 60): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  stdin: MockStdin;
  stdout: MockStdout;
  transcript?: TuiTranscript;
  chunks(): string;
  frame(rows: number): string[];
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
    /**
     * Последний полный кадр. В debug-режиме кадры идут друг за другом
     * сплошным текстом (последняя строка кадра склеена с шапкой
     * следующего), поэтому кадр вырезаем по маркеру первой строки —
     * он же первая строка каждого полного кадра.
     */
    frame: (frameRows: number) => {
      const text = stripAnsi(output);
      const parts = text.split(FRAME_MARKER);
      const lastFrameText = FRAME_MARKER + (parts.at(-1) ?? "");
      return lastFrameText.split("\n").slice(0, frameRows);
    },
    unmount: () => instance.unmount(),
  };
}

describe("tui fullscreen render", () => {
  test("idle frame fits the window and pins input to the bottom", async () => {
    const app = await startApp(100, 30);
    try {
      const frame = app.frame(30);
      expect(frame.length).toBe(30);
      for (const line of frame) {
        expect(visualWidth(line)).toBeLessThanOrEqual(100);
      }
      // Шапка сверху.
      expect(frame[0]).toContain("ChiselCode");
      // Разделитель шапки — во всю ширину окна.
      expect(visualWidth(frame[1] ?? "")).toBe(100);
      // Поле ввода — внизу кадра.
      const bottom = frame.slice(-6).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
      expect(bottom).toContain("PgUp/PgDn");
    } finally {
      app.unmount();
    }
  });

  test("fullscreen frame keeps header on top and input pinned", async () => {
    const app = await startApp(200, 60);
    try {
      const frame = app.frame(60);
      expect(frame.length).toBe(60);
      for (const line of frame) {
        expect(visualWidth(line)).toBeLessThanOrEqual(200);
      }
      // Шапка закреплена сверху даже в полном экране.
      expect(frame[0]).toContain("ChiselCode");
      expect(visualWidth(frame[1] ?? "")).toBe(200);
      const bottom = frame.slice(-6).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
      expect(bottom).toContain("PgUp/PgDn");
    } finally {
      app.unmount();
    }
  });

  test("frame adapts after window resize without overflow", async () => {
    const app = await startApp(100, 30);
    try {
      app.stdout.columns = 60;
      app.stdout.rows = 20;
      app.stdout.emit("resize");
      await tick();
      const frame = app.frame(20);
      expect(frame.length).toBe(20);
      for (const line of frame) {
        expect(visualWidth(line)).toBeLessThanOrEqual(60);
      }
      expect(frame[0]).toContain("ChiselCode");
      expect(visualWidth(frame[1] ?? "")).toBe(60);
      const bottom = frame.slice(-6).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("frame survives rapid shrink-grow without overflow", async () => {
    // Регрессия искажения при ресайзе: переходный кадр никогда не шире
    // живого окна — иначе терминал переносит длинные строки сам и весь
    // интерфейс «плывёт». Сужаем и тут же разворачиваем обратно: оба кадра
    // обязаны влезать в актуальное окно, шапка сверху, ввод снизу.
    const app = await startApp(100, 30);
    try {
      for (let i = 0; i < 20; i += 1) {
        app.transcript?.append(
          `длинная строка истории номер ${i} для проверки переоборачивания при изменении ширины окна терминала`,
          "info",
        );
      }
      await tick(150);
      app.stdout.columns = 60;
      app.stdout.rows = 20;
      app.stdout.emit("resize");
      await tick();
      const narrow = app.frame(20);
      expect(narrow.length).toBe(20);
      for (const line of narrow) {
        expect(visualWidth(line)).toBeLessThanOrEqual(60);
      }
      expect(narrow[0]).toContain("ChiselCode");
      expect(narrow.slice(-6).join("\n")).toContain("Спросите что-нибудь");
      app.stdout.columns = 120;
      app.stdout.rows = 40;
      app.stdout.emit("resize");
      await tick();
      const wide = app.frame(40);
      expect(wide.length).toBe(40);
      for (const line of wide) {
        expect(visualWidth(line)).toBeLessThanOrEqual(120);
      }
      expect(wide[0]).toContain("ChiselCode");
      expect(wide.slice(-6).join("\n")).toContain("Спросите что-нибудь");
    } finally {
      app.unmount();
    }
  });

  test("long history keeps input pinned and paging works", async () => {
    const app = await startApp(80, 24);
    try {
      for (let i = 0; i < 50; i += 1) {
        app.transcript?.append(`строка истории номер ${i}`, "info");
      }
      await tick(150);
      const frame = app.frame(24);
      expect(frame.length).toBe(24);
      for (const line of frame) {
        expect(visualWidth(line)).toBeLessThanOrEqual(80);
      }
      const bottom = frame.slice(-6).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
      // Самая свежая строка видна, старые скрыты за индикатором.
      expect(frame.join("\n")).toContain("строка истории номер 49");
      expect(frame.join("\n")).toContain("ещё");
      // Видимые строки идут подряд без дыр: Yoga не схлопывает строки.
      expect(historyNumbers(frame)).toEqual(
        Array.from(
          { length: historyNumbers(frame).length },
          (_, index) => (historyNumbers(frame)[0] ?? 0) + index,
        ),
      );

      // PageUp уходит вверх — появляется счётчик записей ниже.
      app.stdin.write("\x1b[5~");
      await tick(150);
      const up = app.frame(24).join("\n");
      expect(up).toContain("записей ниже");
      // PageDown несколько раз возвращается вниз, End — сразу вниз.
      app.stdin.write("\x1b[6~");
      await tick(150);
      app.stdin.write("\x1b[F");
      await tick(150);
      const down = app.frame(24);
      expect(down.join("\n")).toContain("строка истории номер 49");
      expect(down.join("\n")).not.toContain("записей ниже");
      // Esc тоже возвращает к вводу после прокрутки вверх.
      app.stdin.write("\x1b[5~");
      await tick(150);
      expect(app.frame(24).join("\n")).toContain("записей ниже");
      app.stdin.write("\x1b");
      await tick(150);
      expect(app.frame(24).join("\n")).toContain("строка истории номер 49");
    } finally {
      app.unmount();
    }
  });

  test("narrow window with long history drops no lines", async () => {
    // Регрессия: смета футера не учитывала перенос строки горячих клавиш,
    // Yoga схлопывал случайную строку истории в ноль (дыра в журнале).
    const app = await startApp(60, 20);
    try {
      for (let i = 0; i < 50; i += 1) {
        app.transcript?.append(`строка истории номер ${i}`, "info");
      }
      await tick(150);
      const frame = app.frame(20);
      expect(frame.length).toBe(20);
      for (const line of frame) {
        expect(visualWidth(line)).toBeLessThanOrEqual(60);
      }
      const numbers = historyNumbers(frame);
      expect(numbers.length).toBeGreaterThan(5);
      expect(numbers).toEqual(
        Array.from(
          { length: numbers.length },
          (_, index) => (numbers[0] ?? 0) + index,
        ),
      );
      expect(numbers.at(-1)).toBe(49);
      const bottom = frame.slice(-6).join("\n");
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
      const frame = app.frame(20);
      expect(frame.length).toBe(20);
      for (const line of frame) {
        expect(visualWidth(line)).toBeLessThanOrEqual(60);
      }
      const bottom = frame.slice(-6).join("\n");
      expect(bottom).toContain("Спросите что-нибудь");
      // Видимые строки истории идут подряд без дыр.
      expect(historyNumbers(frame)).toEqual(
        Array.from(
          { length: historyNumbers(frame).length },
          (_, index) => (historyNumbers(frame)[0] ?? 0) + index,
        ),
      );
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
      expect(app.frame(30).slice(-6).join("\n")).toContain(
        "Спросите что-нибудь",
      );
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
    // skill-creator из бандла: user-invocable false — /имя не выполняется,
    // но скилл остаётся в каталоге и браузере.
    const app = await startApp(100, 30);
    try {
      for (const ch of "/skill-creator") {
        app.stdin.write(ch);
        await tick(20);
      }
      app.stdin.write("\r");
      await tick(400);
      expect(app.chunks()).toContain("Неизвестная команда: /skill-creator");
    } finally {
      app.unmount();
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
      const initial = app.frame(30);
      expect(initial.length).toBe(30);
      expect(visualWidth(initial[1] ?? "")).toBe(100);
      // Счётчик эмитов сбрасываем после монтирования: дальше считаем только
      // уведомления, вызванные самим ресайзом.
      resizeEmits = 0;
      // Окно сузили, событие потеряно; конкурентный рендер уже тихо
      // протолкнул новый размер в stdout.columns без эмита.
      liveColumns = 60;
      liveRows = 20;
      syncTerminalSizeToStdout(false);
      const stale = app.frame(30);
      expect(visualWidth(stale[1] ?? "")).toBe(100);
      // Ждём тик опроса (VIEWPORT_POLL_MS) + перерисовку — без emit и ввода.
      await tick(900);
      // Опрос обязан уведомить Ink штатным путём resized() — иначе корень
      // Yoga и счётчики строк останутся stale навсегда (старый код: 0).
      expect(resizeEmits).toBeGreaterThanOrEqual(1);
      // Но без шторма: одно изменение — пара уведомлений максимум
      // (опрос + догоняющий эффект), а не цикл.
      expect(resizeEmits).toBeLessThanOrEqual(3);
      const healed = app.frame(20);
      expect(healed.length).toBe(20);
      for (const line of healed) {
        expect(visualWidth(line)).toBeLessThanOrEqual(60);
      }
      expect(healed[0]).toContain("ChiselCode");
      expect(visualWidth(healed[1] ?? "")).toBe(60);
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
