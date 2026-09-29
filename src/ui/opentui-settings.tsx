/** @jsxImportSource @opentui/react */
import { useKeyboard, usePaste } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultBaseUrlForProvider } from "../providers/agentrouter.js";
import type { ProviderKind } from "../types/domain.js";
import { terminalSafeText } from "./opentui-transcript.js";
import type { ModelListResult, TuiSettingsValues } from "./settings-values.js";

export interface OpenTuiSettingsActions {
  load(): Promise<{ values: TuiSettingsValues; hasKey: boolean }>;
  hasKey(provider: ProviderKind): Promise<boolean>;
  save(values: TuiSettingsValues): Promise<"saved" | "setup_required">;
  check(values: TuiSettingsValues): Promise<string>;
  models(values: TuiSettingsValues): Promise<ModelListResult>;
}

const providers: Array<{ id: ProviderKind; name: string }> = [
  { id: "anthropic", name: "Anthropic" },
  { id: "anthropic-compatible", name: "Anthropic-совместимый" },
  { id: "openai", name: "OpenAI" },
  { id: "openai-compatible", name: "OpenAI-совместимый" },
  { id: "agentrouter", name: "AgentRouter" },
];
const menu = [
  "Провайдер",
  "Модель",
  "API-ключ",
  "Адрес API",
  "Проверить подключение",
  "Сохранить",
  "Закрыть",
];
const compatible = (provider: ProviderKind): boolean =>
  provider === "anthropic-compatible" ||
  provider === "openai-compatible" ||
  provider === "agentrouter";
type Screen =
  | "menu"
  | "providers"
  | "model-list"
  | "model-manual"
  | "key"
  | "base-url";

export function OpenTuiSettings({
  actions,
  width,
  height,
  onClose,
  initialSelection = 0,
}: {
  actions: OpenTuiSettingsActions;
  width: number;
  height: number;
  onClose: (outcome?: "saved") => void;
  initialSelection?: number;
}) {
  const [values, setValues] = useState<TuiSettingsValues>({
    provider: "anthropic",
    model: "",
  });
  const [hasKey, setHasKey] = useState(false);
  const [screen, setScreen] = useState<Screen>("menu");
  const [selected, setSelected] = useState(initialSelection);
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelFilter, setModelFilter] = useState("");
  const [models, setModels] = useState<Array<{ id: string; hint?: string }>>(
    [],
  );
  const [modelIndex, setModelIndex] = useState(0);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void actions
      .load()
      .then(({ values: loaded, hasKey: saved }) => {
        if (!mounted.current) return;
        setValues(loaded);
        setHasKey(saved);
        setProviderIndex(
          Math.max(
            0,
            providers.findIndex((item) => item.id === loaded.provider),
          ),
        );
      })
      .catch((cause) => {
        if (mounted.current) setNotice(String(cause));
      });
    return () => {
      mounted.current = false;
    };
  }, [actions]);

  const filteredModels = useMemo(
    () =>
      models.filter((item) =>
        `${item.id} ${item.hint ?? ""}`
          .toLowerCase()
          .includes(modelFilter.toLowerCase()),
      ),
    [models, modelFilter],
  );
  const menuItems = compatible(values.provider)
    ? menu
    : menu.filter((item) => item !== "Адрес API");
  const run = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    void work()
      .catch((cause) => {
        if (mounted.current) setNotice(String(cause));
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };
  const openModel = () => {
    setModelFilter("");
    setModelIndex(0);
    setScreen("model-list");
    run(async () => {
      const result = await actions.models(values);
      if (!mounted.current) return;
      if (result.ok) setModels(result.models.slice(0, 200));
      else {
        setModels([]);
        setNotice(result.error);
      }
    });
  };
  const save = () =>
    run(async () => {
      const next = {
        ...values,
        model: values.model.trim(),
        apiKey: values.apiKey?.trim() || undefined,
      };
      if (!next.model) throw new Error("Введите название модели");
      if (compatible(next.provider)) {
        try {
          const url = new URL(next.baseUrl ?? "");
          if (url.protocol !== "https:" && url.protocol !== "http:")
            throw new Error();
        } catch {
          throw new Error(
            "Введите полный адрес API, например https://api.example.com",
          );
        }
      }
      const result = await actions.save(next);
      if (!mounted.current) return;
      if (result === "saved") onClose("saved");
      else setNotice("Добавьте API-ключ для выбранного провайдера");
    });

  usePaste((event) => {
    if (screen !== "key" && screen !== "model-manual" && screen !== "base-url")
      return;
    const pasted = Array.from(
      new TextDecoder().decode(event.bytes).slice(0, 4096),
    )
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
      })
      .join("");
    if (!pasted) return;
    const field =
      screen === "key" ? "apiKey" : screen === "base-url" ? "baseUrl" : "model";
    setValues((current) => ({
      ...current,
      [field]: `${current[field] ?? ""}${pasted}`,
    }));
    setNotice("");
  });
  useKeyboard((key) => {
    if (busy) return;
    const name = key.name.toLowerCase();
    if (name === "escape") {
      if (screen === "menu") onClose();
      else setScreen("menu");
      return;
    }
    if (screen === "menu") {
      if (name === "up") setSelected((index) => Math.max(0, index - 1));
      else if (name === "down")
        setSelected((index) => Math.min(menuItems.length - 1, index + 1));
      else if (name === "return") {
        const item = menuItems[selected];
        if (item === "Провайдер") setScreen("providers");
        else if (item === "Модель") openModel();
        else if (item === "API-ключ") setScreen("key");
        else if (item === "Адрес API") setScreen("base-url");
        else if (item === "Проверить подключение")
          run(async () => {
            const status = await actions.check(values);
            if (mounted.current) setNotice(status);
          });
        else if (item === "Сохранить") save();
        else onClose();
      }
      return;
    }
    if (screen === "providers") {
      if (name === "up" || name === "down")
        setProviderIndex(
          (index) =>
            (index + (name === "up" ? -1 : 1) + providers.length) %
            providers.length,
        );
      else if (name === "return") {
        const provider = providers[providerIndex]?.id ?? "anthropic";
        setValues((current) => ({
          ...current,
          provider,
          apiKey: undefined,
          model: current.provider === provider ? current.model : "",
          baseUrl:
            current.provider === provider
              ? current.baseUrl
              : defaultBaseUrlForProvider(provider),
        }));
        if (provider !== values.provider) {
          setHasKey(false);
          void actions
            .hasKey(provider)
            .then((saved) => {
              if (mounted.current) setHasKey(saved);
            })
            .catch(() => {});
        }
        setScreen("menu");
      }
      return;
    }
    if (screen === "model-list") {
      const count = filteredModels.length + 1;
      if (name === "up" || name === "down")
        setModelIndex(
          (index) => (index + (name === "up" ? -1 : 1) + count) % count,
        );
      else if (name === "return") {
        const picked = filteredModels[modelIndex];
        if (picked) {
          setValues((current) => ({ ...current, model: picked.id }));
          setScreen("menu");
        } else {
          if (modelFilter.trim())
            setValues((current) => ({ ...current, model: modelFilter.trim() }));
          setScreen("model-manual");
        }
      } else if (name === "backspace") {
        setModelFilter((value) => value.slice(0, -1));
        setModelIndex(0);
      } else if (
        !key.ctrl &&
        !key.meta &&
        key.sequence.length === 1 &&
        key.sequence.charCodeAt(0) >= 32
      ) {
        setModelFilter((value) => value + key.sequence);
        setModelIndex(0);
      }
      return;
    }
    const field =
      screen === "key" ? "apiKey" : screen === "base-url" ? "baseUrl" : "model";
    if (name === "return") {
      setScreen("menu");
      return;
    }
    if (name === "backspace" || name === "delete")
      setValues((current) => ({
        ...current,
        [field]: (current[field] ?? "").slice(0, -1),
      }));
    else if (
      !key.ctrl &&
      !key.meta &&
      key.sequence.length === 1 &&
      key.sequence.charCodeAt(0) >= 32
    )
      setValues((current) => ({
        ...current,
        [field]: `${current[field] ?? ""}${key.sequence}`,
      }));
  });

  const visibleModels = filteredModels.slice(
    Math.max(0, modelIndex - 3),
    Math.max(0, modelIndex - 3) + Math.max(1, height - 7),
  );
  return (
    <box
      width={width}
      height={height}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      backgroundColor="#111827"
    >
      <text fg="#78c8d4">Настройки ChiselCode</text>
      {screen === "menu" && (
        <>
          <text fg="#aebbc9">
            {values.provider} ·{" "}
            {terminalSafeText(values.model || "модель не выбрана", 70)}
          </text>
          {menuItems.map((item, index) => (
            <text key={item} fg={selected === index ? "#78c8d4" : "#aebbc9"}>
              {selected === index ? "❯ " : "  "}
              {item}
              {item === "API-ключ"
                ? ` · ${values.apiKey ? "новый ключ введён" : hasKey ? "сохранён" : "не настроен"}`
                : ""}
            </text>
          ))}
        </>
      )}
      {screen === "providers" &&
        providers.map((item, index) => (
          <text
            key={item.id}
            fg={providerIndex === index ? "#78c8d4" : "#aebbc9"}
          >
            {providerIndex === index ? "❯ " : "  "}
            {item.name}
          </text>
        ))}
      {screen === "model-list" && (
        <>
          <text fg="#aebbc9">
            Поиск модели: {terminalSafeText(modelFilter, 80)}
          </text>
          {visibleModels.map((item) => (
            <text
              key={item.id}
              fg={
                filteredModels[modelIndex]?.id === item.id
                  ? "#78c8d4"
                  : "#aebbc9"
              }
            >
              {filteredModels[modelIndex]?.id === item.id ? "❯ " : "  "}
              {terminalSafeText(item.id, Math.max(16, width - 8))}
            </text>
          ))}
          <text
            fg={modelIndex >= filteredModels.length ? "#78c8d4" : "#aebbc9"}
          >
            Ввести вручную…
          </text>
        </>
      )}
      {screen === "model-manual" && (
        <text fg="#aebbc9">Модель: {terminalSafeText(values.model, 120)}▏</text>
      )}
      {screen === "base-url" && (
        <text fg="#aebbc9">
          Адрес API: {terminalSafeText(values.baseUrl ?? "", 160)}▏
        </text>
      )}
      {screen === "key" && (
        <>
          <text fg="#e5bf74">
            Введите новый API-ключ. Enter — применить к настройкам.
          </text>
          <text fg="#aebbc9">
            Ключ: {"•".repeat(Math.min(values.apiKey?.length ?? 0, 80))}▏
          </text>
        </>
      )}
      {notice && <text fg="#e5bf74">{terminalSafeText(notice, 240)}</text>}
      <text fg="#8390a0">
        {busy ? "Подождите…" : "↑/↓ выбрать · Enter подтвердить · Esc назад"}
      </text>
    </box>
  );
}
