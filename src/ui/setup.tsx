import { Box, Text, useApp, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type { ProviderKind } from "../types/domain.js";

export interface SetupValues {
  provider: ProviderKind;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export interface SetupAppProps {
  initialProvider?: ProviderKind;
  onComplete(values: SetupValues): Promise<void>;
}

type Step = "provider" | "key" | "base-url" | "model" | "saving";

export function defaultModelFor(provider: ProviderKind): string {
  if (provider === "anthropic") return "claude-opus-5";
  if (provider === "openai") return "gpt-5";
  return "";
}

export function SetupApp({
  initialProvider,
  onComplete,
}: SetupAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(initialProvider ? "key" : "provider");
  const [provider, setProvider] = useState<ProviderKind>(
    initialProvider ?? "anthropic",
  );
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState(
    defaultModelFor(initialProvider ?? "anthropic"),
  );
  const [error, setError] = useState("");

  useInput((character, key) => {
    if (key.ctrl && character === "c") {
      exit();
      return;
    }
    if (step === "saving") return;
    if (step === "provider") {
      const selected = providerForKey(character);
      if (selected) {
        setProvider(selected);
        setModel(defaultModelFor(selected));
        setError("");
        setStep("key");
      }
      return;
    }

    const updateValue = valueSetterFor(step, setApiKey, setBaseUrl, setModel);
    if (!updateValue) return;
    if (key.backspace || key.delete) {
      updateValue((value) => value.slice(0, -1));
      return;
    }
    if (!key.return) {
      if (!key.ctrl && !key.meta && character)
        updateValue((value) => value + character);
      return;
    }

    if (step === "key") {
      if (!apiKey.trim()) {
        setError(
          "Введите API-ключ. Он будет сохранён зашифрованно и не появится на экране.",
        );
        return;
      }
      setError("");
      setStep(isCompatibleProvider(provider) ? "base-url" : "model");
      return;
    }
    if (step === "base-url") {
      if (!isValidApiUrl(baseUrl)) {
        setError(
          "Введите полный адрес сервера, например http://localhost:11434/v1.",
        );
        return;
      }
      setError("");
      setStep("model");
      return;
    }
    if (!model.trim()) {
      setError("Введите название модели.");
      return;
    }
    setStep("saving");
    void onComplete({
      provider,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim() || undefined,
      model: model.trim(),
    })
      .then(() => exit())
      .catch((cause: unknown) => {
        setStep("model");
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось сохранить настройки.",
        );
      });
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text bold color="cyan">
          ✦ ChiselCode — быстрая настройка
        </Text>
        <Text dimColor> · {stepLabel(step, provider)}</Text>
      </Box>
      <Text dimColor>Настройка займёт меньше минуты. Ctrl+C — отмена.</Text>
      {step === "provider" ? <ProviderSelection /> : null}
      {step === "key" ? <ApiKeyInput value={apiKey} /> : null}
      {step === "base-url" ? <BaseUrlInput value={baseUrl} /> : null}
      {step === "model" ? (
        <ModelInput provider={provider} value={model} />
      ) : null}
      {step === "saving" ? (
        <Text color="yellow">Сохраняю настройки…</Text>
      ) : null}
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

function stepLabel(step: Step, provider: ProviderKind): string {
  if (step === "provider") return "шаг 1/3";
  if (step === "key") return "шаг 2/4";
  if (step === "base-url") return "шаг 3/4";
  if (step === "model")
    return provider === "anthropic" || provider === "openai"
      ? "шаг 3/3"
      : "шаг 4/4";
  return "сохранение…";
}

function ProviderSelection(): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>1. Выберите сервис:</Text>
      <Text>
        {" "}
        [
        <Text bold color="green">
          1
        </Text>
        ] Anthropic (Claude) — рекомендуемый вариант
      </Text>
      <Text>
        {" "}
        [
        <Text bold color="green">
          2
        </Text>
        ] OpenAI (ChatGPT API)
      </Text>
      <Text>
        {" "}
        [
        <Text bold color="green">
          3
        </Text>
        ] Другой OpenAI-совместимый сервис / локальная модель
      </Text>
      <Text>
        {" "}
        [
        <Text bold color="green">
          4
        </Text>
        ] Anthropic-совместимый API proxy
      </Text>
      <Text color="green">Нажмите 1, 2, 3 или 4.</Text>
    </Box>
  );
}

function ApiKeyInput({ value }: { value: string }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>2. Вставьте API-ключ и нажмите Enter:</Text>
      <Text color="yellow">
        Ключ скрыт и сохраняется только в зашифрованном локальном хранилище.
      </Text>
      <Text color="green">› {"•".repeat(value.length)}</Text>
    </Box>
  );
}

function BaseUrlInput({ value }: { value: string }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>3. Введите адрес API и нажмите Enter:</Text>
      <Text>
        Для OpenAI API добавьте /v1; для Anthropic proxy укажите корень.
      </Text>
      <Text color="green">› {value}</Text>
    </Box>
  );
}

function ModelInput({
  provider,
  value,
}: {
  provider: ProviderKind;
  value: string;
}): React.JSX.Element {
  const step = isCompatibleProvider(provider) ? "4" : "3";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{step}. Выберите модель и нажмите Enter:</Text>
      <Text>
        {isCompatibleProvider(provider)
          ? "Укажите модель, доступную на выбранном сервере."
          : "Можно оставить предложенную модель или отредактировать её."}
      </Text>
      <Text color="green">› {value}</Text>
    </Box>
  );
}

function providerForKey(value: string): ProviderKind | undefined {
  if (value === "1") return "anthropic";
  if (value === "2") return "openai";
  if (value === "3") return "openai-compatible";
  if (value === "4") return "anthropic-compatible";
  return undefined;
}

function isCompatibleProvider(provider: ProviderKind): boolean {
  return (
    provider === "anthropic-compatible" || provider === "openai-compatible"
  );
}

function valueSetterFor(
  step: Step,
  setApiKey: React.Dispatch<React.SetStateAction<string>>,
  setBaseUrl: React.Dispatch<React.SetStateAction<string>>,
  setModel: React.Dispatch<React.SetStateAction<string>>,
): React.Dispatch<React.SetStateAction<string>> | undefined {
  if (step === "key") return setApiKey;
  if (step === "base-url") return setBaseUrl;
  if (step === "model") return setModel;
  return undefined;
}

export function isValidApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
