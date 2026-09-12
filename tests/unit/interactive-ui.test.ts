import { describe, expect, test } from "bun:test";
import {
  commandHelpText,
  isSlashInput,
  matchingCommands,
  parseSlashCommand,
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
  estimateFooterHeight,
  maxTranscriptOffset,
  visibleTranscriptTail,
  visibleTranscriptWindow,
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
    ).toBe(7);
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
