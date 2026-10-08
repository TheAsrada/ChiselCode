import { describe, expect, test } from "bun:test";
import {
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

describe("interactive commands", () => {
  test("parses only known complete slash commands", () => {
    expect(parseSlashCommand(" /settings ")).toEqual({
      name: "/settings",
      args: "",
    });
    expect(parseSlashCommand("/help")).toBeUndefined();
    expect(parseSlashCommand("/unknown")).toBeUndefined();
    expect(parseSlashCommand("/new")).toEqual({ name: "/new", args: "" });
    expect(parseSlashCommand("/home")).toEqual({ name: "/home", args: "" });
    expect(parseSlashCommand("/cwd C:\\projects\\demo")).toEqual({
      name: "/cwd",
      args: "C:\\projects\\demo",
    });
    expect(parseSlashCommand("/cwd")).toEqual({ name: "/cwd", args: "" });
    expect(isSlashInput(" /model")).toBe(true);
    expect(isSlashInput("объясни /model")).toBe(false);
  });

  test("filters available command suggestions", () => {
    expect(matchingCommands("/s").map((command) => command.name)).toEqual([
      "/settings",
      "/skills",
      "/status",
      "/sessions",
      "/sidebar",
    ]);
    expect(matchingCommands("/c").map((command) => command.name)).toEqual([
      "/clear",
      "/cwd",
    ]);
    expect(matchingCommands("/h").map((command) => command.name)).toEqual([
      "/home",
    ]);
    expect(matchingCommands("/help")).toEqual([]);
  });

  test("suggests the closest command for typos", () => {
    expect(MAX_VISIBLE_SUGGESTIONS).toBe(6);
    // Транспозиция (2 правки) и пропущенная буква (1 правка).
    expect(suggestSimilarCommand("/sessons")).toBe("/sessions");
    expect(suggestSimilarCommand("/setings")).toBe("/settings");
    expect(suggestSimilarCommand("/hlep")).toBeUndefined();
    expect(suggestSimilarCommand("/help")).toBeUndefined();
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
