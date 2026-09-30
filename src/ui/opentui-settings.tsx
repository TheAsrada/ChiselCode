/** @jsxImportSource @opentui/react */

import { useKeyboard, usePaste } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProviderDefinition,
  ProviderProfile,
} from "../providers/contracts.js";
import { createBuiltinProviderRegistry } from "../providers/runtime.js";
import type { ProviderId } from "../types/domain.js";
import { type Palette, THEMES } from "./appearance.js";
import { terminalSafeText } from "./opentui-transcript.js";
import { selectorWindow } from "./provider-settings.js";
import type { ModelListResult, TuiSettingsValues } from "./settings-values.js";

export interface OpenTuiSettingsActions {
  catalog?(): Promise<{
    providers: ProviderDefinition[];
    profiles: Record<string, ProviderProfile>;
  }>;
  load(
    profileId?: string,
  ): Promise<{ values: TuiSettingsValues; hasKey: boolean }>;
  hasKey(provider: ProviderId, profileId?: string): Promise<boolean>;
  save(values: TuiSettingsValues): Promise<"saved" | "setup_required">;
  check(values: TuiSettingsValues): Promise<string>;
  models(values: TuiSettingsValues): Promise<ModelListResult>;
}

const menu = [
  "Провайдер",
  "Модель",
  "API-ключ",
  "Адрес API",
  "Проверить подключение",
  "Сохранить",
  "Профиль",
  "Новый профиль",
  "Закрыть",
];
type Screen =
  | "menu"
  | "providers"
  | "profiles"
  | "profile-id"
  | "model-list"
  | "model-manual"
  | "key"
  | "base-url";

export function OpenTuiSettings({
  actions,
  width,
  height,
  palette = THEMES.obsidian,
  onClose,
  initialSelection = 0,
}: {
  actions: OpenTuiSettingsActions;
  width: number;
  height: number;
  palette?: Palette;
  onClose: (outcome?: "saved") => void;
  initialSelection?: number;
}) {
  const [values, setValues] = useState<TuiSettingsValues>({
    provider: "",
    model: "",
  });
  const [providers, setProviders] = useState<ProviderDefinition[]>(() =>
    createBuiltinProviderRegistry().list(),
  );
  const [profiles, setProfiles] = useState<Record<string, ProviderProfile>>({});
  const [providerFilter, setProviderFilter] = useState("");
  const [profileIndex, setProfileIndex] = useState(0);
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
    void Promise.all([actions.load(), actions.catalog?.()])
      .then(([{ values: loaded, hasKey: saved }, catalog]) => {
        if (catalog) {
          setProviders(catalog.providers);
          setProfiles(catalog.profiles);
        }
        if (!mounted.current) return;
        setValues(loaded);
        setHasKey(saved);
        setProviderIndex(
          Math.max(
            0,
            (
              catalog?.providers ?? createBuiltinProviderRegistry().list()
            ).findIndex((item) => item.id === loaded.provider),
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
  const definition = providers.find((d) => d.id === values.provider);
  const filteredProviders = providers.filter((d) =>
    `${d.id} ${d.label} ${d.description ?? ""}`
      .toLowerCase()
      .includes(providerFilter.toLowerCase()),
  );
  const filteredProfiles = Object.entries(profiles).filter(
    ([, p]) => p.providerId === values.provider,
  );
  const compatible = (provider: string) =>
    providers.find((d) => d.id === provider)?.endpoint.normalization !== "none";
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
      if (
        definition?.endpoint.required &&
        !next.baseUrl &&
        !definition.endpoint.defaultBaseUrl
      )
        throw new Error("Введите адрес API");
      if (next.baseUrl) {
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
    if (
      screen !== "key" &&
      screen !== "model-manual" &&
      screen !== "base-url" &&
      screen !== "profile-id"
    )
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
      screen === "key"
        ? "apiKey"
        : screen === "base-url"
          ? "baseUrl"
          : screen === "profile-id"
            ? "profileId"
            : "model";
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
        if (item === "Провайдер") {
          setProviderFilter("");
          setProviderIndex(
            Math.max(
              0,
              providers.findIndex((p) => p.id === values.provider),
            ),
          );
          setScreen("providers");
        } else if (item === "Профиль") {
          setProfileIndex(0);
          setScreen("profiles");
        } else if (item === "Новый профиль") {
          setValues((c) => ({ ...c, profileId: "", apiKey: undefined }));
          setHasKey(false);
          setScreen("profile-id");
        } else if (item === "Модель") openModel();
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
    if (screen === "profiles") {
      if (name === "up" || name === "down")
        setProfileIndex(
          (i) =>
            (i +
              (name === "up" ? -1 : 1) +
              Math.max(1, filteredProfiles.length)) %
            Math.max(1, filteredProfiles.length),
        );
      else if (name === "return") {
        const picked = filteredProfiles[profileIndex];
        if (picked)
          run(async () => {
            const loaded = await actions.load(picked[0]);
            if (mounted.current) {
              setValues(loaded.values);
              setHasKey(loaded.hasKey);
              setScreen("menu");
            }
          });
      }
      return;
    }
    if (screen === "providers") {
      if (name === "up" || name === "down")
        setProviderIndex(
          (i) =>
            (i +
              (name === "up" ? -1 : 1) +
              Math.max(1, filteredProviders.length)) %
            Math.max(1, filteredProviders.length),
        );
      else if (name === "backspace") {
        setProviderFilter((q) => q.slice(0, -1));
        setProviderIndex(0);
      } else if (name === "return") {
        const picked = filteredProviders[providerIndex];
        if (!picked) return;
        const matches = Object.entries(profiles).filter(
          ([, p]) => p.providerId === picked.id,
        );
        const profileId =
          matches.length === 1
            ? matches[0]?.[0]
            : matches.length === 0
              ? `${picked.id.replaceAll("/", "-")}-default`
              : undefined;
        setValues((c) =>
          c.provider === picked.id
            ? c
            : {
                provider: picked.id,
                profileId,
                apiKey: undefined,
                model: picked.defaults.model ?? "",
                baseUrl:
                  picked.endpoint.normalization !== "none"
                    ? picked.endpoint.defaultBaseUrl
                    : undefined,
              },
        );
        setHasKey(false);
        if (matches.length === 1 && profileId)
          run(async () => {
            const loaded = await actions.load(profileId);
            if (mounted.current) {
              setValues(loaded.values);
              setHasKey(loaded.hasKey);
            }
          });
        else
          void actions
            .hasKey(picked.id, profileId)
            .then((saved) => {
              if (mounted.current) setHasKey(saved);
            })
            .catch(() => {});
        setProfileIndex(0);
        setScreen(matches.length > 1 ? "profiles" : "menu");
      } else if (
        !key.ctrl &&
        !key.meta &&
        key.sequence.length === 1 &&
        key.sequence.charCodeAt(0) >= 32
      ) {
        setProviderFilter((q) => q + key.sequence);
        setProviderIndex(0);
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
      screen === "key"
        ? "apiKey"
        : screen === "base-url"
          ? "baseUrl"
          : screen === "profile-id"
            ? "profileId"
            : "model";
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
      backgroundColor={palette.bg}
    >
      <text fg={palette.accent}>Настройки ChiselCode</text>
      {screen === "menu" && (
        <>
          <text fg={palette.muted}>
            {terminalSafeText(values.provider, 40)} ·{" "}
            {terminalSafeText(values.profileId ?? "выберите профиль", 40)} ·{" "}
            {terminalSafeText(values.model || "модель не выбрана", 70)}
          </text>
          {menuItems.map((item, index) => (
            <text
              key={item}
              fg={selected === index ? palette.accent : palette.muted}
            >
              {selected === index ? "❯ " : "  "}
              {item}
              {item === "API-ключ"
                ? ` · ${values.apiKey ? "новый ключ введён" : hasKey ? "сохранён" : "не настроен"}`
                : ""}
            </text>
          ))}
        </>
      )}
      {screen === "providers" && (
        <>
          <text fg={palette.muted}>
            Поиск: {terminalSafeText(providerFilter, 60)} ·{" "}
            {filteredProviders.length}
          </text>
          {selectorWindow(filteredProviders, providerIndex, height).map(
            (item) => (
              <text
                key={item.id}
                fg={
                  filteredProviders[providerIndex]?.id === item.id
                    ? palette.accent
                    : palette.muted
                }
              >
                {filteredProviders[providerIndex]?.id === item.id ? "❯ " : "  "}
                {terminalSafeText(
                  `${item.label} · ${item.id}`,
                  Math.max(16, width - 5),
                )}
              </text>
            ),
          )}
        </>
      )}
      {screen === "profiles" && (
        <>
          <text fg={palette.muted}>
            Профили {terminalSafeText(values.provider, 60)}
          </text>
          {selectorWindow(filteredProfiles, profileIndex, height).map(
            ([id, p]) => (
              <text
                key={id}
                fg={
                  filteredProfiles[profileIndex]?.[0] === id
                    ? palette.accent
                    : palette.muted
                }
              >
                {filteredProfiles[profileIndex]?.[0] === id ? "❯ " : "  "}
                {terminalSafeText(
                  p.label ? `${p.label} · ${id}` : id,
                  Math.max(16, width - 5),
                )}
              </text>
            ),
          )}
          {!filteredProfiles.length && (
            <text fg={palette.muted}>
              Нет профилей. Выберите «Новый профиль».
            </text>
          )}
        </>
      )}
      {screen === "profile-id" && (
        <text fg={palette.muted}>
          ID профиля: {terminalSafeText(values.profileId ?? "", 100)}▏
        </text>
      )}
      {screen === "model-list" && (
        <>
          <text fg={palette.muted}>
            Поиск модели: {terminalSafeText(modelFilter, 80)}
          </text>
          {visibleModels.map((item) => (
            <text
              key={item.id}
              fg={
                filteredModels[modelIndex]?.id === item.id
                  ? palette.accent
                  : palette.muted
              }
            >
              {filteredModels[modelIndex]?.id === item.id ? "❯ " : "  "}
              {terminalSafeText(item.id, Math.max(16, width - 8))}
            </text>
          ))}
          <text
            fg={
              modelIndex >= filteredModels.length
                ? palette.accent
                : palette.muted
            }
          >
            Ввести вручную…
          </text>
        </>
      )}
      {screen === "model-manual" && (
        <text fg={palette.muted}>
          Модель: {terminalSafeText(values.model, 120)}▏
        </text>
      )}
      {screen === "base-url" && (
        <text fg={palette.muted}>
          Адрес API: {terminalSafeText(values.baseUrl ?? "", 160)}▏
        </text>
      )}
      {screen === "key" && (
        <>
          <text fg={palette.yellow}>
            Введите новый API-ключ. Enter — применить к настройкам.
          </text>
          <text fg={palette.muted}>
            Ключ: {"•".repeat(Math.min(values.apiKey?.length ?? 0, 80))}▏
          </text>
        </>
      )}
      {notice && (
        <text fg={palette.yellow}>{terminalSafeText(notice, 240)}</text>
      )}
      <text fg={palette.muted}>
        {busy ? "Подождите…" : "↑/↓ выбрать · Enter подтвердить · Esc назад"}
      </text>
    </box>
  );
}
