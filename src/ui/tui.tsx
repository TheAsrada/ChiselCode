import { Box, Text, useApp, useInput } from "ink";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolver,
} from "../security/approval.js";

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
}

export function createTuiApprovalResolver(): TuiApprovalResolver {
  let resolvePending: ((decision: ApprovalDecision) => void) | undefined;
  let setRequest: ((request: ApprovalRequest | undefined) => void) | undefined;

  return {
    async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
      if (!setRequest) return "unavailable";
      return new Promise<ApprovalDecision>((resolve) => {
        resolvePending = resolve;
        setRequest?.(request);
      });
    },
    bind(setter?: (request: ApprovalRequest | undefined) => void): void {
      setRequest = setter;
    },
    resolve(decision: ApprovalDecision): void {
      resolvePending?.(decision);
      resolvePending = undefined;
      setRequest?.(undefined);
    },
    dispose(): void {
      resolvePending?.("unavailable");
      resolvePending = undefined;
      setRequest = undefined;
    },
  } as TuiApprovalResolver;
}

export interface TuiAppProps {
  approvalResolver: TuiApprovalResolver;
  bindTranscript: (transcript: TuiTranscript) => void;
  onSubmit: (prompt: string) => void;
  providerLabel: string;
  model: string;
}

export function TuiApp({
  approvalResolver,
  bindTranscript,
  onSubmit,
  providerLabel,
  model,
}: TuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [request, setRequest] = useState<ApprovalRequest>();
  const [transcript, setTranscript] = useState<TuiTranscriptLine[]>([
    {
      id: 0,
      text: `Готово. ${providerLabel}, модель ${model}. Напишите задачу обычными словами и нажмите Enter.`,
    },
    {
      id: 1,
      text: "Например: «Объясни структуру проекта» или «Найди ошибки в коде». Изменения всегда требуют подтверждения y/n.",
    },
  ]);
  const nextTranscriptId = useRef(2);

  useEffect(() => {
    approvalResolver.bind(setRequest);
    return () => {
      approvalResolver.dispose();
    };
  }, [approvalResolver]);

  useEffect(() => {
    bindTranscript({
      append: (text) =>
        setTranscript((lines) => [
          ...lines,
          { id: nextTranscriptId.current++, text },
        ]),
      appendToLast: (text) =>
        setTranscript((lines) => {
          const last = lines.at(-1);
          if (!last) return [{ id: nextTranscriptId.current++, text }];
          return [...lines.slice(0, -1), { ...last, text: last.text + text }];
        }),
    });
  }, [bindTranscript]);

  useInput((character, key) => {
    if (request) {
      if (character.toLowerCase() === "y") approvalResolver.resolve("approved");
      if (character.toLowerCase() === "n" || key.escape)
        approvalResolver.resolve("denied");
      return;
    }
    if (key.ctrl && character === "c") exit();
    if (key.return && input.trim()) {
      onSubmit(input.trim());
      setInput("");
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && character)
      setInput((value) => value + character);
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ChiselCode
      </Text>
      {transcript.map((line) => (
        <Text key={line.id}>{line.text}</Text>
      ))}
      {request ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Нужно подтверждение для {request.tool}</Text>
          <Text>{request.preview}</Text>
          <Text>Разрешить? [y/N]</Text>
        </Box>
      ) : (
        <Text color="green">› {input}</Text>
      )}
    </Box>
  );
}
