import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { defaultBaseUrlForProvider } from "../providers/agentrouter.js";
import { normalizeBaseUrlForProvider } from "../providers/base-url.js";
import type { ProviderKind } from "../types/domain.js";
import { defaultModelFor, isValidApiUrl, PROVIDER_HINT } from "./setup.js";

export interface TuiSettingsValues {
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  /**
   * Новый ключ, введённый прямо здесь (на экране виден только маской).
   * Пусто — оставить сохранённый. В конфиг никогда не пишется открытым
   * текстом: cli сохраняет его в зашифрованное хранилище под apiKeyRef.
   */
  apiKey?: string;
}

export interface SettingsPanelProps {
  initialValues: TuiSettingsValues;
  initialScreen?: "menu" | "model";
  onSave(values: TuiSettingsValues): Promise<"saved" | "setup_required">;
  onClose(): void;
  onSetupRequested(): void;
  onSaved(values: TuiSettingsValues): void;
  /**
   * Есть ли сохранённый ключ для сервиса (для строки статуса).
   * Необязателен: без него строка ключа показывает только ввод.
   */
  onKeyStatus?(provider: ProviderKind): Promise<boolean>;
  /**
   * Проверка подключения к значениям С ЭКРАНА (включая ещё не сохранённый
   * ключ). Ключ берётся из сохранённой настройки. Возвращает человекочитаемый
   * итог: успех — показать зелёным, текст с «✗» в начале — красным как ошибку.
   */
  onCheckConnection(values: TuiSettingsValues): Promise<string>;
}

type Screen =
  | "menu"
  | "provider"
  | "key"
  | "model"
  | "base-url"
  | "saving"
  | "checking";
const PROVIDERS: { value: ProviderKind; label: string; hint: string }[] = [
  {
    value: "anthropic",
    label: "Anthropic (Claude)",
    hint: "Официальный API · нужен ключ console.anthropic.com",
  },
  {
    value: "anthropic-compatible",
    label: "Anthropic-совместимый API",
    hint: "Прокси с протоколом Anthropic, как для Claude Code · нужен адрес",
  },
  {
    value: "openai",
    label: "OpenAI",
    hint: "Официальный API · нужен ключ platform.openai.com",
  },
  {
    value: "openai-compatible",
    label: "OpenAI-совместимый API",
    hint: "Ollama, LM Studio, свой сервер · нужен адрес с /v1",
  },
  {
    value: "agentrouter",
    label: "AgentRouter",
    hint: "Один ключ к Claude, GPT, DeepSeek · адрес подставится сам",
  },
];

export function SettingsPanel({
  initialValues,
  initialScreen = "menu",
  onSave,
  onClose,
  onSetupRequested,
  onSaved,
  onKeyStatus,
  onCheckConnection,
}: SettingsPanelProps): React.JSX.Element {
  const [values, setValues] = useState(initialValues);
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [selected, setSelected] = useState(0);
  const [providerIndex, setProviderIndex] = useState(() =>
    Math.max(
      0,
      PROVIDERS.findIndex(({ value }) => value === initialValues.provider),
    ),
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Есть ли сохранённый ключ для выбранного сервиса. undefined — ещё
  // проверяем (или проверять нечем — тогда строка ключа нейтральна).
  const [savedKey, setSavedKey] = useState<boolean | undefined>(undefined);
  const onKeyStatusRef = useRef(onKeyStatus);
  onKeyStatusRef.current = onKeyStatus;
  useEffect(() => {
    let cancelled = false;
    setSavedKey(undefined);
    const check = onKeyStatusRef.current;
    if (!check) return;
    void check(values.provider)
      .then((has) => {
        if (!cancelled) setSavedKey(has);
      })
      .catch(() => {
        if (!cancelled) setSavedKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, [values.provider]);
  const items = menuItems(values.provider);
  // Пункты зависят от провайдера (base-url только для совместимых):
  // после смены сервиса прежний индекс может оказаться за границей,
  // поэтому для подсветки и Enter всегда используем зажатое значение.
  const safeSelected = Math.min(selected, items.length - 1);
  const move = (direction: -1 | 1) =>
    setSelected((value) => (value + direction + items.length) % items.length);

  useInput((character, key) => {
    if (screen === "saving" || screen === "checking") return;
    if (key.escape) {
      if (screen === "menu") onClose();
      else {
        setScreen("menu");
        setError("");
      }
      return;
    }
    if (screen === "menu") {
      if (key.upArrow) {
        move(-1);
        return;
      }
      if (key.downArrow) {
        move(1);
        return;
      }
      if (!key.return) return;
      const item = items[safeSelected];
      if (item === "provider") setScreen("provider");
      else if (item === "key") setScreen("key");
      else if (item === "model") setScreen("model");
      else if (item === "base-url") setScreen("base-url");
      else if (item === "setup") onSetupRequested();
      else if (item === "check") void checkConnection();
      else if (item === "close") onClose();
      else void save();
      return;
    }
    if (screen === "provider") {
      if (key.upArrow || key.downArrow) {
        setProviderIndex(
          (value) =>
            (value + (key.upArrow ? -1 : 1) + PROVIDERS.length) %
            PROVIDERS.length,
        );
        return;
      }
      if (key.return) {
        const provider = PROVIDERS[providerIndex]?.value ?? "anthropic";
        setValues((current) => ({
          provider,
          model: defaultModelFor(provider) || current.model,
          // Введённый, но не сохранённый ключ принадлежит другому сервису —
          // при смене сервиса сбрасываем, иначе чужой ключ уйдёт не туда.
          apiKey: undefined,
          baseUrl: isCompatibleProvider(provider)
            ? current.baseUrl || defaultBaseUrlForProvider(provider)
            : undefined,
        }));
        setScreen("menu");
      }
      return;
    }
    const update =
      screen === "model" ? "model" : screen === "key" ? "apiKey" : "baseUrl";
    if (key.backspace || key.delete) {
      setValues((current) => ({
        ...current,
        [update]: (current[update] ?? "").slice(0, -1),
      }));
      return;
    }
    if (key.return) {
      setScreen("menu");
      return;
    }
    if (!key.ctrl && !key.meta && character)
      setValues((current) => ({
        ...current,
        [update]: `${current[update] ?? ""}${character}`,
      }));
  });

  async function save(): Promise<void> {
    if (!values.model.trim()) {
      setError("Введите название модели.");
      return;
    }
    if (
      isCompatibleProvider(values.provider) &&
      !isValidApiUrl(values.baseUrl ?? "")
    ) {
      setError("Введите полный адрес API, например https://api.example.com.");
      return;
    }
    setError("");
    setNotice("");
    setScreen("saving");
    try {
      if (
        (await onSave({
          ...values,
          model: values.model.trim(),
          apiKey: values.apiKey?.trim() || undefined,
          baseUrl:
            normalizeBaseUrlForProvider(
              values.provider,
              values.baseUrl?.trim(),
            ) || undefined,
        })) === "setup_required"
      )
        onSetupRequested();
      else {
        onSaved(values);
        onClose();
      }
    } catch (cause) {
      setScreen("menu");
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить настройки.",
      );
    }
  }

  async function checkConnection(): Promise<void> {
    setError("");
    setNotice("");
    setScreen("checking");
    try {
      const verdict = await onCheckConnection({
        ...values,
        model: values.model.trim(),
        apiKey: values.apiKey?.trim() || undefined,
        baseUrl: values.baseUrl?.trim() || undefined,
      });
      setScreen("menu");
      if (verdict.startsWith("✗")) setError(verdict.slice(1).trim());
      else setNotice(verdict.replace(/^✓\s*/, ""));
    } catch (cause) {
      setScreen("menu");
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить подключение.",
      );
    }
  }

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      alignItems="stretch"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box>
        <Text bold color="cyan">
          ◈ Настройки
        </Text>
        <Text dimColor> · Enter — открыть · Esc — назад</Text>
      </Box>
      {screen === "menu" ? (
        <Menu
          items={items}
          selected={safeSelected}
          values={values}
          savedKey={savedKey}
        />
      ) : null}
      {screen === "provider" ? <ProviderMenu selected={providerIndex} /> : null}
      {screen === "key" ? (
        <Box flexDirection="column">
          <Text bold>API-ключ для {providerLabel(values.provider)}:</Text>
          <Text dimColor>{PROVIDER_HINT[values.provider]}</Text>
          <Text dimColor>
            Ключ скрыт и сохраняется только в зашифрованном локальном хранилище.
            Пусто + Enter — оставить как было.
          </Text>
          <Text color="green">
            ❯{" "}
            {values.apiKey
              ? "•".repeat(Math.min(values.apiKey.length, 24))
              : savedKey
                ? "(сохранён, введите новый для замены)"
                : "…"}
          </Text>
        </Box>
      ) : null}
      {screen === "model" ? (
        <Text color="green">Модель ❯ {values.model}</Text>
      ) : null}
      {screen === "base-url" ? (
        <Text color="green">Адрес API ❯ {values.baseUrl ?? ""}</Text>
      ) : null}
      {screen === "saving" ? (
        <Text color="yellow">Сохраняю настройки…</Text>
      ) : null}
      {screen === "checking" ? (
        <Text color="yellow">Проверяю подключение…</Text>
      ) : null}
      <Text dimColor>
        {screen === "menu"
          ? "↑/↓ — выбор · Enter — открыть · Esc — закрыть"
          : screen === "saving"
            ? "Сохраняю…"
            : screen === "checking"
              ? "Проверяю…"
              : "↑/↓ — выбор · Enter — готово · Esc — назад"}
      </Text>
      {error ? <Text color="red">✗ {error}</Text> : null}
      {notice ? <Text color="green">✓ {notice}</Text> : null}
    </Box>
  );
}

function menuItems(provider: ProviderKind): string[] {
  return [
    "provider",
    "key",
    "model",
    ...(isCompatibleProvider(provider) ? ["base-url"] : []),
    "save",
    "check",
    "setup",
    "close",
  ];
}

function isCompatibleProvider(provider: ProviderKind): boolean {
  return (
    provider === "anthropic-compatible" ||
    provider === "openai-compatible" ||
    provider === "agentrouter"
  );
}

function Menu({
  items,
  selected,
  values,
  savedKey,
}: {
  items: string[];
  selected: number;
  values: TuiSettingsValues;
  savedKey: boolean | undefined;
}): React.JSX.Element {
  const keyLabel = values.apiKey
    ? `🔑 API-ключ: введён новый ${"•".repeat(Math.min(values.apiKey.length, 8))}`
    : savedKey === undefined
      ? "🔑 API-ключ: …"
      : savedKey
        ? "🔑 API-ключ: сохранён ✓"
        : "🔑 API-ключ: не введён — открыть, чтобы вставить";
  const labels: Record<string, string> = {
    provider: `◈ Сервис: ${providerLabel(values.provider)}`,
    key: keyLabel,
    model: `✎ Модель: ${values.model || "не выбрана"}`,
    "base-url": `⌁ Адрес API: ${values.baseUrl || "не настроен"}`,
    save: "✓ Сохранить и применить",
    check: "⇄ Проверить подключение (то, что на экране)",
    setup: "↺ Мастер настройки (все шаги заново)",
    close: "✕ Закрыть без сохранения",
  };
  return (
    <Box flexDirection="column">
      {items.map((item, index) =>
        index === selected ? (
          <Text key={item} bold inverse color="green">
            ❯ {labels[item]}
          </Text>
        ) : (
          <Text key={item} dimColor>
            {" "}
            {labels[item]}
          </Text>
        ),
      )}
    </Box>
  );
}

function ProviderMenu({ selected }: { selected: number }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text>Выберите сервис:</Text>
      {PROVIDERS.map((provider, index) =>
        index === selected ? (
          <Text key={provider.value} bold inverse color="green">
            ❯ {provider.label}
          </Text>
        ) : (
          <Box key={provider.value} flexDirection="column">
            <Text dimColor> {provider.label}</Text>
            <Text dimColor> {provider.hint}</Text>
          </Box>
        ),
      )}
    </Box>
  );
}

function providerLabel(provider: ProviderKind): string {
  return PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;
}
