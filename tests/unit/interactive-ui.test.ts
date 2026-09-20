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
  SHIFT_SCROLL_ROWS,
  splitMouseEvents,
  type WheelDirection,
  wheelScrollRows,
} from "../../src/ui/mouse.js";
import {
  filterModelOptions,
  MAX_VISIBLE_MODELS,
  sortModelOptions,
} from "../../src/ui/settings.js";
import {
  ART_HEADER_ROWS,
  ART_MIN_ROWS,
  charCellWidth,
  editorContentRows,
  estimateFooterHeight,
  expandLineRows,
  formatHeaderMeta,
  formatHeaderTitle,
  fullWidthSeparator,
  HOTKEYS_HINT,
  headerSeparator,
  hotkeyHintRows,
  hotkeysHint,
  maxTranscriptScrollRows,
  normalizeViewport,
  shortenHome,
  shouldUseArtHeader,
  sliceTranscriptLine,
  TUI_HEADER_ROWS,
  textCellWidth,
  totalTranscriptRows,
  visibleTranscriptTail,
  visibleTranscriptWindow,
  wrapPrefixedRows,
  wrappedLines,
  wrapTextRows,
  wrapUnitRows,
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
    expect(commandHelpText()).toContain("Колесо мыши");
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

describe("interactive viewport layout", () => {
  test("reserves space for multiline editor and command suggestions", () => {
    expect(
      estimateFooterHeight({
        busy: false,
        editorValue: "первая строка\nвторая строка",
        columns: 80,
        suggestionsCount: 2,
      }),
    ).toBe(11);
    expect(
      estimateFooterHeight({
        busy: true,
        editorValue: "",
        columns: 80,
        suggestionsCount: 3,
      }),
    ).toBe(5);
  });

  test("reserves the measured approval panel height", () => {
    expect(
      estimateFooterHeight({
        request: {
          tool: "write_file",
          preview: "src/example.ts",
        },
        busy: false,
        columns: 80,
        suggestionsCount: 0,
      }),
    ).toBe(8);
  });

  test("adapts layout to fullscreen width without moving the input", () => {
    // Разделитель всегда во всю ширину окна.
    expect(fullWidthSeparator(80).length).toBe(80);
    expect(fullWidthSeparator(200).length).toBe(200);
    // Вьюпорт нормализуется: нули и крошечные окна не ломают математику.
    expect(normalizeViewport({ columns: 0, rows: 0 })).toEqual({
      columns: 80,
      rows: 24,
    });
    expect(normalizeViewport({ columns: 10, rows: 5 }).columns).toBe(20);
    expect(normalizeViewport({ columns: 10, rows: 5 }).rows).toBe(10);
    // Широкое окно: длинная строка ввода занимает меньше строк,
    // высота футера уменьшается, а шапка фиксирована.
    const narrow = estimateFooterHeight({
      busy: false,
      editorValue: "x".repeat(100),
      columns: 40,
      suggestionsCount: 0,
    });
    const wide = estimateFooterHeight({
      busy: false,
      editorValue: "x".repeat(100),
      columns: 200,
      suggestionsCount: 0,
    });
    expect(wide).toBeLessThan(narrow);
    expect(TUI_HEADER_ROWS).toBe(3);
    // wrappedLines считает по доступной ширине, а не по окну минус магия.
    expect(wrappedLines("x".repeat(100), 100)).toBe(1);
    expect(wrappedLines("x".repeat(101), 100)).toBe(2);
    // Зарезервированная шапка уменьшает окно истории, но хвост тот же.
    const lines = [
      { id: 0, text: "первая", tone: "info" as const },
      { id: 1, text: "вторая", tone: "info" as const },
      { id: 2, text: "третья", tone: "info" as const },
    ];
    const withoutHeader = visibleTranscriptWindow(lines, 8, 80, 5, 0, 0);
    const withHeader = visibleTranscriptWindow(
      lines,
      8 + TUI_HEADER_ROWS,
      80,
      5,
      0,
      TUI_HEADER_ROWS,
    );
    expect(withHeader).toEqual(withoutHeader);
  });

  test("static monochrome header keeps exact width without animation", () => {
    // Шапка как у топовых CLI (OpenCode/Codex): статичный монохром,
    // без анимации и разноцветности. Плоский текст — для снепшотов,
    // разделитель — ровно ширина окна из одних «─», без бегущего «●».
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
      expect(line).not.toContain("●");
      expect(fullWidthSeparator(columns)).toBe(line);
    }
    // Слим-шапка — три строки (отступ + заголовок + разделитель).
    expect(TUI_HEADER_ROWS).toBe(3);
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
    // Возвращается копия: мутация не портит шапку.
    expect(renderLogoRows()).toEqual(lines);
    expect(renderLogoRows()).not.toBe(lines);
    // Логотип непустой и не сплошная плашка: есть и заливка, и просветы.
    const inked = lines.join("").replace(/ /g, "");
    expect(inked.length).toBeGreaterThan(50);
    expect(lines.join("\n")).toContain(" ");
  });

  test("art header is picked only on wide and tall windows", () => {
    // Как multi-size логотипы у Gemini CLI: арт на широких+высоких,
    // слим-строка на узких/низких/битых размерах.
    expect(shouldUseArtHeader(LOGO_WIDTH, ART_MIN_ROWS)).toBe(true);
    expect(shouldUseArtHeader(200, 60)).toBe(true);
    expect(shouldUseArtHeader(100, 20)).toBe(true);
    expect(shouldUseArtHeader(100, 19)).toBe(false);
    expect(shouldUseArtHeader(LOGO_WIDTH - 1, 60)).toBe(false);
    expect(shouldUseArtHeader(200, ART_MIN_ROWS - 1)).toBe(false);
    expect(shouldUseArtHeader(20, 10)).toBe(false);
    expect(shouldUseArtHeader(0, 0)).toBe(false);
    expect(shouldUseArtHeader(Number.NaN, 30)).toBe(false);
    // Арт-шапка: отступ + логотип + дим-строка мета + разделитель.
    expect(ART_HEADER_ROWS).toBe(LOGO_TERM_ROWS + 3);
    expect(ART_HEADER_ROWS).toBe(8);
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

  test("wraps by words and cells like the terminal", () => {
    // Перенос по словам, а не ceil(len/width): пробелы рвут раньше.
    // (Минимальная ширина движка — 10 клеток, меньше не бывает.)
    expect(wrapTextRows("aa bbb ccc dd", 10)).toEqual(["aa bbb ccc", "dd"]);
    expect(wrapTextRows("", 10)).toEqual([""]);
    // Длинное слово рвётся по клеткам.
    expect(wrapTextRows("abcdefghijklm", 10)).toEqual(["abcdefghij", "klm"]);
    expect(wrappedLines("x".repeat(100), 100)).toBe(1);
    expect(wrappedLines("x".repeat(101), 100)).toBe(2);
    // CJK — две клетки.
    expect(charCellWidth("あ")).toBe(2);
    expect(charCellWidth("a")).toBe(1);
    expect(charCellWidth("◈")).toBe(1);
    expect(textCellWidth("aあ")).toBe(3);
    expect(wrapTextRows("あいうえおか", 10)).toEqual(["あいうえお", "か"]);
    // Префикс входит в первую строку и ест только её бюджет.
    expect(wrapPrefixedRows("aa bbb ccc dd", "❯ ", 10)).toEqual([
      "❯ aa bbb",
      "ccc dd",
    ]);
    expect(wrapUnitRows("aa\nbbb ccc dd", 10)).toEqual(["aa", "bbb ccc dd"]);
  });

  test("expands transcript lines exactly as rendered", () => {
    // cli.ts шлёт тексты уже с префиксами — view их срезает и ставит свои.
    expect(
      expandLineRows({ id: 0, text: "❯ привет", tone: "user" }, 80),
    ).toEqual(["", "❯ привет"]);
    // Пузырь уже окна на 2 клетки (paddingX): префикс только в первой строке.
    expect(
      expandLineRows({ id: 0, text: `❯ ${"x".repeat(100)}`, tone: "user" }, 80),
    ).toEqual(["", `❯ ${"x".repeat(76)}`, "x".repeat(24)]);
    // Ответ уже окна на клетку (левая черта): 100 иксов — 79 + 21.
    expect(
      expandLineRows({ id: 0, text: "x".repeat(100), tone: "assistant" }, 80),
    ).toEqual(["", "x".repeat(79), "x".repeat(21)]);
    expect(
      expandLineRows({ id: 0, text: "[chisel] read a", tone: "tool" }, 80),
    ).toEqual(["◆ read a"]);
    expect(
      expandLineRows({ id: 0, text: "✗ boom", tone: "error" }, 80),
    ).toEqual(["✗ boom"]);
    expect(expandLineRows({ id: 0, text: "⚠ wait", tone: "warn" }, 80)).toEqual(
      ["⚠ wait"],
    );
    expect(expandLineRows({ id: 0, text: "ok", tone: "success" }, 80)).toEqual([
      "ok",
    ]);
    // info/success — сырой текст без markdown; assistant — видимый текст:
    // разметка клеток не занимает, ссылка видна как «t (url)».
    expect(
      expandLineRows(
        { id: 0, text: "**жирно** и [t](http://x)", tone: "info" },
        80,
      ),
    ).toEqual(["**жирно** и [t](http://x)"]);
    expect(
      expandLineRows(
        { id: 0, text: "**жирно** и [t](http://x)", tone: "assistant" },
        80,
      ),
    ).toEqual(["", "жирно и t (http://x)"]);
    // Код: отступ + рамка + язык + строки + рамка + отступ.
    // Ответ уже окна на клетку (левая черта): рамка 77, а не 78.
    expect(
      expandLineRows({ id: 0, text: "```ts\nab\n```", tone: "assistant" }, 80),
    ).toEqual([
      "",
      "",
      `╭${"─".repeat(77)}╮`,
      "ts",
      "ab",
      `╰${"─".repeat(77)}╯`,
      "",
    ]);
  });

  test("counts editor rows with the cursor block", () => {
    expect(editorContentRows("", 0, 76)).toBe(1);
    expect(editorContentRows("ab", 2, 76)).toBe(1);
    // «█» в конце на границе ширины — целая строка (раньше занижало).
    expect(editorContentRows("x".repeat(72), 72, 76)).toBe(1);
    expect(editorContentRows("x".repeat(73), 73, 76)).toBe(1);
    expect(editorContentRows("x".repeat(74), 74, 76)).toBe(2);
    expect(editorContentRows("x".repeat(74), 0, 76)).toBe(1);
    expect(editorContentRows("aa\nbb", 5, 76)).toBe(2);
  });

  test("hotkey hint never changes the footer height", () => {
    // Хинт резервируется по худшему варианту: скролл не двигает футер.
    expect(hotkeyHintRows(80)).toBe(wrapUnitRows(HOTKEYS_HINT, 80).length);
    const base = {
      busy: false,
      editorValue: "",
      columns: 80,
      suggestionsCount: 0,
    };
    expect(estimateFooterHeight({ ...base, scrolledUp: true })).toBe(
      estimateFooterHeight({ ...base, scrolledUp: false }),
    );
  });

  test("clips transcript tail without an overflow indicator", () => {
    const lines = [
      { id: 0, text: "первая", tone: "info" as const },
      { id: 1, text: "вторая", tone: "info" as const },
      { id: 2, text: "третья", tone: "info" as const },
    ];
    const second = lines[1];
    const third = lines[2];
    if (!second || !third) throw new Error("test data is incomplete");
    // Весь бюджет уходит контенту: влезают две последние записи, без счётчиков.
    expect(visibleTranscriptTail(lines, 7, 80, 5)).toEqual({
      lines: [second, third],
      hiddenCount: 1,
    });
  });

  test("recalculates clipping when a narrow viewport wraps markdown", () => {
    const lines = [
      { id: 0, text: "коротко", tone: "info" as const },
      {
        id: 1,
        text: "очень длинная строка для проверки переноса в узком терминале",
        tone: "info" as const,
      },
    ];
    const first = lines[0];
    const second = lines[1];
    if (!first || !second) throw new Error("test data is incomplete");
    expect(visibleTranscriptTail(lines, 9, 80, 5)).toEqual({
      lines: [first, second],
      hiddenCount: 0,
    });
    // Узкое окно: длинная запись (3 строки на 24 колонках) режется срезом.
    const narrow = visibleTranscriptWindow(lines, 7, 24, 5);
    expect(narrow.hiddenAboveCount).toBe(2);
    expect(narrow.hiddenBelowCount).toBe(0);
    expect(narrow.lines).toHaveLength(1);
    const cut = narrow.lines[0];
    if (!cut) throw new Error("test data is incomplete");
    expect(cut.id).toBe(1);
    expect(cut.tone).toBe("info");
    expect(cut.text).toBe("проверки переноса в\nузком терминале");
  });

  test("browses an in-memory transcript in both directions", () => {
    // Offset — в СТРОКАХ терминала (как браузер), а не в записях.
    const lines = [
      { id: 0, text: "первая", tone: "info" as const },
      { id: 1, text: "вторая", tone: "info" as const },
      { id: 2, text: "третья", tone: "info" as const },
      { id: 3, text: "четвёртая", tone: "info" as const },
    ];
    const first = lines[0];
    const second = lines[1];
    const third = lines[2];
    const fourth = lines[3];
    if (!first || !second || !third || !fourth)
      throw new Error("test data is incomplete");

    // Контент 3 строки из 4: дно — три свежие, выше — одна строка.
    expect(totalTranscriptRows(lines, 20)).toBe(4);
    expect(maxTranscriptScrollRows(lines, 20, 3)).toBe(1);
    expect(visibleTranscriptWindow(lines, 8, 20, 5)).toEqual({
      lines: [second, third, fourth],
      hiddenAboveCount: 1,
      hiddenBelowCount: 0,
    });
    expect(visibleTranscriptWindow(lines, 8, 20, 5, 1)).toEqual({
      lines: [first, second, third],
      hiddenAboveCount: 0,
      hiddenBelowCount: 1,
    });
    // Дальше дна — кламп к максимуму: та же тройка, а не пустота.
    expect(visibleTranscriptWindow(lines, 8, 20, 5, 2)).toEqual({
      lines: [first, second, third],
      hiddenAboveCount: 0,
      hiddenBelowCount: 1,
    });
    expect(visibleTranscriptWindow(lines, 8, 20, 5, 99)).toEqual({
      lines: [first, second, third],
      hiddenAboveCount: 0,
      hiddenBelowCount: 1,
    });
  });

  test("reads tall entries in parts instead of skipping them", () => {
    // Ответ выше экрана: раньше проскакивал целиком и середина была невидима.
    const tall = Array.from({ length: 10 }, (_, i) => `код-${i}`).join("\n");
    const lines = [
      { id: 0, text: "шапка", tone: "info" as const },
      { id: 1, text: `\`\`\`\n${tall}\n\`\`\``, tone: "assistant" as const },
      { id: 2, text: "подвал", tone: "info" as const },
    ];
    // Всего 17 строк: шапка 1 + ответ 15 + подвал 1.
    expect(totalTranscriptRows(lines, 80)).toBe(17);
    // Контент 5 строк, дно: хвост кода + подвал.
    const bottom = visibleTranscriptWindow(lines, 12, 80, 5, 0, 2);
    expect(bottom.hiddenBelowCount).toBe(0);
    expect(bottom.hiddenAboveCount).toBe(17 - 5);
    const last = bottom.lines.at(-1);
    if (!last) throw new Error("test data is incomplete");
    expect(last).toEqual({ id: 2, text: "подвал", tone: "info" });
    // Верх среза — та же запись (тот же id), но plain-текстом для точности.
    const first = bottom.lines[0];
    if (!first) throw new Error("test data is incomplete");
    expect(first.id).toBe(1);
    expect(first.tone).toBe("info");
    // Поднялись на 3 строки: видна середина кода, низ и верх скрыты.
    const middle = visibleTranscriptWindow(lines, 12, 80, 5, 3, 2);
    expect(middle.hiddenBelowCount).toBe(3);
    expect(middle.hiddenAboveCount).toBe(17 - 5 - 3);
    expect(middle.lines.some((line) => line.text.includes("код-5"))).toBe(true);
    expect(middle.lines.some((line) => line.text.includes("подвал"))).toBe(
      false,
    );
  });

  test("slices transcript lines with exact heights", () => {
    const line = {
      id: 7,
      text: "aaaa bbbb cccc dddd eeee",
      tone: "info" as const,
    };
    // Две строки на ширине 20: целая — возвращается как есть, резать нечего.
    expect(expandLineRows(line, 20)).toEqual(["aaaa bbbb cccc dddd", "eeee"]);
    expect(sliceTranscriptLine(line, 0, 10, 20)).toBe(line);
    const cut = sliceTranscriptLine(line, 1, 1, 20);
    if (!cut) throw new Error("slice is empty");
    expect(cut.id).toBe(7);
    expect(cut.tone).toBe("info");
    expect(cut.text).toBe("eeee");
    expect(sliceTranscriptLine(line, 2, 1, 20)).toBeNull();
    expect(sliceTranscriptLine(line, 0, 0, 20)).toBeNull();
  });

  test("clamps transcript navigation and recomputes its window after resize", () => {
    const lines = [
      { id: 0, text: "коротко", tone: "info" as const },
      {
        id: 1,
        text: "длинная запись для проверки пересчёта окна после изменения ширины терминала",
        tone: "info" as const,
      },
      { id: 2, text: "новее", tone: "info" as const },
    ];
    const first = lines[0];
    const second = lines[1];
    if (!first || !second) throw new Error("test data is incomplete");

    // Длинная запись — 75 клеток: 1 строка на 80 колонках, 4 на 24.
    expect(totalTranscriptRows(lines, 80)).toBe(3);
    expect(maxTranscriptScrollRows(lines, 80, 2)).toBe(1);
    // Контент 2 строки из 3: дно — длинная целиком и хвост, выше — 1 строка.
    expect(visibleTranscriptWindow(lines, 7, 80, 5, 99)).toEqual({
      lines: [first, second],
      hiddenAboveCount: 0,
      hiddenBelowCount: 1,
    });
    // Узкое окно режет длинную запись сверху срезом с тем же id.
    const narrow = visibleTranscriptWindow(lines, 8, 24, 5, 1);
    expect(narrow.hiddenAboveCount).toBe(2);
    expect(narrow.hiddenBelowCount).toBe(1);
    expect(narrow.lines).toHaveLength(1);
    const cut = narrow.lines[0];
    if (!cut) throw new Error("test data is incomplete");
    expect(cut.id).toBe(1);
    expect(cut.tone).toBe("info");
    expect(cut.text).toBe(
      "проверки пересчёта окна\nпосле изменения ширины\nтерминала",
    );
  });
});

describe("mouse wheel events", () => {
  test("wheel scrolls rows like a browser, shift moves one row", () => {
    // Колесо — четверть видимой высоты в СТРОКАХ, а не записи целиком:
    // высота записей гуляет от 1 до десятков строк.
    expect(wheelScrollRows(16)).toBe(4);
    expect(wheelScrollRows(24)).toBe(6);
    expect(wheelScrollRows(3)).toBe(1);
    expect(wheelScrollRows(0)).toBe(1);
    expect(SHIFT_SCROLL_ROWS).toBe(1);
    // 64 — колесо вверх, 65 — вниз; 68/69 — то же с Shift.
    expect(splitMouseEvents("\x1b[<64;10;20M")).toEqual({
      text: "",
      wheels: ["up"],
      pending: "",
    });
    expect(splitMouseEvents("\x1b[<65;10;20M")).toEqual({
      text: "",
      wheels: ["down"],
      pending: "",
    });
    expect(splitMouseEvents("\x1b[<68;1;1M\x1b[<69;1;1M")).toEqual({
      text: "",
      wheels: ["up", "down"] as WheelDirection[],
      pending: "",
    });
    // Отпускание (m) и клики без 64-го бита глотаются молча.
    expect(splitMouseEvents("\x1b[<64;10;20m")).toEqual({
      text: "",
      wheels: [],
      pending: "",
    });
    expect(splitMouseEvents("\x1b[<0;10;20M")).toEqual({
      text: "",
      wheels: [],
      pending: "",
    });
    // Обычный текст едет дальше нетронутым.
    expect(splitMouseEvents("привет")).toEqual({
      text: "привет",
      wheels: [],
      pending: "",
    });
    expect(splitMouseEvents("a\x1b[<65;10;20Mb")).toEqual({
      text: "ab",
      wheels: ["down"],
      pending: "",
    });
    // Рваный хвост ждёт следующий чанк.
    const split = splitMouseEvents("\x1b[<6");
    expect(split).toEqual({ text: "", wheels: [], pending: "\x1b[<6" });
    expect(splitMouseEvents(`${split.pending}4;10;20M`)).toEqual({
      text: "",
      wheels: ["up"],
      pending: "",
    });
    // Одинокий Esc — не мышь: висит в pending до следующего чанка.
    expect(splitMouseEvents("\x1b")).toEqual({
      text: "",
      wheels: [],
      pending: "\x1b",
    });
  });

  test("hotkeys hint shows Esc as way down when scrolled", () => {
    expect(hotkeysHint(false)).toContain("Esc — закрыть");
    expect(hotkeysHint(true)).toContain("Esc — вниз");
    expect(hotkeysHint(true)).toContain("колесо");
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
