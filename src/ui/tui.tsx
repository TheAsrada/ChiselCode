import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolver,
} from "../security/approval.js";
import type { ProviderKind } from "../types/domain.js";
import {
  commandHelpText,
  isSlashInput,
  matchingCommands,
  parseSlashCommand,
  type SlashCommandName,
} from "./commands.js";
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
} from "./editor.js";
import { MarkdownText, parseBlocks } from "./markdown.js";
import { SettingsPanel, type TuiSettingsValues } from "./settings.js";
import { SetupApp, type SetupValues } from "./setup.js";
import { toolDisplay, welcomeLines } from "./theme.js";
import { Thinking } from "./thinking.js";

export interface TuiApprovalResolver extends ApprovalResolver {
  bind(setter?: (request: ApprovalRequest | undefined) => void): void;
  resolve(decision: ApprovalDecision): void;
  dispose(): void;
}

export type TranscriptTone =
  | "assistant"
  | "user"
  | "tool"
  | "info"
  | "warn"
  | "error"
  | "success"
  | "brand";

export interface TuiTranscriptLine {
  id: number;
  text: string;
  tone?: TranscriptTone;
}
export interface TuiTranscript {
  append(line: string, tone?: TranscriptTone): void;
  appendToLast(text: string): void;
  clear(): void;
}

/**
 * Адаптивная раскладка как в Claude Code:
 * - шапка закреплена сверху и занимает всю ширину окна;
 * - история занимает всё свободное место и пересчитывается при ресайзе;
 * - поле ввода / подтверждение закреплены снизу на всю ширину и растут вверх.
 * Все оценки высоты считаются от актуального числа колонок, поэтому при
 * разворачивании окна ввод не «съезжает», а текст просто переоборачивается.
 */
export const TUI_MIN_COLUMNS = 20;
export const TUI_MIN_ROWS = 10;
export const TUI_HEADER_ROWS = 2;
export const TUI_FALLBACK_COLUMNS = 80;
export const TUI_FALLBACK_ROWS = 24;

export interface TuiViewport {
  columns: number;
  rows: number;
}

/** Нормализует размеры Ink к безопасному диапазону для математики layout. */
export function normalizeViewport(viewport: {
  columns?: number;
  rows?: number;
}): TuiViewport {
  const columns = Math.floor(viewport.columns ?? TUI_FALLBACK_COLUMNS);
  const rows = Math.floor(viewport.rows ?? TUI_FALLBACK_ROWS);
  return {
    columns: Math.max(
      Number.isFinite(columns) && columns > 0 ? columns : TUI_FALLBACK_COLUMNS,
      TUI_MIN_COLUMNS,
    ),
    rows: Math.max(
      Number.isFinite(rows) && rows > 0 ? rows : TUI_FALLBACK_ROWS,
      TUI_MIN_ROWS,
    ),
  };
}

/** Полноширинный разделитель под актуальную ширину окна. */
export function fullWidthSeparator(columns: number): string {
  return "─".repeat(Math.max(Math.floor(columns) || TUI_FALLBACK_COLUMNS, 10));
}

/**
 * Подсказка горячих клавиш под полем ввода. Держим в одну строку на 80
 * колонках, чтобы высота футера была предсказуема при любом размере окна.
 */
export const HOTKEYS_HINT =
  "Enter — отправить · Shift+Enter — строка · ↑/↓ — история · PgUp/PgDn — журнал";

/** Строка подсказки команды — та же, что рисует Editor. */
export function suggestionLineText(name: string, description: string): string {
  return `› ${name} — ${description}`;
}

export function createTuiApprovalResolver(): TuiApprovalResolver {
  let resolvePending: ((decision: ApprovalDecision) => void) | undefined;
  let setRequest: ((request: ApprovalRequest | undefined) => void) | undefined;
  return {
    async requestApproval(request) {
      if (!setRequest) return "unavailable";
      return new Promise((resolve) => {
        resolvePending = resolve;
        setRequest?.(request);
      });
    },
    bind(setter) {
      setRequest = setter;
    },
    resolve(decision) {
      resolvePending?.(decision);
      resolvePending = undefined;
      setRequest?.(undefined);
    },
    dispose() {
      resolvePending?.("unavailable");
      resolvePending = undefined;
      setRequest = undefined;
    },
  } as TuiApprovalResolver;
}

export interface TuiAppProps {
  approvalResolver: TuiApprovalResolver;
  bindTranscript(transcript: TuiTranscript): void;
  onSubmit(prompt: string): Promise<void>;
  onStatus(): Promise<string>;
  onSwitchProject(path: string): Promise<string>;
  onCheckUpdate?(): Promise<string>;
  onDoctor?(): Promise<string>;
  onSaveSettings(
    values: TuiSettingsValues,
  ): Promise<"saved" | "setup_required">;
  /** Проверка подключения к отредактированным настройкам из /settings. */
  onCheckConnection(values: TuiSettingsValues): Promise<string>;
  /**
   * Сохранение заново пройденного мастера настройки.
   * Выполняется внутри того же Ink-приложения: TUI не размонтируется,
   * поэтому перезапуск настройки больше не роняет интерфейс.
   */
  onCompleteSetup(values: SetupValues): Promise<void>;
  provider: ProviderKind;
  providerLabel: string;
  model: string;
  baseUrl?: string;
  version?: string;
}

export function TuiApp(props: TuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  const rawViewport = useWindowSize();
  const viewport = normalizeViewport(rawViewport);
  const [editor, setEditor] = useState(createEditorState);
  const [request, setRequest] = useState<ApprovalRequest>();
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<"menu" | "model">();
  // Мастер настройки поверх чата: тот же Ink-экран, без exit()/render().
  const [restartingSetup, setRestartingSetup] = useState(false);
  const [runtime, setRuntime] = useState(() => ({
    provider: props.provider,
    providerLabel: props.providerLabel,
    model: props.model,
    baseUrl: props.baseUrl,
  }));
  const [transcript, setTranscript] = useState<TuiTranscriptLine[]>(
    intro(props.providerLabel, props.model, props.version),
  );
  // Незавершённый стриминговый ответ живёт отдельно от истории:
  // alternate screen никогда не получает статический вывод в скроллбэк,
  // а незавершённая строка остаётся частью перерисовываемого кадра.
  const [streaming, setStreaming] = useState<TuiTranscriptLine | null>(null);
  const [transcriptOffset, setTranscriptOffset] = useState(0);
  const streamingRef = useRef<TuiTranscriptLine | null>(null);
  const nextTranscriptId = useRef(3);
  const suggestions = isSlashInput(editor.value)
    ? matchingCommands(editor.value)
    : [];
  const selectedSuggestion = suggestions[0];

  useEffect(() => {
    props.approvalResolver.bind(setRequest);
    return () => props.approvalResolver.dispose();
  }, [props.approvalResolver]);
  const pushLine = useCallback(
    (text: string, tone: TranscriptTone = "assistant"): void => {
      const flushed = streamingRef.current;
      streamingRef.current = null;
      setStreaming(null);
      const id = nextTranscriptId.current++;
      setTranscript((lines) => [
        ...lines,
        ...(flushed ? [flushed] : []),
        { id, text, tone },
      ]);
      setTranscriptOffset(0);
    },
    [],
  );

  const appendToStreaming = useCallback((text: string): void => {
    const current = streamingRef.current;
    if (current) {
      const next = { ...current, text: current.text + text };
      streamingRef.current = next;
      setStreaming(next);
    } else {
      const line: TuiTranscriptLine = {
        id: nextTranscriptId.current++,
        text,
        tone: "assistant",
      };
      streamingRef.current = line;
      setStreaming(line);
    }
    setTranscriptOffset(0);
  }, []);

  const clearAll = useCallback((): void => {
    streamingRef.current = null;
    setStreaming(null);
    setTranscript([]);
    setTranscriptOffset(0);
  }, []);

  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const flushed = streamingRef.current;
      if (flushed) {
        streamingRef.current = null;
        setStreaming(null);
        setTranscript((lines) => [...lines, flushed]);
        setTranscriptOffset(0);
      }
    }
    wasBusy.current = busy;
  }, [busy]);

  useEffect(() => {
    props.bindTranscript({
      append: (text, tone = "assistant") => pushLine(text, tone),
      appendToLast: (text) => appendToStreaming(text),
      clear: () => clearAll(),
    });
  }, [props.bindTranscript, pushLine, appendToStreaming, clearAll]);

  function append(text: string, tone: TranscriptTone = "assistant"): void {
    pushLine(text, tone);
  }
  function submit(value: string): void {
    const prompt = value.trim();
    if (!prompt) return;
    const command = parseSlashCommand(prompt);
    if (command) {
      void runCommand(command.name, command.args);
      return;
    }
    if (isSlashInput(prompt)) {
      append(`Неизвестная команда: ${prompt}. Введите /help.`, "error");
      setEditor((state) => addEditorHistory(state, prompt));
      return;
    }
    setEditor((state) => addEditorHistory(state, prompt));
    setBusy(true);
    void props
      .onSubmit(prompt)
      .catch((cause) =>
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        ),
      )
      .finally(() => setBusy(false));
  }
  async function runCommand(name: SlashCommandName, args = ""): Promise<void> {
    setEditor(createEditorState());
    if (name === "/help") {
      append(commandHelpText(), "info");
      return;
    }
    if (name === "/clear") {
      clearAll();
      return;
    }
    if (name === "/exit") {
      exit();
      return;
    }
    if (name === "/cwd") {
      setBusy(true);
      try {
        append(await props.onSwitchProject(args), "info");
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (name === "/settings") {
      setSettings("menu");
      return;
    }
    if (name === "/model") {
      setSettings("model");
      return;
    }
    if (name === "/update") {
      setBusy(true);
      try {
        append(
          (await props.onCheckUpdate?.()) ??
            "Проверка обновлений недоступна в этом сеансе. Откройте https://github.com/TheAsrada/ChiselCode/releases",
          "info",
        );
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (name === "/doctor") {
      setBusy(true);
      try {
        append(await (props.onDoctor?.() ?? props.onStatus()), "info");
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      append(await props.onStatus(), "info");
    } catch (cause) {
      append(
        `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  function requestSetupRestart(): void {
    setSettings(undefined);
    setRestartingSetup(true);
  }

  async function completeRestartedSetup(values: SetupValues): Promise<void> {
    await props.onCompleteSetup(values);
    setRuntime({
      provider: values.provider,
      providerLabel: providerName(values.provider),
      model: values.model,
      baseUrl: values.baseUrl,
    });
    setRestartingSetup(false);
    pushLine(
      `✓ Настройка обновлена: ${providerName(values.provider)}, модель ${values.model}.`,
      "success",
    );
  }

  function cancelRestartedSetup(): void {
    setRestartingSetup(false);
  }

  useInput((character, key) => {
    if (request) {
      if (character.toLowerCase() === "y")
        props.approvalResolver.resolve("approved");
      if (character.toLowerCase() === "n" || key.escape)
        props.approvalResolver.resolve("denied");
      return;
    }
    if (settings || restartingSetup || busy) return;
    // Скролл журнала как в Claude Code: ввод закреплён снизу,
    // история листается постранично (PgUp/PgDn), построчно (Shift+↑/↓),
    // Home/End — начало/конец, Esc — вернуться вниз к вводу.
    if (key.escape && transcriptOffset > 0) {
      setTranscriptOffset(0);
      return;
    }
    if (key.shift && key.upArrow) {
      setTranscriptOffset((offset) =>
        Math.min(offset + 1, maxTranscriptOffset(transcriptLines)),
      );
      return;
    }
    if (key.shift && key.downArrow) {
      setTranscriptOffset((offset) => Math.max(offset - 1, 0));
      return;
    }
    if (key.pageUp) {
      const firstVisible = visible.lines[0];
      const firstVisibleIndex = firstVisible
        ? transcriptLines.indexOf(firstVisible)
        : -1;
      if (firstVisibleIndex >= 0)
        setTranscriptOffset(
          Math.min(
            transcriptLines.length - firstVisibleIndex,
            maxTranscriptOffset(transcriptLines),
          ),
        );
      return;
    }
    if (key.pageDown) {
      setTranscriptOffset((offset) =>
        Math.max(offset - Math.max(visible.lines.length, 1), 0),
      );
      return;
    }
    if (key.home) {
      setTranscriptOffset(maxTranscriptOffset(transcriptLines));
      return;
    }
    if (key.end) {
      setTranscriptOffset(0);
      return;
    }
    if (key.ctrl && character === "c") {
      exit();
      return;
    }
    if (key.tab && selectedSuggestion) {
      setEditor((state) => ({
        ...state,
        value: selectedSuggestion.name,
        cursor: selectedSuggestion.name.length,
      }));
      return;
    }
    if (key.return) {
      if (key.shift) {
        setEditor((state) => insertEditorText(state, "\n"));
        return;
      }
      if (
        selectedSuggestion &&
        editor.value.trim() !== selectedSuggestion.name
      ) {
        setEditor((state) => ({
          ...state,
          value: selectedSuggestion.name,
          cursor: selectedSuggestion.name.length,
        }));
        return;
      }
      submit(editor.value);
      return;
    }
    if (key.upArrow && isFirstEditorLine(editor)) {
      setEditor((state) => navigateEditorHistory(state, -1));
      return;
    }
    if (key.downArrow && isLastEditorLine(editor)) {
      setEditor((state) => navigateEditorHistory(state, 1));
      return;
    }
    if (key.leftArrow) {
      setEditor((state) => moveEditorCursor(state, -1));
      return;
    }
    if (key.rightArrow) {
      setEditor((state) => moveEditorCursor(state, 1));
      return;
    }
    if (key.backspace) {
      setEditor(backspaceEditorText);
      return;
    }
    if (key.delete) {
      setEditor(deleteEditorText);
      return;
    }
    if (!key.ctrl && !key.meta && character)
      setEditor((state) => insertEditorText(state, character));
  });

  if (restartingSetup)
    return (
      <Box
        flexDirection="column"
        height={viewport.rows}
        width={viewport.columns}
        overflow="hidden"
      >
        <Header
          providerLabel={runtime.providerLabel}
          model={runtime.model}
          columns={viewport.columns}
          version={props.version}
        />
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          overflow="hidden"
          width="100%"
        >
          <SetupApp
            onComplete={completeRestartedSetup}
            onCancel={cancelRestartedSetup}
            exitOnComplete={false}
          />
        </Box>
      </Box>
    );
  if (settings)
    return (
      <Box
        flexDirection="column"
        height={viewport.rows}
        width={viewport.columns}
        overflow="hidden"
      >
        <Header
          providerLabel={runtime.providerLabel}
          model={runtime.model}
          columns={viewport.columns}
          version={props.version}
        />
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          overflow="hidden"
          width="100%"
        >
          <SettingsPanel
            initialValues={{
              provider: runtime.provider,
              model: runtime.model,
              baseUrl: runtime.baseUrl,
            }}
            initialScreen={settings}
            onSave={props.onSaveSettings}
            onClose={() => setSettings(undefined)}
            onCheckConnection={props.onCheckConnection}
            onSetupRequested={requestSetupRestart}
            onSaved={(values) =>
              setRuntime({
                provider: values.provider,
                providerLabel: providerName(values.provider),
                model: values.model,
                baseUrl: values.baseUrl,
              })
            }
          />
        </Box>
      </Box>
    );
  const footer = request ? (
    <Approval request={request} columns={viewport.columns} />
  ) : (
    <Editor
      value={editor.value}
      cursor={editor.cursor}
      busy={busy}
      model={runtime.model}
      suggestions={suggestions}
      columns={viewport.columns}
    />
  );
  const footerRows = estimateFooterHeight({
    request,
    busy,
    editorValue: editor.value,
    columns: viewport.columns,
    suggestionsCount: suggestions.length,
    suggestionLines: suggestions.map((command) =>
      suggestionLineText(command.name, command.description),
    ),
    model: runtime.model,
  });
  const transcriptLines = streaming ? [...transcript, streaming] : transcript;
  const clampedTranscriptOffset = Math.min(
    transcriptOffset,
    maxTranscriptOffset(transcriptLines),
  );
  const visible = visibleTranscriptWindow(
    transcriptLines,
    viewport.rows,
    viewport.columns,
    footerRows,
    clampedTranscriptOffset,
    TUI_HEADER_ROWS,
  );

  return (
    <Box
      flexDirection="column"
      height={viewport.rows}
      width={viewport.columns}
      overflow="hidden"
    >
      <Header
        providerLabel={runtime.providerLabel}
        model={runtime.model}
        columns={viewport.columns}
        version={props.version}
      />
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        width="100%"
      >
        {visible.hiddenAboveCount > 0 ? (
          <Box width="100%" flexShrink={0}>
            <Text dimColor wrap="truncate">
              … ↑ ещё {visible.hiddenAboveCount} записей выше
            </Text>
          </Box>
        ) : null}
        {visible.lines.map((line) => (
          <TranscriptLineView
            key={line.id}
            line={line}
            columns={viewport.columns}
          />
        ))}
        {visible.hiddenBelowCount > 0 ? (
          <Box width="100%" flexShrink={0}>
            <Text dimColor wrap="truncate">
              … ↓ ещё {visible.hiddenBelowCount} записей ниже
            </Text>
          </Box>
        ) : null}
      </Box>
      <Box flexDirection="column" flexShrink={0} width="100%">
        {footer}
      </Box>
    </Box>
  );
}

function Header({
  providerLabel,
  model,
  columns,
  version,
}: {
  providerLabel: string;
  model: string;
  columns: number;
  version?: string;
}): React.JSX.Element {
  const safeColumns = normalizeViewport({ columns }).columns;
  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box width="100%">
        <Text bold color="cyan">
          ◈ ChiselCode
        </Text>
        {version ? <Text dimColor> v{version}</Text> : null}
        <Text dimColor> · </Text>
        <Text color="magenta" wrap="truncate-end">
          {providerLabel}
        </Text>
        <Text dimColor> · </Text>
        <Text color="yellow" wrap="truncate-end">
          {model}
        </Text>
      </Box>
      <Text dimColor wrap="truncate">
        {fullWidthSeparator(safeColumns)}
      </Text>
    </Box>
  );
}
function TranscriptLineView({
  line,
  columns,
}: {
  line: TuiTranscriptLine;
  columns: number;
}): React.JSX.Element {
  const tone = line.tone ?? "assistant";
  if (tone === "brand") {
    const [provider, ...modelParts] = line.text.split(" · ");
    return (
      <Box flexDirection="column" marginBottom={1} width="100%" flexShrink={0}>
        <Box width="100%">
          <Text bold color="cyan">
            ◈ ChiselCode
          </Text>
          <Text dimColor> · </Text>
          <Text color="magenta" wrap="truncate-end">
            {provider ?? ""}
          </Text>
          <Text dimColor> · </Text>
          <Text color="yellow" wrap="truncate-end">
            {modelParts.join(" · ")}
          </Text>
        </Box>
        <Text dimColor wrap="truncate">
          {fullWidthSeparator(columns)}
        </Text>
      </Box>
    );
  }
  if (tone === "user") {
    // Одна Text-нода во всю ширину: при ресайзе Ink сам переоборачивает
    // строку и ввод/история не «съезжают» по горизонтали.
    // flexShrink={0}: Yoga никогда не схлопывает строки истории в ноль
    // при неточной смете — переполнение режется снизу, а не в середине.
    const clean = line.text.replace(/^›\s?/, "");
    return (
      <Box marginTop={1} width="100%" flexShrink={0}>
        <Text bold wrap="wrap">
          <Text bold color="green">
            ›{" "}
          </Text>
          {clean}
        </Text>
      </Box>
    );
  }
  if (tone === "tool") {
    const summary = line.text.replace(/^\[chisel\]\s?/, "");
    const preview =
      summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
    return (
      <Box width="100%" flexShrink={0}>
        <Text dimColor wrap="wrap">
          <Text color="cyan">⟡ </Text>
          {preview}
        </Text>
      </Box>
    );
  }
  if (tone === "success")
    return (
      <Box width="100%" flexShrink={0}>
        <Text color="green" wrap="wrap">
          {line.text}
        </Text>
      </Box>
    );
  if (tone === "error")
    return (
      <Box width="100%" flexShrink={0}>
        <Text color="red" wrap="wrap">
          ✗ {line.text}
        </Text>
      </Box>
    );
  if (tone === "warn")
    return (
      <Box width="100%" flexShrink={0}>
        <Text color="yellow" wrap="wrap">
          ⚠ {line.text}
        </Text>
      </Box>
    );
  if (tone === "info")
    return (
      <Box width="100%" flexShrink={0}>
        <Text wrap="wrap">{line.text}</Text>
      </Box>
    );
  return (
    <Box marginTop={1} width="100%" flexShrink={0}>
      <MarkdownText text={line.text} columns={columns} />
    </Box>
  );
}
function providerName(provider: ProviderKind): string {
  if (provider === "anthropic") return "Anthropic (Claude)";
  if (provider === "anthropic-compatible") return "Anthropic-совместимый API";
  if (provider === "openai") return "OpenAI";
  return "OpenAI-совместимый API";
}

function approvalPreview(request: ApprovalRequest): string {
  const previewLines = request.preview.split("\n");
  return previewLines.length > 12
    ? `${previewLines.slice(0, 12).join("\n")}\n… (полный текст в скроллбэке не показан)`
    : request.preview;
}

function estimateApprovalHeight(
  request: ApprovalRequest,
  columns: number,
): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  const width = Math.max(safeColumns - 4, 10);
  const meta = toolDisplay(request.tool);
  const header = `? [${meta.icon}] ${meta.label} — нужно подтверждение`;
  const controls = "[y] разрешить · [n] отклонить (Esc — тоже отклонить)";
  // marginTop (1) + рамка (2) + вертикальные отступы preview (2) +
  // заголовок, preview и controls с переносом по внутренней ширине.
  return (
    5 +
    wrappedLines(header, width) +
    wrappedLines(approvalPreview(request), width) +
    wrappedLines(controls, width)
  );
}

export interface FooterHeightInput {
  request?: ApprovalRequest;
  busy: boolean;
  editorValue?: string;
  columns?: number;
  suggestionsCount: number;
  /** Точные строки подсказок (для переноса на узких окнах). */
  suggestionLines?: string[];
  /** Модель для строки спиннера «Думаю…». */
  model?: string;
}

/** Высота нижней панели с учётом подсказок и многострочного черновика. */
export function estimateFooterHeight({
  request,
  busy,
  editorValue = "",
  columns = 80,
  suggestionsCount,
  suggestionLines,
  model = "",
}: FooterHeightInput): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  if (request) return estimateApprovalHeight(request, safeColumns);
  const innerWidth = Math.max(safeColumns - 4, 10);
  // Ввод живёт внутри рамки (2) + paddingX (2) + префикс «› » (2).
  // Спиннер: рамка + paddingX, текст «⠋ Думаю 99с · модель» с запасом под секундомер.
  const editorRows = busy
    ? wrappedLines(`⠋ Думаю 99с · ${model}`, innerWidth)
    : wrappedLines(editorValue || " ", Math.max(safeColumns - 6, 10));
  const lines =
    suggestionLines ??
    Array.from({ length: Math.max(suggestionsCount, 0) }, () => " ");
  const suggestionsRows =
    !busy && lines.length > 0
      ? 3 + lines.reduce((sum, l) => sum + wrappedLines(l, innerWidth), 0)
      : 0;
  // Верхний отступ (1) + рамка редактора (2) + строка горячих клавиш.
  return (
    editorRows + 3 + wrappedLines(HOTKEYS_HINT, safeColumns) + suggestionsRows
  );
}

export interface VisibleTranscriptTail {
  lines: TuiTranscriptLine[];
  hiddenCount: number;
}

export interface VisibleTranscriptWindow {
  lines: TuiTranscriptLine[];
  hiddenAboveCount: number;
  hiddenBelowCount: number;
}

export function maxTranscriptOffset(lines: TuiTranscriptLine[]): number {
  return Math.max(lines.length - 1, 0);
}

function selectTranscriptStart(
  lines: TuiTranscriptLine[],
  end: number,
  columns: number,
  budget: number,
): number {
  let used = 0;
  let start = end;
  for (let i = end - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) break;
    const height = estimateLineHeight(line, columns);
    // Даже одна высокая запись остаётся доступной в очень маленьком окне.
    if (used + height > budget && start < end) break;
    used += height;
    start = i;
    if (used >= budget) break;
  }
  return start;
}

/** Выбирает доступное окно истории над закреплённой нижней панелью. */
export function visibleTranscriptWindow(
  lines: TuiTranscriptLine[],
  rows: number,
  columns: number,
  footerRows: number,
  offset = 0,
  topRows = 0,
): VisibleTranscriptWindow {
  const safeRows = Math.max(Math.floor(rows) || TUI_FALLBACK_ROWS, 1);
  const safeColumns = normalizeViewport({ columns }).columns;
  const contentRows = Math.max(safeRows - footerRows - topRows, 0);
  const safeOffset = Math.max(0, Math.min(offset, maxTranscriptOffset(lines)));
  const end = lines.length - safeOffset;
  const belowRows = safeOffset > 0 ? 1 : 0;
  let start = selectTranscriptStart(
    lines,
    end,
    safeColumns,
    Math.max(contentRows - belowRows, 0),
  );
  // Верхний индикатор, как и нижний, занимает строку внутри viewport.
  if (start > 0) {
    start = selectTranscriptStart(
      lines,
      end,
      safeColumns,
      Math.max(contentRows - belowRows - 1, 0),
    );
  }
  return {
    lines: lines.slice(start, end),
    hiddenAboveCount: start,
    hiddenBelowCount: lines.length - end,
  };
}

/** Совместимый помощник: показывает самый новый хвост истории. */
export function visibleTranscriptTail(
  lines: TuiTranscriptLine[],
  rows: number,
  columns: number,
  footerRows: number,
  topRows = 0,
): VisibleTranscriptTail {
  const visible = visibleTranscriptWindow(
    lines,
    rows,
    columns,
    footerRows,
    0,
    topRows,
  );
  return { lines: visible.lines, hiddenCount: visible.hiddenAboveCount };
}

/**
 * Число строк текста с учётом переноса.
 * Второй аргумент — уже доступная ширина (usable width), а не ширина окна.
 * Вызывающий вычитает рамки/отступы/префиксы сам — так оценка совпадает
 * с реальным рендером Ink при любом размере окна.
 */
export function wrappedLines(text: string, usableWidth: number): number {
  const width = Math.max(Math.floor(usableWidth) || 10, 10);
  return text
    .split("\n")
    .reduce(
      (total, line) => total + Math.max(1, Math.ceil(line.length / width)),
      0,
    );
}

/** Оценка высоты строки истории в строках терминала. */
function estimateLineHeight(line: TuiTranscriptLine, columns: number): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  const tone = line.tone ?? "assistant";
  if (tone === "brand") return 3; // две строки + отступ
  if (tone === "user")
    return 1 + wrappedLines(line.text, Math.max(safeColumns - 2, 10)); // отступ + «› »
  if (tone === "tool") {
    const summary =
      line.text.length > 200 ? `${line.text.slice(0, 200)}…` : line.text;
    return wrappedLines(summary, Math.max(safeColumns - 2, 10)); // префикс «⟡ »
  }
  // Префиксы «✗ »/«⚠ » занимают клетки первой строки — считаем вместе с текстом,
  // иначе смета занижена и Yoga схлопывает соседние строки истории.
  if (tone === "error") return wrappedLines(`✗ ${line.text}`, safeColumns);
  if (tone === "warn") return wrappedLines(`⚠ ${line.text}`, safeColumns);
  if (tone === "success") return wrappedLines(line.text, safeColumns);
  if (tone === "info") return wrappedLines(line.text, safeColumns);
  // assistant: markdown-раскладка + верхний отступ
  return 1 + estimateMarkdownHeight(line.text, safeColumns);
}

/** Оценка высоты markdown-ответа (заголовки, списки, код в рамках и т.д.). */
function estimateMarkdownHeight(text: string, columns: number): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  const quoteWidth = Math.max(safeColumns - 2, 10);
  const codeWidth = Math.max(safeColumns - 4, 10);
  return parseBlocks(text).reduce((total, block) => {
    if (block.kind === "hr") return total + 1;
    if (block.kind === "heading")
      return total + wrappedLines(block.text, safeColumns);
    if (block.kind === "paragraph")
      return total + wrappedLines(block.text, safeColumns);
    if (block.kind === "quote")
      return (
        total +
        block.text
          .split("\n")
          .reduce(
            (sum, l) => sum + Math.max(1, Math.ceil(l.length / quoteWidth)),
            0,
          )
      );
    if (block.kind === "list")
      return (
        total +
        block.items.reduce(
          (sum, item) =>
            sum + Math.max(1, Math.ceil((item.length + 2) / safeColumns)),
          0,
        )
      );
    // код: рамки (2) + marginY (2) + возможный язык (1) + строки с переносом
    const codeRows = block.code
      .split("\n")
      .reduce(
        (sum, l) => sum + Math.max(1, Math.ceil(l.length / codeWidth)),
        0,
      );
    return total + codeRows + 4 + (block.language ? 1 : 0);
  }, 0);
}
function Approval({
  request,
  columns,
}: {
  request: ApprovalRequest;
  columns: number;
}): React.JSX.Element {
  const meta = toolDisplay(request.tool);
  const preview = approvalPreview(request);
  void columns;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
      width="100%"
      flexShrink={0}
    >
      <Text bold color="yellow" wrap="wrap">
        ? [{meta.icon}] {meta.label} — нужно подтверждение
      </Text>
      <Box marginY={1} width="100%">
        <Text wrap="wrap">{preview}</Text>
      </Box>
      <Text wrap="wrap">
        [
        <Text bold color="green">
          y
        </Text>
        ] разрешить · [
        <Text bold color="red">
          n
        </Text>
        ] отклонить <Text dimColor>(Esc — тоже отклонить)</Text>
      </Text>
    </Box>
  );
}
function Editor({
  value,
  cursor,
  busy,
  model,
  suggestions,
  columns,
}: {
  value: string;
  cursor: number;
  busy: boolean;
  model: string;
  suggestions: ReturnType<typeof matchingCommands>;
  columns: number;
}): React.JSX.Element {
  void columns;
  return (
    <Box flexDirection="column" marginTop={1} width="100%" flexShrink={0}>
      {suggestions.length && !busy ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
          width="100%"
          flexShrink={0}
        >
          {suggestions.map((command, index) => (
            <Text key={command.name} wrap="truncate-end">
              {index === 0 ? (
                <>
                  <Text bold color="green">
                    › {command.name}
                  </Text>
                  <Text dimColor> — {command.description}</Text>
                </>
              ) : (
                <Text dimColor>
                  {" "}
                  {command.name} — {command.description}
                </Text>
              )}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box
        borderStyle="round"
        borderColor={busy ? "yellow" : "cyan"}
        paddingX={1}
        width="100%"
        flexShrink={0}
      >
        {busy ? (
          <Thinking model={model} />
        ) : value ? (
          <Box width="100%">
            <Text wrap="wrap">
              <Text bold color="green">
                ›{" "}
              </Text>
              {renderWithCursor(value, cursor)}
            </Text>
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">
            › Спросите что-нибудь… ( / — команды )
          </Text>
        )}
      </Box>
      <Text dimColor wrap="wrap">
        {HOTKEYS_HINT}
      </Text>
    </Box>
  );
}

/** Текст ввода с видимым курсором (инверсия символа под курсором). */
function renderWithCursor(value: string, cursor: number): React.ReactNode {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, safeCursor);
  const at = value[safeCursor];
  const after = value.slice(safeCursor + 1);
  return (
    <>
      <Text>{before}</Text>
      {at === undefined ? (
        <Text color="green">█</Text>
      ) : (
        <Text inverse>{at}</Text>
      )}
      <Text>{after}</Text>
    </>
  );
}
function intro(
  providerLabel: string,
  model: string,
  version?: string,
): TuiTranscriptLine[] {
  // Шапка теперь закреплена сверху окна (Header), поэтому в истории
  // остаются только приветственные строки — задвоения нет и после
  // /clear шапка не пропадает, как в Claude Code.
  const lines = welcomeLines(providerLabel, model, version ?? "");
  return lines.map((text, index) => ({
    id: index,
    text,
    tone: "info" as const,
  }));
}
