import { describe, expect, test } from "bun:test";
import {
  commandHelpText,
  isSlashInput,
  MAX_VISIBLE_SUGGESTIONS,
  matchingCommands,
  parseSlashCommand,
  suggestSimilarCommand,
} from "../../src/ui/commands.js";
import {
  addEditorHistory,
  backspaceEditorText,
  createEditorState,
  deleteEditorText,
  insertEditorText,
  isFirstEditorLine,
  isLastEditorLine,
  moveEditorCursor,
  navigateEditorHistory,
} from "../../src/ui/editor.js";
import {
  LOGO_TERM_ROWS,
  LOGO_WIDTH,
  renderLogoRows,
} from "../../src/ui/logo.js";
import {
  filterModelOptions,
  MAX_VISIBLE_MODELS,
  sortModelOptions,
} from "../../src/ui/settings.js";
import {
  ALT_SCREEN_MAX_RENDER_LINES,
  applyHideDelta,
  clampHideNewest,
  clampTop,
  computeFillRows,
  displayCellWidth,
  estimateLineRows,
  fitWindow,
  formatHeaderMeta,
  formatHeaderTitle,
  frameRows,
  fullWidthSeparator,
  HOTKEYS_HINT,
  headerSeparator,
  hideForVisual,
  liveWindowRows,
  nextPromptIndex,
  normalizeViewport,
  prevPromptIndex,
  promptLineIndices,
  scrollPageStep,
  searchMatchIndices,
  shortenHome,
  shouldUseAltScreen,
  shouldUseArtWelcome,
  sliceTranscript,
} from "../../src/ui/tui.js";

describe("interactive commands", () => {
  test("parses only known complete slash commands", () => {
    expect(parseSlashCommand(" /help ")).toEqual({ name: "/help", args: "" });
    expect(parseSlashCommand("/unknown")).toBeUndefined();
    expect(parseSlashCommand("/cwd C:\\projects\\demo")).toEqual({
      name: "/cwd",
      args: "C:\\projects\\demo",
    });
    expect(parseSlashCommand("/cwd")).toEqual({ name: "/cwd", args: "" });
    expect(isSlashInput(" /model")).toBe(true);
    expect(isSlashInput("объясни /model")).toBe(false);
  });

  test("filters suggestions and provides safe local help", () => {
    expect(matchingCommands("/s").map((command) => command.name)).toEqual([
      "/settings",
      "/skills",
      "/status",
      "/sessions",
    ]);
    expect(matchingCommands("/c").map((command) => command.name)).toEqual([
      "/clear",
      "/cwd",
    ]);
    expect(commandHelpText()).toContain("/settings");
    expect(commandHelpText()).toContain("/cwd");
    expect(commandHelpText()).toContain("Shift+Enter");
    expect(commandHelpText()).toContain("PgUp/PgDn");
  });

  test("suggests the closest command for typos", () => {
    expect(MAX_VISIBLE_SUGGESTIONS).toBe(6);
    // Транспозиция (2 правки) и пропущенная буква (1 правка).
    expect(suggestSimilarCommand("/sessons")).toBe("/sessions");
    expect(suggestSimilarCommand("/setings")).toBe("/settings");
    expect(suggestSimilarCommand("/hlep")).toBe("/help");
    expect(suggestSimilarCommand("/help")).toBe("/help");
    // Чушь без похожих вариантов — молчим, а не гадаем.
    expect(suggestSimilarCommand("/zzz")).toBeUndefined();
    expect(suggestSimilarCommand("/")).toBeUndefined();
    expect(suggestSimilarCommand("  ")).toBeUndefined();
    // Свои команды тоже участвуют.
    expect(
      suggestSimilarCommand("/revie", [{ name: "review", description: "" }]),
    ).toBe("/review");
  });
});

describe("interactive editor", () => {
  test("edits text at the cursor", () => {
    let state = createEditorState();
    state = insertEditorText(state, "abcd");
    state = moveEditorCursor(state, -1);
    state = moveEditorCursor(state, -1);
    state = insertEditorText(state, "X");
    expect(state.value).toBe("abXcd");
    state = backspaceEditorText(state);
    expect(state.value).toBe("abcd");
    state = deleteEditorText(state);
    expect(state.value).toBe("abd");
  });

  test("preserves a draft while navigating prompt history", () => {
    let state = createEditorState();
    state = addEditorHistory(state, "первая задача");
    state = addEditorHistory(state, "вторая задача");
    state = insertEditorText(state, "черновик");
    state = navigateEditorHistory(state, -1);
    expect(state.value).toBe("вторая задача");
    state = navigateEditorHistory(state, -1);
    expect(state.value).toBe("первая задача");
    state = navigateEditorHistory(state, 1);
    state = navigateEditorHistory(state, 1);
    expect(state.value).toBe("черновик");
  });

  test("recognizes first and last multiline editor lines", () => {
    let state = createEditorState();
    state = insertEditorText(state, "первая\nвторая");
    expect(isFirstEditorLine(state)).toBe(false);
    expect(isLastEditorLine(state)).toBe(true);
    state = moveEditorCursor(state, -1);
    state = moveEditorCursor(state, -1);
    state = moveEditorCursor(state, -1);
    state = moveEditorCursor(state, -1);
    state = moveEditorCursor(state, -1);
    state = moveEditorCursor(state, -1);
    state = moveEditorCursor(state, -1);
    expect(isFirstEditorLine(state)).toBe(true);
    expect(isLastEditorLine(state)).toBe(false);
  });
});

describe("alt-screen header", () => {
  test("slim title and separator are plain single-line strings", () => {
    // Слим-вариант стартового блока (узкие окна): плоский текст и разделитель
    // ровно во всю ширину — без анимации и разноцветности.
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = "/home/tester";
      delete process.env.USERPROFILE;
      expect(
        formatHeaderTitle({
          model: "test-model",
          cwd: "/tmp/x",
          version: "0.5.17",
        }),
      ).toBe("</> ChiselCode · test-model · /tmp/x · v0.5.17");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
    }
    expect(formatHeaderTitle({ model: "m" })).toBe("</> ChiselCode · m");
    expect(formatHeaderTitle({ model: "  ", cwd: "  " })).toBe(
      "</> ChiselCode",
    );
    for (const columns of [20, 60, 80, 100, 200]) {
      const line = headerSeparator(columns);
      expect([...line].length).toBe(columns);
      expect(line).toBe("─".repeat(columns));
      expect(fullWidthSeparator(columns)).toBe(line);
    }
  });

  test("TAAG logo is embedded literally with exact geometry", () => {
    // ASCII-арт `<i>ChiselCode`, шрифт Coder Mini: 5 строк half-блоков,
    // только пробелы и █▀▄, ширина ≤ 76, максимум ровно 76.
    // Пробелы значимы (внутренние просветы букв) — сверяем построчно.
    const lines = renderLogoRows();
    expect(lines).toHaveLength(LOGO_TERM_ROWS);
    expect(LOGO_TERM_ROWS).toBe(5);
    expect(LOGO_WIDTH).toBe(76);
    for (const line of lines) {
      expect(line).toMatch(/^[ █▀▄]+$/);
      expect([...line].length).toBeLessThanOrEqual(LOGO_WIDTH);
    }
    expect(Math.max(...lines.map((line) => [...line].length))).toBe(LOGO_WIDTH);
    // Возвращается копия: мутация не портит стартовый блок.
    expect(renderLogoRows()).toEqual(lines);
    expect(renderLogoRows()).not.toBe(lines);
    // Логотип непустой и не сплошная плашка: есть и заливка, и просветы.
    const inked = lines.join("").replace(/ /g, "");
    expect(inked.length).toBeGreaterThan(50);
    expect(lines.join("\n")).toContain(" ");
  });

  test("art welcome is picked by width only", () => {
    // Стартовый блок живёт в скроллируемой ленте под закреплённой шапкой —
    // важна только ширина (арт уже окна обрежется).
    expect(shouldUseArtWelcome(LOGO_WIDTH)).toBe(true);
    expect(shouldUseArtWelcome(200)).toBe(true);
    expect(shouldUseArtWelcome(LOGO_WIDTH - 1)).toBe(false);
    expect(shouldUseArtWelcome(0)).toBe(false);
    expect(shouldUseArtWelcome(Number.NaN)).toBe(false);
    // Мета-строка под логотипом: модель · путь · версия, пустое пропускается.
    expect(
      formatHeaderMeta({ model: "m", cwd: "/tmp/x", version: "1.2.3" }),
    ).toBe("m · /tmp/x · v1.2.3");
    expect(formatHeaderMeta({ model: "  " })).toBe("");
  });

  test("shortens home directory for the header", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = "/home/dev";
      delete process.env.USERPROFILE;
      expect(shortenHome("/home/dev/projects/x")).toBe("~/projects/x");
      expect(shortenHome("/home/dev")).toBe("~");
      expect(shortenHome("/tmp/x")).toBe("/tmp/x");
      process.env.HOME = "";
      process.env.USERPROFILE = "C:\\Users\\dev";
      expect(shortenHome("C:\\Users\\dev\\projects")).toBe("~\\projects");
      expect(shortenHome("D:\\other")).toBe("D:\\other");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
    }
  });

  test("normalizes viewport dimensions to a safe range", () => {
    // Вьюпорт нормализуется: нули и крошечные окна не ломают математику.
    expect(normalizeViewport({ columns: 0, rows: 0 })).toEqual({
      columns: 80,
      rows: 24,
    });
    expect(normalizeViewport({ columns: 10, rows: 5 }).columns).toBe(20);
    expect(normalizeViewport({ columns: 10, rows: 5 }).rows).toBe(10);
  });

  test("filler pushes input to the bottom on short history", () => {
    // Пустотой добиваем до нижней кромки окна — ввод всегда внизу
    // как зафиксированный. История длиннее окна — ноль.
    expect(computeFillRows(30, 9, 7)).toBe(14);
    expect(computeFillRows(24, 10, 5)).toBe(9);
    expect(computeFillRows(30, 100, 7)).toBe(0);
    expect(computeFillRows(10, 0, 0)).toBe(10);
    expect(computeFillRows(Number.NaN, 5, 5)).toBe(14);
    expect(computeFillRows(30, Number.NaN, 7)).toBe(23);
  });

  test("frame stays one row below fullscreen to dodge win32 clear", () => {
    // Ink на win32 чистит весь терминал перед каждым кадром высотой >= окна:
    // кадр ровно в окно мигал бы на каждое нажатие. Минус строка — дешёвое
    // eraseLines, а нижняя правая клетка (скролл conhost #969) не трогается.
    expect(frameRows(30)).toBe(29);
    expect(frameRows(24)).toBe(23);
    expect(frameRows(10)).toBe(9);
    expect(frameRows(Number.NaN)).toBe(23);
  });

  test("legacy conhost falls back to classic, modern terminals go alt-screen", () => {
    // Ручные overrides бьют всё.
    expect(shouldUseAltScreen({ CHISEL_ALT_SCREEN: "0" }, "win32")).toBe(false);
    expect(shouldUseAltScreen({ CHISEL_NO_ALT_SCREEN: "1" }, "win32")).toBe(
      false,
    );
    expect(shouldUseAltScreen({ CHISEL_FORCE_ALT: "1" }, "win32")).toBe(true);
    // Вне Windows — всегда alt-screen.
    expect(shouldUseAltScreen({}, "linux")).toBe(true);
    expect(shouldUseAltScreen({}, "darwin")).toBe(true);
    // Windows: только современные терминалы, голый conhost — классика.
    expect(shouldUseAltScreen({}, "win32")).toBe(false);
    expect(shouldUseAltScreen({ WT_SESSION: "abc" }, "win32")).toBe(true);
    expect(shouldUseAltScreen({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
    expect(shouldUseAltScreen({ WEZTERM_EXECUTABLE: "/w" }, "win32")).toBe(
      true,
    );
    expect(shouldUseAltScreen({ ConEmuANSI: "ON" }, "win32")).toBe(true);
  });

  test("alt-screen scroll pins the viewport like Claude fullscreen", () => {
    // hideNewest=0 — следим за низом; вверх — пауза, вид стоит на месте.
    expect(clampHideNewest(0, 50)).toBe(0);
    expect(clampHideNewest(-3, 50)).toBe(0);
    expect(clampHideNewest(5, 50)).toBe(5);
    expect(clampHideNewest(99, 50)).toBe(50);
    expect(clampHideNewest(Number.NaN, 50)).toBe(0);
    // Шаг — пол-экрана, минимум 5.
    expect(scrollPageStep(30)).toBe(10);
    expect(scrollPageStep(24)).toBe(7);
    expect(scrollPageStep(10)).toBe(5);
    // Сдвиг с клампом.
    expect(applyHideDelta(0, 10, 50)).toBe(10);
    expect(applyHideDelta(45, 10, 50)).toBe(50);
    expect(applyHideDelta(5, -10, 50)).toBe(0);
    // Срез: хвост до cap, hiddenNew — сколько новых скрыто от вида.
    const lines = Array.from({ length: 10 }, (_, i) => i);
    expect(sliceTranscript(lines, 0)).toEqual({ visible: lines, hiddenNew: 0 });
    expect(sliceTranscript(lines, 3)).toEqual({
      visible: [0, 1, 2, 3, 4, 5, 6],
      hiddenNew: 3,
    });
    expect(sliceTranscript(lines, 99).hiddenNew).toBe(10);
    expect(sliceTranscript(lines, 0, 4).visible).toEqual([6, 7, 8, 9]);
    expect(ALT_SCREEN_MAX_RENDER_LINES).toBe(300);
  });

  test("alt-screen window fits the tail into the visual budget", () => {
    // Хвост по визуальному бюджету: переоценка безопасна (пустота),
    // недооценка обрезала бы свежие строки — оценки с запасом вверх.
    expect(displayCellWidth("abc")).toBe(3);
    expect(displayCellWidth("привет")).toBe(6);
    const cols = 20;
    // Арт — ровно строка, остальное — ceil + запас за отступы пузырей.
    expect(estimateLineRows({ text: "x".repeat(76), tone: "logo" }, 100)).toBe(
      1,
    );
    expect(estimateLineRows({ text: "hello", tone: "info" }, cols)).toBe(1);
    expect(estimateLineRows({ text: "x".repeat(45), tone: "info" }, cols)).toBe(
      3,
    );
    expect(estimateLineRows({ text: "hello", tone: "assistant" }, cols)).toBe(
      2,
    );
    expect(estimateLineRows({ text: "a\nb", tone: "dim" }, cols)).toBe(2);
    // Пузырь: отступ + префикс ❯ в ширине минус padding.
    expect(estimateLineRows({ text: "hi", tone: "user" }, cols)).toBe(2);
    // Markdown считается по видимому тексту: код с рамкой, буллеты с префиксом.
    expect(
      estimateLineRows(
        { text: "```ts\nconst x = 1;\n```", tone: "assistant" },
        40,
      ),
    ).toBe(1 + 6);
    expect(
      estimateLineRows({ text: "- раз\n- два", tone: "assistant" }, cols),
    ).toBe(1 + 2);
    // Хвост: влезает всё — всё и видно; переполнение — старые за кадром.
    const mk = (n: number) => ({
      id: n,
      text: `строка ${n}`,
      tone: "info" as const,
    });
    const ten = Array.from({ length: 10 }, (_, i) => mk(i));
    expect(fitWindow(ten, cols, 100, "end").visible.map((l) => l.id)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    const tail = fitWindow(ten, cols, 3, "end");
    expect(tail.visible.map((l) => l.id)).toEqual([7, 8, 9]);
    expect(tail.hiddenAbove).toBe(7);
    // Голова для Home: верх влезает в бюджет.
    const head = fitWindow(ten, cols, 3, "start");
    expect(head.visible.map((l) => l.id)).toEqual([0, 1, 2]);
    expect(head.hiddenAbove).toBe(0);
    // Пусто и тесно: хотя бы одна строка, вид не пустеет.
    expect(fitWindow([], cols, 10, "end").visible).toEqual([]);
    expect(fitWindow(ten, cols, 0, "end").visible).toHaveLength(1);
  });

  test("transcript pager jumps by prompts and searches", () => {
    // Ctrl+O пейджер: { / } — по промптам, / + n/N — по совпадениям.
    const lines = [
      { id: 0, text: "welcome", tone: "info" as const },
      { id: 1, text: "первая задача", tone: "user" as const },
      { id: 2, text: "ответ один", tone: "assistant" as const },
      { id: 3, text: "вторая задача", tone: "user" as const },
      { id: 4, text: "ответ два", tone: "assistant" as const },
    ];
    expect(promptLineIndices(lines)).toEqual([1, 3]);
    expect(prevPromptIndex(lines, 4)).toBe(3);
    expect(prevPromptIndex(lines, 3)).toBe(1);
    expect(prevPromptIndex(lines, 0)).toBe(0);
    expect(nextPromptIndex(lines, 1)).toBe(3);
    expect(nextPromptIndex(lines, 3)).toBe(4);
    expect(nextPromptIndex(lines, 0)).toBe(1);
    expect(searchMatchIndices(lines, "задача")).toEqual([1, 3]);
    expect(searchMatchIndices(lines, "ОТВЕТ")).toEqual([2, 4]);
    expect(searchMatchIndices(lines, "  ")).toEqual([]);
    expect(searchMatchIndices(lines, "нет такого")).toEqual([]);
    expect(clampTop(99, 5)).toBe(4);
    expect(clampTop(-2, 5)).toBe(0);
    expect(clampTop(2, 5)).toBe(2);
    expect(clampTop(0, 0)).toBe(0);
  });

  test("visual scroll steps glide instead of chunking", () => {
    // Шаги в визуальных строках: короткие мотаются пачками,
    // длинный markdown — целиком, квантование до целых строк.
    const cols = 20;
    const short = (n: number) => ({
      id: n,
      text: `строка ${n}`,
      tone: "info" as const,
    });
    const ten = Array.from({ length: 10 }, (_, i) => short(i));
    expect(hideForVisual(ten, cols, 0, 5)).toBe(5);
    expect(hideForVisual(ten, cols, 0, 99)).toBe(10);
    expect(hideForVisual(ten, cols, 5, -3)).toBe(2);
    expect(hideForVisual(ten, cols, 2, -99)).toBe(0);
    expect(hideForVisual([], cols, 0, 5)).toBe(0);
    // Длинная строка (3 ряда) проглатывает маленький шаг целиком.
    const mixed = [
      { id: 0, text: "x".repeat(45), tone: "info" as const },
      short(1),
    ];
    expect(hideForVisual(mixed, cols, 0, 2)).toBe(2);
    expect(hideForVisual(mixed, cols, 2, -2)).toBe(1);
  });

  test("liveWindowRows reads only the getWindowSize syscall", () => {
    // conhost: stdout.rows — высота БУФЕРА (300+), сисколл — видимое окно.
    // Filler по буферу печатал сотни строк и прятал стартовый блок.
    const stdout = process.stdout as unknown as {
      getWindowSize?: () => [number, number];
    };
    const original = stdout.getWindowSize;
    try {
      stdout.getWindowSize = () => [120, 30];
      expect(liveWindowRows()).toBe(30);
      // Нет сисколла — undefined: filler выключается вместо сотен строк.
      delete (stdout as Record<string, unknown>).getWindowSize;
      expect(liveWindowRows()).toBeUndefined();
      // Мусор и исключения — тоже undefined.
      stdout.getWindowSize = () => [0, -5];
      expect(liveWindowRows()).toBeUndefined();
      stdout.getWindowSize = () => {
        throw new Error("no tty");
      };
      expect(liveWindowRows()).toBeUndefined();
    } finally {
      if (original === undefined)
        delete (stdout as Record<string, unknown>).getWindowSize;
      else stdout.getWindowSize = original;
    }
  });
});

describe("hotkeys hint", () => {
  test("hint covers input keys without scroll keys", () => {
    // Скролл нативный терминальный — в подсказке только клавиши ввода.
    expect(HOTKEYS_HINT).toContain("Tab");
    expect(HOTKEYS_HINT).toContain("Enter — отправить");
    expect(HOTKEYS_HINT).toContain("Esc — закрыть");
    expect(HOTKEYS_HINT).toContain("Shift+Enter");
    expect(HOTKEYS_HINT).not.toContain("колесо");
    expect(HOTKEYS_HINT).not.toContain("вниз");
  });
});

describe("model picker helpers", () => {
  test("current model goes first, the rest are alphabetical", () => {
    expect(MAX_VISIBLE_MODELS).toBe(8);
    const models = [{ id: "b-model" }, { id: "a-model" }, { id: "c-model" }];
    expect(sortModelOptions(models, "c-model").map((m) => m.id)).toEqual([
      "c-model",
      "a-model",
      "b-model",
    ]);
    // Текущей нет в списке — чисто по алфавиту, входной массив не мутирует.
    expect(sortModelOptions(models, "missing").map((m) => m.id)).toEqual([
      "a-model",
      "b-model",
      "c-model",
    ]);
    expect(models.map((m) => m.id)).toEqual(["b-model", "a-model", "c-model"]);
  });

  test("filter matches id and hint case-insensitively", () => {
    const models = [
      { id: "claude-opus-5" },
      { id: "gpt-5", hint: "Flagship chat" },
      { id: "deepseek-chat" },
    ];
    expect(filterModelOptions(models, "").length).toBe(3);
    expect(filterModelOptions(models, "CLAUDE").map((m) => m.id)).toEqual([
      "claude-opus-5",
    ]);
    expect(filterModelOptions(models, "flagship").map((m) => m.id)).toEqual([
      "gpt-5",
    ]);
    expect(filterModelOptions(models, "zzz")).toEqual([]);
  });
});
