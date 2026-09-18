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
  /**
   * Список моделей провайдера для интерактивного выбора на экране «Модель».
   * Необязателен: без него экран модели — просто ручной ввод, как раньше.
   */
  onListModels?(values: TuiSettingsValues): Promise<ModelListResult>;
}

/** Вариант модели в списке выбора: id + необязательная подсказка. */
export interface ModelOption {
  id: string;
  hint?: string;
}

export type ModelListResult =
  | { ok: true; models: ModelOption[] }
  | { ok: false; error: string };

/** Сколько строк списка моделей видно разом: остальное — счётчиком. */
export const MAX_VISIBLE_MODELS = 8;
/** Страховка от гигантских каталогов (сотни моделей у шлюзов). */
const MAX_LISTED_MODELS = 200;

/**
 * Текущая модель — первой и помечается ✓, остальные по алфавиту.
 * Чистая функция для тестов и стабильного порядка при каждом открытии.
 */
export function sortModelOptions(
  models: ModelOption[],
  current?: string,
): ModelOption[] {
  const normalized = (current ?? "").trim();
  return [...models].sort((a, b) => {
    const aCurrent = a.id === normalized ? 0 : 1;
    const bCurrent = b.id === normalized ? 0 : 1;
    if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    return a.id.localeCompare(b.id);
  });
}

/** Поиск по списку: подстрока без учёта регистра по id и подсказке. */
export function filterModelOptions(
  models: ModelOption[],
  query: string,
): ModelOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(needle) ||
      (model.hint ?? "").toLowerCase().includes(needle),
  );
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
  onListModels,
}: SettingsPanelProps): React.JSX.Element {
  const [values, setValues] = useState(initialValues);
  const [screen, setScreen] = useState<Screen>(initialScreen);
  // Состояние выбора модели из API: фильтр, подсветка, ручной режим.
  const [modelFilter, setModelFilter] = useState("");
  const [modelIndex, setModelIndex] = useState(0);
  const [modelManual, setModelManual] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[] | undefined>(
    undefined,
  );
  const [modelLoading, setModelLoading] = useState(false);
  // Ключ данных, для которых список уже загружен: защищает от повторных
  // запросов при ре-рендерах внутри визита. При каждом входе сбрасывается.
  const modelFetchKeyRef = useRef("");
  const onListModelsRef = useRef(onListModels);
  onListModelsRef.current = onListModels;
  const valuesRef = useRef(values);
  valuesRef.current = values;
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
  /**
   * Загрузка списка моделей при входе на экран «Модель» — под текущий сервис,
   * адрес и введённый ключ. Ключ визита отсекает повторы при ре-рендерах;
   * ручные правки модели ключ не меняют и сеть не дёргают. Опоздавший ответ
   * отменяется флагом, чтобы не затереть свежий список.
   */
  useEffect(() => {
    if (screen !== "model") return;
    const fetchModels = onListModelsRef.current;
    if (!fetchModels) return;
    const visitKey = `${values.provider}|${values.baseUrl ?? ""}|${values.apiKey ?? ""}`;
    if (modelFetchKeyRef.current === visitKey) return;
    modelFetchKeyRef.current = visitKey;
    let cancelled = false;
    const snapshot = valuesRef.current;
    const currentModel = snapshot.model;
    setModelLoading(true);
    setError("");
    void fetchModels({
      provider: snapshot.provider,
      model: currentModel.trim(),
      apiKey: snapshot.apiKey?.trim() || undefined,
      baseUrl: snapshot.baseUrl?.trim() || undefined,
    })
      .then((result) => {
        if (cancelled) return;
        setModelLoading(false);
        if (result.ok) {
          setModelOptions(
            sortModelOptions(
              result.models.slice(0, MAX_LISTED_MODELS),
              currentModel,
            ),
          );
          setModelManual(false);
          setModelFilter("");
          setModelIndex(0);
        } else {
          // Умный фолбэк: список недоступен — сразу ручной ввод с причиной.
          setModelOptions(undefined);
          setModelManual(true);
          setError(result.error);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setModelLoading(false);
        setModelOptions(undefined);
        setModelManual(true);
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить список моделей.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [screen, values.provider, values.baseUrl, values.apiKey]);
  const items = menuItems(values.provider);
  // Пункты зависят от провайдера (base-url только для совместимых):
  // после смены сервиса прежний индекс может оказаться за границей,
  // поэтому для подсветки и Enter всегда используем зажатое значение,
  // а движение считаем от него же — иначе стрелки прыгают не туда.
  const safeSelected = Math.min(selected, items.length - 1);
  const move = (direction: -1 | 1) =>
    setSelected(() => (safeSelected + direction + items.length) % items.length);
  /** Переход между экранами всегда гасит старую ошибку, иначе она висит поверх нового экрана. */
  const goScreen = (next: Screen): void => {
    setScreen(next);
    setError("");
  };

  // Есть ли живой список моделей (а не ручной ввод): нужен и проп,
  // и загруженные варианты, и не ручной режим.
  const hasModelOptions =
    typeof onListModels === "function" &&
    !modelManual &&
    modelOptions !== undefined;
  const filteredModels = hasModelOptions
    ? filterModelOptions(modelOptions, modelFilter)
    : [];
  // Строки выбора: модели + закреплённая «ввести вручную» в конце.
  const modelRowCount = filteredModels.length + 1;
  const safeModelIndex = modelRowCount > 0 ? modelIndex % modelRowCount : 0;
  // Окно списка как в подсказках команд: максимум MAX_VISIBLE_MODELS строк,
  // остаток — счётчиком. Ручная строка закреплена снизу и видна всегда.
  const modelWindowStart =
    Math.floor(safeModelIndex / MAX_VISIBLE_MODELS) * MAX_VISIBLE_MODELS;
  const visibleModels = filteredModels.slice(
    modelWindowStart,
    modelWindowStart + MAX_VISIBLE_MODELS,
  );
  const hiddenModelsCount =
    filteredModels.length - (modelWindowStart + visibleModels.length);
  const currentModelId = values.model.trim();

  useInput((character, key) => {
    if (screen === "saving" || screen === "checking") return;
    // Из ручного ввода — назад к списку, а не сразу в меню.
    if (key.escape && screen === "model" && modelManual && modelOptions) {
      setModelManual(false);
      setError("");
      return;
    }
    if (key.escape) {
      if (screen === "menu") onClose();
      else goScreen("menu");
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
      if (item === "provider") goScreen("provider");
      else if (item === "key") goScreen("key");
      else if (item === "model") {
        // Чистый вход в выбор: фильтр и подсветка сбрасываются,
        // ключ визита — тоже, чтобы список подтянулся заново.
        setModelFilter("");
        setModelIndex(0);
        modelFetchKeyRef.current = "";
        goScreen("model");
      } else if (item === "base-url") goScreen("base-url");
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
        // Новый список пунктов короче/длиннее — зажимаем подсветку сразу,
        // иначе следующий ↑/↓ прыгнет со stale-индекса.
        setSelected((previous) =>
          Math.min(previous, menuItems(provider).length - 1),
        );
        setNotice("");
        goScreen("menu");
      }
      return;
    }
    if (screen === "model" && !modelManual && onListModels) {
      // Режим списка: стрелки — навигация, печать — поиск по списку.
      if (modelLoading || !modelOptions) return;
      if (key.upArrow || key.downArrow) {
        setModelIndex(
          (previous) =>
            (previous + (key.upArrow ? -1 : 1) + modelRowCount) % modelRowCount,
        );
        return;
      }
      if (key.backspace || key.delete) {
        setModelFilter((filter) => filter.slice(0, -1));
        setModelIndex(0);
        setError("");
        setNotice("");
        return;
      }
      if (key.return) {
        // Поиск ничего не дал — набранное сразу становится своей моделью.
        if (filteredModels.length === 0 && modelFilter.trim()) {
          const custom = modelFilter.trim();
          setValues((current) => ({ ...current, model: custom }));
          setNotice("");
          goScreen("menu");
          return;
        }
        // Последняя строка — переход к ручному вводу, иначе выбор модели.
        if (safeModelIndex >= filteredModels.length) {
          setModelManual(true);
          setError("");
          return;
        }
        const picked = filteredModels[safeModelIndex];
        if (!picked) return;
        setValues((current) => ({ ...current, model: picked.id }));
        setNotice("");
        goScreen("menu");
        return;
      }
      if (!key.ctrl && !key.meta && character) {
        setModelFilter((filter) => `${filter}${character}`);
        setModelIndex(0);
        setError("");
        setNotice("");
      }
      return;
    }
    if (screen === "model") {
      // Ручной ввод модели: фолбэк без списка или строка «Ввести вручную».
      // Возврат к списку по Esc обрабатывается выше.
      if (key.backspace || key.delete) {
        setValues((current) => ({
          ...current,
          model: current.model.slice(0, -1),
        }));
        setError("");
        setNotice("");
        return;
      }
      if (key.return) {
        goScreen("menu");
        return;
      }
      if (!key.ctrl && !key.meta && character) {
        setValues((current) => ({
          ...current,
          model: `${current.model}${character}`,
        }));
        setError("");
        setNotice("");
      }
      return;
    }
    if (screen !== "key" && screen !== "base-url") return;
    const update = screen === "key" ? "apiKey" : "baseUrl";
    if (key.backspace || key.delete) {
      setValues((current) => ({
        ...current,
        [update]: (current[update] ?? "").slice(0, -1),
      }));
      // Проверка и старая ошибка относятся к прошлым значениям.
      setError("");
      setNotice("");
      return;
    }
    if (key.return) {
      goScreen("menu");
      return;
    }
    if (!key.ctrl && !key.meta && character)
      setValues((current) => ({
        ...current,
        [update]: `${current[update] ?? ""}${character}`,
      }));
    if (character) {
      setError("");
      setNotice("");
    }
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
            <Text color="green">█</Text>
          </Text>
        </Box>
      ) : null}
      {screen === "model" && (modelManual || !onListModels) ? (
        <Box flexDirection="column">
          <Text bold>Модель для {providerLabel(values.provider)}:</Text>
          {modelOptions ? (
            <Text dimColor>Своя модель — введите вручную.</Text>
          ) : (
            <Text dimColor>
              {onListModels
                ? "Список недоступен — введите вручную."
                : "Можно оставить предложенную модель или отредактировать её."}
            </Text>
          )}
          <Text color="green">
            ❯ {values.model || "…"}
            <Text color="green">█</Text>
          </Text>
        </Box>
      ) : null}
      {screen === "model" && !modelManual && onListModels && modelLoading ? (
        <Box flexDirection="column">
          <Text bold>Модель для {providerLabel(values.provider)}:</Text>
          <Text color="yellow">Загружаю список моделей из API…</Text>
        </Box>
      ) : null}
      {screen === "model" && hasModelOptions ? (
        <Box flexDirection="column">
          <Text bold>Модель для {providerLabel(values.provider)}:</Text>
          {modelFilter ? (
            <Text>
              Поиск ❯ <Text color="green">{modelFilter}</Text>
              <Text color="green">█</Text>
            </Text>
          ) : (
            <Text dimColor>Поиск ❯ … (печатайте, чтобы отфильтровать)</Text>
          )}
          {filteredModels.length === 0 ? (
            <Text dimColor>
              Совпадений нет — Enter введёт «{modelFilter.trim()}» как свою
              модель.
            </Text>
          ) : null}
          {visibleModels.map((model, index) => {
            const absolute = modelWindowStart + index;
            const isCurrent = model.id === currentModelId;
            const label = isCurrent ? `${model.id} ✓` : model.id;
            return absolute === safeModelIndex ? (
              <Text key={model.id} bold inverse color="green">
                ❯ {label}
              </Text>
            ) : (
              <Text key={model.id} dimColor>
                {"  "}
                {label}
              </Text>
            );
          })}
          {hiddenModelsCount > 0 ? (
            <Text dimColor>…и ещё {hiddenModelsCount}</Text>
          ) : null}
          {safeModelIndex >= filteredModels.length ? (
            <Text bold inverse color="green">
              ❯{" "}
              {filteredModels.length === 0 && modelFilter.trim()
                ? `Использовать «${modelFilter.trim()}»`
                : "✎ Ввести вручную…"}
            </Text>
          ) : (
            <Text dimColor>
              {"  "}
              {filteredModels.length === 0 && modelFilter.trim()
                ? `✎ Использовать «${modelFilter.trim()}»`
                : "✎ Ввести вручную…"}
            </Text>
          )}
        </Box>
      ) : null}
      {screen === "base-url" ? (
        <Text color="green">
          Адрес API ❯ {values.baseUrl ?? "…"}
          <Text color="green">█</Text>
        </Text>
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
          : screen === "provider"
            ? "↑/↓ — выбор · Enter — выбрать · Esc — назад"
            : screen === "key"
              ? "Печать · Enter — готово · Esc — назад · пусто — оставить"
              : screen === "model" && !modelManual && onListModels
                ? modelOptions
                  ? "↑/↓ — выбор · Enter — выбрать · Esc — назад · печать — поиск"
                  : "Подождите…"
                : screen === "model" && modelManual && modelOptions
                  ? "Печать · Enter — готово · Esc — к списку"
                  : screen === "model" || screen === "base-url"
                    ? "Печать · Enter — готово · Esc — назад"
                    : "Подождите…"}
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
  // Подсказка — только у подсвеченного сервиса (как описания у подсказок
  // команд): иначе имена и подсказки сливаются в кашу. Высота при этом
  // стабильна — двустрочной всегда ровно одна строка, прыгать нечему.
  // У подсказки свой цвет и маркер └─, чтобы не терялась на фоне текста.
  return (
    <Box flexDirection="column">
      <Text>Выберите сервис:</Text>
      {PROVIDERS.map((provider, index) =>
        index === selected ? (
          <Box key={provider.value} flexDirection="column">
            <Text bold inverse color="green">
              ❯ {provider.label}
            </Text>
            <Text color="cyan"> └─ {provider.hint}</Text>
          </Box>
        ) : (
          <Box key={provider.value} flexDirection="column">
            <Text dimColor> {provider.label}</Text>
          </Box>
        ),
      )}
    </Box>
  );
}

function providerLabel(provider: ProviderKind): string {
  return PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;
}
