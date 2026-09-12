export interface EditorState {
  value: string;
  cursor: number;
  history: string[];
  historyIndex: number;
  historyDraft: string;
}

export function createEditorState(): EditorState {
  return {
    value: "",
    cursor: 0,
    history: [],
    historyIndex: -1,
    historyDraft: "",
  };
}

export function insertEditorText(
  state: EditorState,
  text: string,
): EditorState {
  return withValue(
    state,
    state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor),
    state.cursor + text.length,
  );
}

export function backspaceEditorText(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  return withValue(
    state,
    state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor),
    state.cursor - 1,
  );
}

export function deleteEditorText(state: EditorState): EditorState {
  if (state.cursor >= state.value.length) return state;
  return withValue(
    state,
    state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1),
    state.cursor,
  );
}

export function moveEditorCursor(
  state: EditorState,
  direction: -1 | 1,
): EditorState {
  return {
    ...state,
    cursor: Math.max(0, Math.min(state.value.length, state.cursor + direction)),
  };
}

export function addEditorHistory(
  state: EditorState,
  prompt: string,
): EditorState {
  const value = prompt.trim();
  if (!value) return state;
  const history =
    state.history.at(-1) === value ? state.history : [...state.history, value];
  return {
    ...state,
    value: "",
    cursor: 0,
    history,
    historyIndex: -1,
    historyDraft: "",
  };
}

export function navigateEditorHistory(
  state: EditorState,
  direction: -1 | 1,
): EditorState {
  if (!state.history.length) return state;
  if (direction < 0) {
    const historyIndex =
      state.historyIndex < 0
        ? state.history.length - 1
        : Math.max(0, state.historyIndex - 1);
    const value = state.history[historyIndex] ?? "";
    return {
      ...state,
      value,
      cursor: value.length,
      historyIndex,
      historyDraft: state.historyIndex < 0 ? state.value : state.historyDraft,
    };
  }
  if (state.historyIndex < 0) return state;
  const historyIndex = state.historyIndex + 1;
  if (historyIndex >= state.history.length) {
    return {
      ...state,
      value: state.historyDraft,
      cursor: state.historyDraft.length,
      historyIndex: -1,
    };
  }
  const value = state.history[historyIndex] ?? "";
  return { ...state, value, cursor: value.length, historyIndex };
}

export function isFirstEditorLine(state: EditorState): boolean {
  return !state.value.slice(0, state.cursor).includes("\n");
}

export function isLastEditorLine(state: EditorState): boolean {
  return !state.value.slice(state.cursor).includes("\n");
}

function withValue(
  state: EditorState,
  value: string,
  cursor: number,
): EditorState {
  return { ...state, value, cursor, historyIndex: -1, historyDraft: "" };
}
