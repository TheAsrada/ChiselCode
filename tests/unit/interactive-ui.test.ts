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
  brandHeaderLine,
  fullWidthSeparator,
  HOTKEYS_HINT,
  normalizeViewport,
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
    expect(commandHelpText()).toContain("scrollback");
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
  test("adapts layout to fullscreen width", () => {
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
    // wrappedLines считает по доступной ширине, а не по окну минус магия.
    expect(wrappedLines("x".repeat(100), 100)).toBe(1);
    expect(wrappedLines("x".repeat(101), 100)).toBe(2);
  });

  test("brand header line carries provider, version and model", () => {
    const line = brandHeaderLine(
      0,
      "Anthropic (Claude)",
      "test-model",
      "0.5.7",
    );
    expect(line.id).toBe(0);
    expect(line.tone).toBe("brand");
    expect(line.text).toBe("Anthropic (Claude) · v0.5.7 · test-model");
    expect(brandHeaderLine(1, "OpenAI", "gpt", undefined).text).toBe(
      "OpenAI · gpt",
    );
  });

  test("hotkeys hint does not promise app-side scrolling", () => {
    // Журнал листается средствами терминала — хинт про колесо убран.
    expect(HOTKEYS_HINT).toContain("Enter — отправить");
    expect(HOTKEYS_HINT).not.toContain("колесо");
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
