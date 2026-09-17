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
  filterModelOptions,
  MAX_VISIBLE_MODELS,
  sortModelOptions,
} from "../../src/ui/settings.js";
import {
  estimateFooterHeight,
  fullWidthSeparator,
  maxTranscriptOffset,
  normalizeViewport,
  TUI_HEADER_ROWS,
  visibleTranscriptTail,
  visibleTranscriptWindow,
  wrappedLines,
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
    expect(TUI_HEADER_ROWS).toBe(2);
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

  test("clips transcript tail with room for overflow indicator", () => {
    const lines = [
      { id: 0, text: "первая", tone: "info" as const },
      { id: 1, text: "вторая", tone: "info" as const },
      { id: 2, text: "третья", tone: "info" as const },
    ];
    const third = lines[2];
    if (!third) throw new Error("test data is incomplete");
    expect(visibleTranscriptTail(lines, 7, 80, 5)).toEqual({
      lines: [third],
      hiddenCount: 2,
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
    expect(visibleTranscriptTail(lines, 8, 15, 5)).toEqual({
      lines: [second],
      hiddenCount: 1,
    });
  });

  test("browses an in-memory transcript in both directions", () => {
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

    expect(visibleTranscriptWindow(lines, 8, 20, 5)).toEqual({
      lines: [third, fourth],
      hiddenAboveCount: 2,
      hiddenBelowCount: 0,
    });
    expect(visibleTranscriptWindow(lines, 8, 20, 5, 1)).toEqual({
      lines: [third],
      hiddenAboveCount: 2,
      hiddenBelowCount: 1,
    });
    expect(visibleTranscriptWindow(lines, 8, 20, 5, 2)).toEqual({
      lines: [first, second],
      hiddenAboveCount: 0,
      hiddenBelowCount: 2,
    });
    expect(visibleTranscriptWindow(lines, 8, 20, 5, 3)).toEqual({
      lines: [first],
      hiddenAboveCount: 0,
      hiddenBelowCount: 3,
    });
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

    expect(maxTranscriptOffset(lines)).toBe(2);
    expect(visibleTranscriptWindow(lines, 8, 80, 5, 99)).toEqual({
      lines: [first],
      hiddenAboveCount: 0,
      hiddenBelowCount: 2,
    });
    expect(visibleTranscriptWindow(lines, 8, 15, 5, 1)).toEqual({
      lines: [second],
      hiddenAboveCount: 1,
      hiddenBelowCount: 1,
    });
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
