import { Box, Text, useApp, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import {
  AGENTROUTER_BASE_URL,
  AGENTROUTER_DEFAULT_MODEL,
  defaultBaseUrlForProvider,
} from "../providers/agentrouter.js";
import { normalizeBaseUrlForProvider } from "../providers/base-url.js";
import type { ProviderKind } from "../types/domain.js";
import { VERSION } from "../version.js";

export interface SetupValues {
  provider: ProviderKind;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export interface SetupAppProps {
  initialProvider?: ProviderKind;
  onComplete(values: SetupValues): Promise<void>;
  /**
   * Вызывается по Ctrl+C вместо выхода из приложения.
   * Нужно при встраивании мастера в другой Ink-экран (например, рестарт
   * настройки из TUI): без этого `exit()` размонтировал бы весь интерфейс.
   */
  onCancel?(): void;
  /**
   * Выходить из Ink-приложения после успешного завершения.
   * Для отдельно запущенного `chisel setup` — true; при встраивании —
   * false, навигацией владеет родитель.
   */
  exitOnComplete?: boolean;
}

type Step = "provider" | "key" | "base-url" | "model" | "saving";

export function defaultModelFor(provider: ProviderKind): string {
  if (provider === "anthropic") return "claude-opus-5";
  if (provider === "openai") return "gpt-5";
  if (provider === "agentrouter") return AGENTROUTER_DEFAULT_MODEL;
  return "";
}

/** Где взять ключ для каждого сервиса. Переиспользуется экраном ключа в /settings. */
export const PROVIDER_HINT: Record<ProviderKind, string> = {
  anthropic: "Ключ создаётся в Anthropic Console → console.anthropic.com",
  openai: "Ключ создаётся на OpenAI Platform → platform.openai.com/api-keys",
  "openai-compatible":
    "Подойдёт Ollama, OpenRouter, Groq, LM Studio и любой OpenAI-совместимый сервер.",
  "anthropic-compatible":
    "Прокси с Anthropic Messages API (как для Claude Code через ANTHROPIC_BASE_URL).",
  agentrouter:
    "Ключ выдаётся в AgentRouter Console → agentrouter.org/console/token " +
    `(формат sk-…). Адрес подставится сам: ${AGENTROUTER_BASE_URL}. ` +
    "Модель — любая из вашей консоли (список со временем меняется).",
};

export function SetupApp({
  initialProvider,
  onComplete,
  onCancel,
  exitOnComplete = true,
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
      if (onCancel) {
        onCancel();
        return;
      }
      exit();
      return;
    }
    if (step === "saving") return;
    if (step === "provider") {
      const selected = providerForKey(character);
      if (selected) {
        setProvider(selected);
        setModel(defaultModelFor(selected));
        // У AgentRouter есть адрес по умолчанию: подставляем его сразу,
        // чтобы шаг адреса не требовал ручного ввода. Уже введённое
        // значение не затираем (переключение туда-обратно).
        setBaseUrl((prev) => prev || defaultBaseUrlForProvider(selected) || "");
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
          provider === "agentrouter"
            ? `Введите полный адрес сервера, обычно ${AGENTROUTER_BASE_URL}.`
            : "Введите полный адрес сервера, например http://localhost:11434/v1.",
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
      baseUrl:
        normalizeBaseUrlForProvider(provider, baseUrl.trim()) || undefined,
      model: model.trim(),
    })
      .then(() => {
        if (exitOnComplete) exit();
      })
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
          ◈ ChiselCode
        </Text>
        <Text dimColor> v{VERSION} · быстрая настройка · </Text>
        <Text color="yellow">{stepLabel(step, provider)}</Text>
        <Text dimColor> {progressDots(step)}</Text>
      </Box>
      <Text dimColor>Займёт меньше минуты. Ctrl+C — отмена.</Text>
      {step === "provider" ? <ProviderSelection /> : null}
      {step === "key" ? (
        <ApiKeyInput provider={provider} value={apiKey} />
      ) : null}
      {step === "base-url" ? (
        <BaseUrlInput provider={provider} value={baseUrl} />
      ) : null}
      {step === "model" ? (
        <ModelInput provider={provider} value={model} />
      ) : null}
      {step === "saving" ? (
        <Text color="yellow">◐ Сохраняю настройки…</Text>
      ) : null}
      {error ? <Text color="red">✗ {error}</Text> : null}
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

function progressDots(step: Step): string {
  const order: Step[] = ["provider", "key", "base-url", "model", "saving"];
  const active = order.indexOf(step);
  return order.map((_, index) => (index <= active ? "●" : "○")).join("");
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
        ] Anthropic (Claude) <Text color="cyan">★ рекомендуемый вариант</Text>
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
      <Text>
        {" "}
        [
        <Text bold color="green">
          5
        </Text>
        ] AgentRouter{" "}
        <Text dimColor>(Claude/GPT/DeepSeek за одним ключом)</Text>
      </Text>
      <Text color="green">Нажмите 1, 2, 3, 4 или 5.</Text>
    </Box>
  );
}

function ApiKeyInput({
  provider,
  value,
}: {
  provider: ProviderKind;
  value: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>2. Вставьте API-ключ и нажмите Enter:</Text>
      <Text dimColor>{PROVIDER_HINT[provider]}</Text>
      <Text dimColor>
        Ключ скрыт и сохраняется только в зашифрованном локальном хранилище.
      </Text>
      <Text color="green">❯ {"•".repeat(value.length) || "…"}</Text>
    </Box>
  );
}

function BaseUrlInput({
  provider,
  value,
}: {
  provider: ProviderKind;
  value: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>3. Введите адрес API и нажмите Enter:</Text>
      <Text dimColor>
        {provider === "agentrouter"
          ? `Оставьте подставленный адрес ${AGENTROUTER_BASE_URL} или укажите свой.`
          : "Для OpenAI API добавьте /v1 (например http://localhost:11434/v1); для Anthropic proxy укажите корень без /v1."}
      </Text>
      <Text color="green">❯ {value || "…"}</Text>
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
      <Text dimColor>
        {isCompatibleProvider(provider)
          ? "Укажите модель, доступную на выбранном сервере."
          : "Можно оставить предложенную модель или отредактировать её."}
      </Text>
      <Text color="green">❯ {value || "…"}</Text>
    </Box>
  );
}

function providerForKey(value: string): ProviderKind | undefined {
  if (value === "1") return "anthropic";
  if (value === "2") return "openai";
  if (value === "3") return "openai-compatible";
  if (value === "4") return "anthropic-compatible";
  if (value === "5") return "agentrouter";
  return undefined;
}

function isCompatibleProvider(provider: ProviderKind): boolean {
  return (
    provider === "anthropic-compatible" ||
    provider === "openai-compatible" ||
    provider === "agentrouter"
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
