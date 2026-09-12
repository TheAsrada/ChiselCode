import { Box, Text, useApp, useInput } from "ink";
import type React from "react";
import { useEffect, useRef, useState } from "react";
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
import { SettingsPanel, type TuiSettingsValues } from "./settings.js";

export interface TuiApprovalResolver extends ApprovalResolver {
  bind(setter?: (request: ApprovalRequest | undefined) => void): void;
  resolve(decision: ApprovalDecision): void;
  dispose(): void;
}

export interface TuiTranscriptLine {
  id: number;
  text: string;
}
export interface TuiTranscript {
  append(line: string): void;
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
  const nextTranscriptId = useRef(2);
  const suggestions = isSlashInput(editor.value)
    ? matchingCommands(editor.value)
    : [];
  const selectedSuggestion = suggestions[0];

  useEffect(() => {
    props.approvalResolver.bind(setRequest);
    return () => props.approvalResolver.dispose();
  }, [props.approvalResolver]);
  useEffect(() => {
    props.bindTranscript({
      append: (text) =>
        setTranscript((lines) => [
          ...lines,
          { id: nextTranscriptId.current++, text },
        ]),
      appendToLast: (text) =>
        setTranscript((lines) => {
          const last = lines.at(-1);
          return last
            ? [...lines.slice(0, -1), { ...last, text: last.text + text }]
            : [{ id: nextTranscriptId.current++, text }];
        }),
      clear: () => setTranscript([]),
    });
  }, [props.bindTranscript]);

  function append(text: string): void {
    setTranscript((lines) => [
      ...lines,
      { id: nextTranscriptId.current++, text },
    ]);
  }
  function submit(value: string): void {
    const prompt = value.trim();
    if (!prompt) return;
    const command = parseSlashCommand(prompt);
    if (command) {
      void runCommand(command.name);
      return;
    }
    if (isSlashInput(prompt)) {
      append(`Неизвестная команда: ${prompt}. Введите /help.`);
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
        ),
      )
      .finally(() => setBusy(false));
  }
  async function runCommand(name: SlashCommandName): Promise<void> {
    setEditor(createEditorState());
    if (name === "/help") {
      append(commandHelpText());
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
      append(await props.onStatus());
    } catch (cause) {
      append(
        `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
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
        <Header />
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
      <Header />
      {transcript.map((line) => (
        <Text key={line.id}>{line.text}</Text>
      ))}
      {request ? (
        <Approval request={request} />
      ) : (
        <Editor
          value={editor.value}
          cursor={editor.cursor}
          busy={busy}
          suggestions={suggestions}
        />
      )}
    </Box>
  );
}

function Header(): React.JSX.Element {
  return (
    <Text bold color="cyan">
      ChiselCode
    </Text>
  );
}
function providerName(provider: ProviderKind): string {
  if (provider === "anthropic") return "Anthropic (Claude)";
  if (provider === "anthropic-compatible") return "Anthropic-совместимый API";
  if (provider === "openai") return "OpenAI";
  return "OpenAI-совместимый API";
}
function Approval({
  request,
}: {
  request: ApprovalRequest;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">Нужно подтверждение для {request.tool}</Text>
      <Text>{request.preview}</Text>
      <Text>Разрешить? [y/N]</Text>
    </Box>
  );
}
function Editor({
  value,
  cursor,
  busy,
  suggestions,
}: {
  value: string;
  cursor: number;
  busy: boolean;
  suggestions: ReturnType<typeof matchingCommands>;
}): React.JSX.Element {
  const rendered = `${value.slice(0, cursor)}${cursor === value.length ? "█" : ""}${value.slice(cursor)}`;
  return (
    <Box flexDirection="column" marginTop={1}>
      {busy ? (
        <Text color="yellow">ChiselCode отвечает…</Text>
      ) : (
        <Text color="green">› {rendered}</Text>
      )}
      {suggestions.length ? (
        <Box flexDirection="column">
          {suggestions.map((command, index) => (
            <Text key={command.name} color={index === 0 ? "green" : undefined}>
              {index === 0 ? "› " : "  "}
              {command.name} — {command.description}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text dimColor>
        Enter — отправить · Shift+Enter — новая строка · / — команды
      </Text>
    </Box>
  );
}
function intro(providerLabel: string, model: string): TuiTranscriptLine[] {
  return [
    {
      id: 0,
      text: `Готово. ${providerLabel}, модель ${model}. Напишите задачу или /help.`,
    },
    { id: 1, text: "Изменения всегда требуют подтверждения y/n." },
  ];
}
