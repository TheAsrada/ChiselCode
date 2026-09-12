import { Box, Static, Text, useApp, useInput } from "ink";
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
import { MarkdownText } from "./markdown.js";
import { SettingsPanel, type TuiSettingsValues } from "./settings.js";
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
  onSaveSettings(
    values: TuiSettingsValues,
  ): Promise<"saved" | "setup_required">;
  onRestartSetup(): void;
  provider: ProviderKind;
  providerLabel: string;
  model: string;
  baseUrl?: string;
}

export function TuiApp(props: TuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [editor, setEditor] = useState(createEditorState);
  const [request, setRequest] = useState<ApprovalRequest>();
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<"menu" | "model">();
  const [runtime, setRuntime] = useState(() => ({
    provider: props.provider,
    providerLabel: props.providerLabel,
    model: props.model,
    baseUrl: props.baseUrl,
  }));
  const [transcript, setTranscript] = useState<TuiTranscriptLine[]>(
    intro(props.providerLabel, props.model),
  );
  // Незавершённый стриминговый ответ живёт отдельно от истории:
  // история уходит в <Static> (скроллится вверх), а ввод остаётся внизу.
  const [streaming, setStreaming] = useState<TuiTranscriptLine | null>(null);
  const streamingRef = useRef<TuiTranscriptLine | null>(null);
  const nextTranscriptId = useRef(4);
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
  }, []);

  const clearAll = useCallback((): void => {
    streamingRef.current = null;
    setStreaming(null);
    setTranscript([]);
  }, []);

  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const flushed = streamingRef.current;
      if (flushed) {
        streamingRef.current = null;
        setStreaming(null);
        setTranscript((lines) => [...lines, flushed]);
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
      setTranscript([]);
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

  useInput((character, key) => {
    if (request) {
      if (character.toLowerCase() === "y")
        props.approvalResolver.resolve("approved");
      if (character.toLowerCase() === "n" || key.escape)
        props.approvalResolver.resolve("denied");
      return;
    }
    if (settings || busy) return;
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

  if (settings)
    return (
      <Box flexDirection="column">
        <Header providerLabel={runtime.providerLabel} model={runtime.model} />
        <SettingsPanel
          initialValues={{
            provider: runtime.provider,
            model: runtime.model,
            baseUrl: runtime.baseUrl,
          }}
          initialScreen={settings}
          onSave={props.onSaveSettings}
          onClose={() => setSettings(undefined)}
          onSetupRequested={() => {
            props.onRestartSetup();
            exit();
          }}
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
    );
  return (
    <Box flexDirection="column">
      <Static items={transcript}>
        {(line) => (
          <TranscriptLineView
            key={line.id}
            line={line}
            providerLabel={runtime.providerLabel}
            model={runtime.model}
          />
        )}
      </Static>
      {streaming ? (
        <TranscriptLineView
          line={streaming}
          providerLabel={runtime.providerLabel}
          model={runtime.model}
        />
      ) : null}
      {request ? (
        <Approval request={request} />
      ) : (
        <Editor
          value={editor.value}
          cursor={editor.cursor}
          busy={busy}
          model={runtime.model}
          suggestions={suggestions}
        />
      )}
    </Box>
  );
}

function Header({
  providerLabel,
  model,
}: {
  providerLabel: string;
  model: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">
          ◈ ChiselCode
        </Text>
        <Text dimColor> · </Text>
        <Text color="magenta">{providerLabel}</Text>
        <Text dimColor> · </Text>
        <Text color="yellow">{model}</Text>
      </Box>
      <Text dimColor>────────────────────────────────────────</Text>
    </Box>
  );
}
function TranscriptLineView({
  line,
  providerLabel,
  model,
}: {
  line: TuiTranscriptLine;
  providerLabel: string;
  model: string;
}): React.JSX.Element {
  const tone = line.tone ?? "assistant";
  if (tone === "brand") {
    const [provider, ...modelParts] = line.text.split(" · ");
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text bold color="cyan">
            ◈ ChiselCode
          </Text>
          <Text dimColor> · </Text>
          <Text color="magenta">{provider ?? providerLabel}</Text>
          <Text dimColor> · </Text>
          <Text color="yellow">{modelParts.join(" · ") || model}</Text>
        </Box>
        <Text dimColor>────────────────────────────────────────</Text>
      </Box>
    );
  }
  if (tone === "user")
    return (
      <Box marginTop={1}>
        <Text bold color="green">
          ›{" "}
        </Text>
        <Text bold>{line.text.replace(/^›\s?/, "")}</Text>
      </Box>
    );
  if (tone === "tool") {
    const summary = line.text.replace(/^\[chisel\]\s?/, "");
    const preview =
      summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
    return (
      <Text dimColor>
        <Text color="cyan">⟡ </Text>
        {preview}
      </Text>
    );
  }
  if (tone === "error") return <Text color="red">✗ {line.text}</Text>;
  if (tone === "warn") return <Text color="yellow">⚠ {line.text}</Text>;
  if (tone === "info") return <Text>{line.text}</Text>;
  return (
    <Box marginTop={1}>
      <MarkdownText text={line.text} />
    </Box>
  );
}
function providerName(provider: ProviderKind): string {
  if (provider === "anthropic") return "Anthropic (Claude)";
  if (provider === "anthropic-compatible") return "Anthropic-совместимый API";
  if (provider === "openai") return "OpenAI";
  return "OpenAI-совместимый API";
}
const TOOL_META: Record<string, { icon: string; label: string }> = {
  write_file: { icon: "+", label: "Запись файла" },
  edit_file: { icon: "~", label: "Редактирование файла" },
  delete_file: { icon: "×", label: "Удаление файла" },
  run_shell: { icon: "$", label: "Команда shell" },
  git_commit: { icon: "#", label: "Git commit" },
};

function Approval({
  request,
}: {
  request: ApprovalRequest;
}): React.JSX.Element {
  const meta = TOOL_META[request.tool] ?? { icon: "?", label: request.tool };
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
    >
      <Text bold color="yellow">
        ? [{meta.icon}] {meta.label} — нужно подтверждение
      </Text>
      <Box marginY={1}>
        <Text>{request.preview}</Text>
      </Box>
      <Text>
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
}: {
  value: string;
  cursor: number;
  busy: boolean;
  model: string;
  suggestions: ReturnType<typeof matchingCommands>;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      {suggestions.length && !busy ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
        >
          {suggestions.map((command, index) => (
            <Text key={command.name}>
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
      >
        {busy ? (
          <Thinking model={model} />
        ) : value ? (
          <Text>
            <Text bold color="green">
              ›{" "}
            </Text>
            {renderWithCursor(value, cursor)}
          </Text>
        ) : (
          <Text dimColor>› Спросите что-нибудь… ( / — команды )</Text>
        )}
      </Box>
      <Text dimColor>
        Enter — отправить · Shift+Enter — новая строка · ↑/↓ — история
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
function intro(providerLabel: string, model: string): TuiTranscriptLine[] {
  return [
    {
      id: 0,
      text: `${providerLabel} · ${model}`,
      tone: "brand",
    },
    {
      id: 1,
      text: `Готово. ${providerLabel}, модель ${model}. Напишите задачу или /help.`,
      tone: "info",
    },
    {
      id: 2,
      text: "Изменения всегда требуют подтверждения y/n.",
      tone: "info",
    },
    {
      id: 3,
      text: "Подсказка: /cwd <путь> — сменить проект, Tab — дополнить команду.",
      tone: "info",
    },
  ];
}
