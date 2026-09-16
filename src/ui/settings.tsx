import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { defaultBaseUrlForProvider } from "../providers/agentrouter.js";
import { normalizeBaseUrlForProvider } from "../providers/base-url.js";
import type { ProviderKind } from "../types/domain.js";
import { defaultModelFor, isValidApiUrl } from "./setup.js";

export interface TuiSettingsValues {
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
}

export interface SettingsPanelProps {
  initialValues: TuiSettingsValues;
  initialScreen?: "menu" | "model";
  onSave(values: TuiSettingsValues): Promise<"saved" | "setup_required">;
  onClose(): void;
  onSetupRequested(): void;
  onSaved(values: TuiSettingsValues): void;
  /**
   * Проверка подключения к отредактированным значениям (сервис, модель,
   * адрес). Ключ берётся из сохранённой настройки. Возвращает человекочитаемый
   * итог: успех — показать зелёным, текст с «✗» в начале — красным как ошибку.
   */
  onCheckConnection(values: TuiSettingsValues): Promise<string>;
}

type Screen =
  | "menu"
  | "provider"
  | "model"
  | "base-url"
  | "saving"
  | "checking";
const PROVIDERS: { value: ProviderKind; label: string }[] = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "anthropic-compatible", label: "Anthropic-совместимый API" },
  { value: "openai", label: "OpenAI" },
  { value: "openai-compatible", label: "OpenAI-совместимый API" },
  { value: "agentrouter", label: "AgentRouter" },
];

export function SettingsPanel({
  initialValues,
  initialScreen = "menu",
  onSave,
  onClose,
  onSetupRequested,
  onSaved,
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
          baseUrl: isCompatibleProvider(provider)
            ? current.baseUrl || defaultBaseUrlForProvider(provider)
            : undefined,
        }));
        setScreen("menu");
      }
      return;
    }
    const update = screen === "model" ? "model" : "baseUrl";
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
        <Menu items={items} selected={safeSelected} values={values} />
      ) : null}
      {screen === "provider" ? <ProviderMenu selected={providerIndex} /> : null}
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
}: {
  items: string[];
  selected: number;
  values: TuiSettingsValues;
}): React.JSX.Element {
  const labels: Record<string, string> = {
    provider: `◈ Сервис: ${providerLabel(values.provider)}`,
    model: `✎ Модель: ${values.model || "не выбрана"}`,
    "base-url": `⌁ Адрес API: ${values.baseUrl || "не настроен"}`,
    save: "✓ Сохранить изменения",
    check: "⇄ Проверить подключение",
    setup: "↺ Пройти настройку заново",
    close: "Закрыть настройки",
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
          <Text key={provider.value} dimColor>
            {" "}
            {provider.label}
          </Text>
        ),
      )}
    </Box>
  );
}

function providerLabel(provider: ProviderKind): string {
  return PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;
}
