import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
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
}

type Screen = "menu" | "provider" | "model" | "base-url" | "saving";
const PROVIDERS: { value: ProviderKind; label: string }[] = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "anthropic-compatible", label: "Anthropic-совместимый API" },
  { value: "openai", label: "OpenAI" },
  { value: "openai-compatible", label: "OpenAI-совместимый API" },
];

export function SettingsPanel({
  initialValues,
  initialScreen = "menu",
  onSave,
  onClose,
  onSetupRequested,
  onSaved,
}: SettingsPanelProps): React.JSX.Element {
  const [values, setValues] = useState(initialValues);
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [selected, setSelected] = useState(0);
  const [providerIndex, setProviderIndex] = useState(() =>
    PROVIDERS.findIndex(({ value }) => value === initialValues.provider),
  );
  const [error, setError] = useState("");
  const items = menuItems(values.provider);
  const move = (direction: -1 | 1) =>
    setSelected((value) => (value + direction + items.length) % items.length);

  useInput((character, key) => {
    if (screen === "saving") return;
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
      const item = items[selected];
      if (item === "provider") setScreen("provider");
      else if (item === "model") setScreen("model");
      else if (item === "base-url") setScreen("base-url");
      else if (item === "setup") onSetupRequested();
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
          baseUrl: isCompatibleProvider(provider) ? current.baseUrl : undefined,
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
    setScreen("saving");
    try {
      if (
        (await onSave({
          ...values,
          model: values.model.trim(),
          baseUrl: values.baseUrl?.trim() || undefined,
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

  return (
    <Box flexDirection="column" marginTop={1} alignItems="stretch">
      <Text bold color="cyan">
        Настройки
      </Text>
      {screen === "menu" ? (
        <Menu items={items} selected={selected} values={values} />
      ) : null}
      {screen === "provider" ? <ProviderMenu selected={providerIndex} /> : null}
      {screen === "model" ? (
        <Text color="green">Модель › {values.model}</Text>
      ) : null}
      {screen === "base-url" ? (
        <Text color="green">Адрес API › {values.baseUrl ?? ""}</Text>
      ) : null}
      {screen === "saving" ? (
        <Text color="yellow">Сохраняю настройки…</Text>
      ) : null}
      <Text dimColor>
        {screen === "menu"
          ? "↑/↓ — выбор, Enter — открыть, Esc — назад"
          : "Enter — готово, Esc — назад"}
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

function menuItems(provider: ProviderKind): string[] {
  return [
    "provider",
    "model",
    ...(isCompatibleProvider(provider) ? ["base-url"] : []),
    "save",
    "setup",
    "close",
  ];
}

function isCompatibleProvider(provider: ProviderKind): boolean {
  return (
    provider === "anthropic-compatible" || provider === "openai-compatible"
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
    provider: `Сервис: ${providerLabel(values.provider)}`,
    model: `Модель: ${values.model || "не выбрана"}`,
    "base-url": `Адрес API: ${values.baseUrl || "не настроен"}`,
    save: "Сохранить изменения",
    setup: "Пройти настройку заново",
    close: "Закрыть настройки",
  };
  return (
    <Box flexDirection="column">
      {items.map((item, index) => (
        <Text key={item} color={index === selected ? "green" : undefined}>
          {index === selected ? "› " : "  "}
          {labels[item]}
        </Text>
      ))}
    </Box>
  );
}

function ProviderMenu({ selected }: { selected: number }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text>Выберите сервис:</Text>
      {PROVIDERS.map((provider, index) => (
        <Text
          key={provider.value}
          color={index === selected ? "green" : undefined}
        >
          {index === selected ? "› " : "  "}
          {provider.label}
        </Text>
      ))}
    </Box>
  );
}

function providerLabel(provider: ProviderKind): string {
  return PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;
}
