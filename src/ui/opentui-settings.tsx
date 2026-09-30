/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProfileIdSchema } from "../config/schema.js";
import type {
  ProviderDefinition,
  ProviderProfile,
} from "../providers/contracts.js";
import { createBuiltinProviderRegistry } from "../providers/runtime.js";
import type { ProviderId } from "../types/domain.js";
import {
  type Palette,
  THEME_NAMES,
  THEMES,
  type ThemeName,
} from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import {
  cleanSettingsInput,
  SettingsSecretInput,
} from "./opentui-settings-input.js";
import { terminalSafeText } from "./opentui-transcript.js";
import {
  type ModelListResult,
  sortModelOptions,
  type TuiSettingsValues,
} from "./settings-values.js";

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

type Screen =
  | "menu"
  | "providers"
  | "profiles"
  | "model-list"
  | "model-manual"
  | "key"
  | "base-url"
  | "profile-id";
type Page = "connection" | "appearance";
type Work = "load" | "models" | "check" | "save" | "profile" | "theme";
const labels: Record<Screen, string> = {
  menu: "Подключение",
  providers: "Выберите сервис",
  profiles: "Выберите профиль",
  "model-list": "Выберите модель",
  "model-manual": "Название модели",
  key: "API-ключ",
  "base-url": "Адрес API",
  "profile-id": "Новый профиль",
};

function safeNotice(
  message: unknown,
  values: TuiSettingsValues,
  editing: string,
  secret: boolean,
) {
  let text = message instanceof Error ? message.message : String(message);
  for (const key of [values.apiKey, secret ? editing : undefined]) {
    if (key) {
      text = text.split(key).join("[ключ скрыт]");
      if (key.trim()) text = text.split(key.trim()).join("[ключ скрыт]");
    }
  }
  return terminalSafeText(text, 600);
}

export function OpenTuiSettings({
  actions,
  width,
  height,
  palette = THEMES.obsidian,
  onClose,
  initialSelection = 0,
  initialPage = "connection",
  theme = "obsidian",
  onThemePreview,
  onThemeChange,
  setup = false,
}: {
  actions?: OpenTuiSettingsActions;
  width: number;
  height: number;
  palette?: Palette;
  onClose: (outcome?: "saved") => void;
  initialSelection?: number;
  initialPage?: Page;
  theme?: ThemeName;
  onThemePreview?: (theme: ThemeName) => void;
  onThemeChange?: (theme: ThemeName) => void | Promise<void>;
  setup?: boolean;
}) {
  const [values, setValues] = useState<TuiSettingsValues>({
    provider: "",
    model: "",
  });
  const [providers, setProviders] = useState<ProviderDefinition[]>(() =>
    createBuiltinProviderRegistry().list(),
  );
  const [profiles, setProfiles] = useState<Record<string, ProviderProfile>>({});
  const [hasKey, setHasKey] = useState(false);
  const [loaded, setLoaded] = useState(!actions);
  const [page, setPage] = useState<Page>(actions ? initialPage : "appearance");
  const [screen, setScreen] = useState<Screen>("menu");
  const [selected, setSelectedState] = useState(initialSelection);
  const selectedRef = useRef(initialSelection);
  const setSelected = (value: number | ((current: number) => number)) => {
    const next =
      typeof value === "function" ? value(selectedRef.current) : value;
    selectedRef.current = next;
    setSelectedState(next);
  };
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<Array<{ id: string; hint?: string }>>(
    [],
  );
  const [editing, setEditing] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeKind, setNoticeKind] = useState<"error" | "success" | "info">(
    "info",
  );
  const [busy, setBusy] = useState<Work>();
  const [themeIndex, setThemeIndexState] = useState(THEME_NAMES.indexOf(theme));
  const themeIndexRef = useRef(THEME_NAMES.indexOf(theme));
  const setThemeIndex = (value: number | ((current: number) => number)) => {
    const next =
      typeof value === "function" ? value(themeIndexRef.current) : value;
    themeIndexRef.current = next;
    setThemeIndexState(next);
  };
  const [savedTheme, setSavedTheme] = useState(theme);
  const lifetime = useRef({
    mounted: true,
    operation: 0,
    busy: undefined as Work | undefined,
  });
  const baseline = useRef("");
  const restore = useRef({ theme, preview: onThemePreview });
  restore.current.preview = onThemePreview;
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const { popupHeight, innerWidth, roomy, tiny } = dialogLayout(width, height);
  const showHint = popupHeight >= 10;
  const bodyHeight = Math.max(
    1,
    popupHeight -
      (tiny ? 0 : 2) -
      (roomy ? 2 : 0) -
      3 -
      (showHint ? 1 : 0) -
      (roomy ? 5 : 0) -
      (notice ? 1 : 0),
  );
  const wide = innerWidth >= 70 && roomy;
  const listWidth = wide
    ? Math.min(38, Math.floor(innerWidth * 0.43))
    : innerWidth;
  const rowHeight = roomy ? 2 : 1;
  const visibleCount = Math.max(
    1,
    Math.floor(
      (bodyHeight -
        (screen === "providers" ||
        screen === "profiles" ||
        screen === "model-list"
          ? 1
          : 0)) /
        rowHeight,
    ),
  );
  const definition = providers.find((p) => p.id === values.provider);
  const endpoint = definition?.endpoint.normalization !== "none";
  const dirty = loaded && baseline.current !== JSON.stringify(values);
  const rows: Array<{
    screen: Screen;
    label: string;
    value: string;
    help: string;
  }> = [
    {
      screen: "providers",
      label: "Сервис",
      value: definition?.label ?? values.provider,
      help: "Выберите сервис, которым будет пользоваться этот разговор. Ваши сохранённые профили останутся доступны.",
    },
    {
      screen: "model-list",
      label: "Модель",
      value: values.model || "Не выбрана",
      help: "Найдите модель в списке сервиса или введите её название вручную.",
    },
    {
      screen: "key",
      label: "API-ключ",
      value: values.apiKey
        ? "Новый ключ"
        : hasKey
          ? "Сохранён"
          : definition?.auth.required === false
            ? "Не требуется"
            : "Не настроен",
      help: "Ключ скрыт при вводе. Новый ключ заменит текущий только после сохранения. Пустое поле оставляет сохранённый ключ.",
    },
    ...(endpoint
      ? [
          {
            screen: "base-url" as const,
            label: "Адрес API",
            value: values.baseUrl || "По умолчанию",
            help: "Адрес подключения к сервису. Используйте полный URL с http:// или https://.",
          },
        ]
      : []),
    {
      screen: "profiles",
      label: "Профиль",
      value: values.profileId || "Выберите профиль",
      help: "Переключайте рабочий и личный аккаунты одного сервиса. У каждого профиля свой ключ, модель и адрес API.",
    },
    {
      screen: "profile-id",
      label: "Новый профиль",
      value: "Добавить аккаунт",
      help: "Введите новое имя профиля, затем настройте подключение. Существующие аккаунты сохранятся.",
    },
  ];
  const menuIndex = Math.min(selected, rows.length - 1);
  const filteredProviders = providers.filter((p) =>
    `${p.id} ${p.label} ${p.description ?? ""}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const filteredProfiles = Object.entries(profiles).filter(
    ([id, p]) =>
      p.providerId === values.provider &&
      `${id} ${p.label ?? ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const filteredModels = useMemo(
    () =>
      sortModelOptions(models, values.model).filter((m) =>
        `${m.id} ${m.hint ?? ""}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
      ),
    [models, query, values.model],
  );
  const choices =
    screen === "providers"
      ? filteredProviders.map((p) => ({
          id: p.id,
          label: p.label,
          hint: p.description ?? p.id,
        }))
      : screen === "profiles"
        ? filteredProfiles.map(([id, p]) => ({
            id,
            label: p.label ?? id,
            hint: p.label ? id : (p.defaultModel ?? ""),
          }))
        : screen === "model-list"
          ? [
              ...filteredModels.map((m) => ({ ...m, label: m.id })),
              {
                id: "__manual",
                label: "Ввести вручную…",
                hint: query || "Точное название модели",
              },
            ]
          : [];
  const choiceIndex = Math.min(selected, Math.max(0, choices.length - 1));
  const currentTheme = THEME_NAMES[themeIndex] ?? "obsidian";
  const selector =
    screen === "providers" || screen === "profiles" || screen === "model-list";
  const field =
    screen === "model-manual" ||
    screen === "key" ||
    screen === "base-url" ||
    screen === "profile-id";
  const setMessage = (
    text: string,
    kind: "error" | "success" | "info" = "info",
  ) => {
    setNotice(text);
    setNoticeKind(kind);
  };
  const run = (kind: Work, work: (valid: () => boolean) => Promise<void>) => {
    if (lifetime.current.busy) return;
    const operation = ++lifetime.current.operation;
    lifetime.current.busy = kind;
    setBusy(kind);
    setNotice("");
    const valid = () =>
      lifetime.current.mounted && operation === lifetime.current.operation;
    void work(valid)
      .catch((error) => {
        if (valid())
          setMessage(
            safeNotice(error, valuesRef.current, editing, screen === "key"),
            "error",
          );
      })
      .finally(() => {
        if (valid()) {
          lifetime.current.busy = undefined;
          setBusy(undefined);
        }
      });
  };
  const cancelWork = () => {
    ++lifetime.current.operation;
    lifetime.current.busy = undefined;
    setBusy(undefined);
  };
  const load = () => {
    if (!actions) return;
    run("load", async (valid) => {
      const [draft, catalog] = await Promise.all([
        actions.load(),
        actions.catalog?.(),
      ]);
      if (!valid()) return;
      if (catalog) {
        setProviders(catalog.providers);
        setProfiles(catalog.profiles);
      }
      setValues(draft.values);
      baseline.current = JSON.stringify(draft.values);
      setHasKey(draft.hasKey);
      setLoaded(true);
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Load once for each actions object; previews must not reload connection drafts.
  useEffect(() => {
    lifetime.current.mounted = true;
    load();
    return () => {
      lifetime.current.mounted = false;
      ++lifetime.current.operation;
      restore.current.preview?.(restore.current.theme);
    };
  }, [actions]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Preview follows selection, not the callback identity.
  useEffect(() => {
    if (page === "appearance") onThemePreview?.(currentTheme);
  }, [page, currentTheme]);
  const close = () => {
    if (lifetime.current.busy === "save" || lifetime.current.busy === "theme")
      return;
    cancelWork();
    onThemePreview?.(restore.current.theme);
    onClose();
  };
  const changePage = (next: Page) => {
    if (lifetime.current.busy === "save" || lifetime.current.busy === "theme")
      return;
    if (next === "connection" && !actions) return;
    if (lifetime.current.busy !== "load") cancelWork();
    onThemePreview?.(restore.current.theme);
    setPage(next);
    setScreen("menu");
    setSelected(0);
    setThemeIndex(THEME_NAMES.indexOf(restore.current.theme));
    setNotice("");
  };
  const save = () => {
    if (!actions || !loaded) return;
    run("save", async (valid) => {
      const next = {
        ...values,
        model: values.model.trim(),
        apiKey: values.apiKey?.trim() || undefined,
        baseUrl: values.baseUrl?.trim() || undefined,
      };
      if (!next.model) throw new Error("Введите название модели");
      if (
        definition?.endpoint.required &&
        !next.baseUrl &&
        !definition.endpoint.defaultBaseUrl
      )
        throw new Error("Введите адрес API");
      if (next.baseUrl) {
        let url: URL;
        try {
          url = new URL(next.baseUrl);
        } catch {
          throw new Error(
            "Введите полный адрес API, например https://api.example.com",
          );
        }
        if (url.protocol !== "https:" && url.protocol !== "http:")
          throw new Error("Адрес API должен начинаться с http:// или https://");
      }
      const result = await actions.save(next);
      if (!valid()) return;
      if (result === "saved") onClose("saved");
      else setMessage("Добавьте API-ключ для выбранного сервиса", "error");
    });
  };
  const check = () => {
    if (!actions || !loaded) {
      if (actions) load();
      return;
    }
    run("check", async (valid) => {
      const result = await actions.check(values);
      if (valid())
        setMessage(
          safeNotice(result, values, editing, screen === "key"),
          result.startsWith("✗") ? "error" : "success",
        );
    });
  };
  const applyTheme = () => {
    const chosen = THEME_NAMES[themeIndexRef.current] ?? "obsidian";
    run("theme", async (valid) => {
      await onThemeChange?.(chosen);
      if (!valid()) return;
      restore.current.theme = chosen;
      setSavedTheme(chosen);
      setMessage("Тема сохранена", "success");
    });
  };
  const open = (next: Screen) => {
    if (lifetime.current.busy || !loaded) return;
    setNotice("");
    setQuery("");
    setSelected(0);
    setScreen(next);
    if (next === "providers")
      setSelected(
        Math.max(
          0,
          providers.findIndex((p) => p.id === values.provider),
        ),
      );
    setEditing(
      next === "key"
        ? (values.apiKey ?? "")
        : next === "base-url"
          ? (values.baseUrl ?? "")
          : "",
    );
    if (next === "model-list" && actions) {
      setModels([]);
      run("models", async (valid) => {
        const result = await actions.models(values);
        if (!valid()) return;
        if (result.ok) setModels(result.models);
        else setMessage(result.error, "error");
      });
    }
  };
  const back = () => {
    if (lifetime.current.busy === "save" || lifetime.current.busy === "theme")
      return;
    cancelWork();
    if (field) setEditing("");
    setScreen("menu");
    setSelected(
      Math.max(
        0,
        rows.findIndex(
          (r) =>
            r.screen === screen ||
            (screen === "model-manual" && r.screen === "model-list"),
        ),
      ),
    );
    setNotice("");
  };
  const acceptField = () => {
    let next: TuiSettingsValues;
    if (screen === "profile-id") {
      const id = editing.trim();
      if (!ProfileIdSchema.safeParse(id).success) {
        setMessage(
          "Имя: буквы, цифры, точка, дефис или _; до 128 символов",
          "error",
        );
        return;
      }
      if (profiles[id]) {
        setMessage(
          "Такой профиль уже есть. Выберите его в списке профилей.",
          "error",
        );
        return;
      }
      next = { ...values, profileId: id, apiKey: undefined };
      setHasKey(false);
    } else
      next = {
        ...values,
        [screen === "key"
          ? "apiKey"
          : screen === "base-url"
            ? "baseUrl"
            : "model"]: editing,
      };
    setValues(next);
    back();
  };
  const choose = (
    index = Math.min(selectedRef.current, choices.length - 1),
  ) => {
    if (!actions) return;
    const picked = choices[index];
    if (!picked) return;
    if (lifetime.current.busy) {
      if (lifetime.current.busy !== "models" || picked.id !== "__manual")
        return;
      cancelWork();
    }
    if (screen === "model-list") {
      if (picked.id === "__manual") {
        setEditing(query.trim() || values.model);
        setScreen("model-manual");
        setNotice("");
      } else {
        setValues((v) => ({ ...v, model: picked.id }));
        back();
      }
    } else if (screen === "profiles") {
      run("profile", async (valid) => {
        const loaded = await actions.load(picked.id);
        if (!valid()) return;
        setValues(loaded.values);
        setHasKey(loaded.hasKey);
        back();
      });
    } else {
      const provider = filteredProviders[index];
      if (!provider) return;
      if (provider.id === values.provider) {
        back();
        return;
      }
      const accounts = Object.entries(profiles).filter(
        ([, p]) => p.providerId === provider.id,
      );
      const profileId =
        accounts.length === 1
          ? accounts[0]?.[0]
          : accounts.length === 0
            ? `${provider.id.replaceAll("/", "-")}-default`
            : undefined;
      const next: TuiSettingsValues = {
        provider: provider.id,
        profileId,
        model: provider.defaults.model ?? "",
        baseUrl:
          provider.endpoint.normalization !== "none"
            ? provider.endpoint.defaultBaseUrl
            : undefined,
      };
      setValues(next);
      setHasKey(false);
      setQuery("");
      setSelected(0);
      if (accounts.length > 1) {
        setScreen("profiles");
        return;
      }
      run("profile", async (valid) => {
        if (accounts.length === 1 && profileId) {
          const loaded = await actions.load(profileId);
          if (!valid()) return;
          setValues(loaded.values);
          setHasKey(loaded.hasKey);
        } else {
          const saved = await actions.hasKey(provider.id, profileId);
          if (!valid()) return;
          setHasKey(saved);
        }
        back();
      });
    }
  };
  useKeyboard((key) => {
    const name = key.name.toLowerCase();
    if (key.ctrl && name === "c") return;
    if (name === "escape") {
      key.preventDefault();
      if (page === "connection" && screen !== "menu") back();
      else close();
      return;
    }
    if (key.ctrl && name === "t") {
      key.preventDefault();
      changePage("appearance");
      return;
    }
    if (lifetime.current.busy) {
      if (lifetime.current.busy === "models" && name === "return") choose();
      if (name === "return" || name === "tab") key.preventDefault();
      return;
    }
    if (key.ctrl && name === "s") {
      key.preventDefault();
      if (page === "appearance") applyTheme();
      else if (!field) save();
      return;
    }
    if (key.ctrl && name === "r") {
      key.preventDefault();
      if (page === "connection") check();
      return;
    }
    if (name === "tab") {
      key.preventDefault();
      if (!field)
        changePage(page === "connection" ? "appearance" : "connection");
      return;
    }
    if (page === "appearance") {
      if (
        name === "up" ||
        name === "down" ||
        name === "left" ||
        name === "right"
      ) {
        key.preventDefault();
        setNotice("");
        setThemeIndex(
          (i) =>
            (i +
              (name === "up" || name === "left" ? -1 : 1) +
              THEME_NAMES.length) %
            THEME_NAMES.length,
        );
      } else if (name === "return") {
        key.preventDefault();
        applyTheme();
      }
      return;
    }
    if (field) return;
    if (
      name === "up" ||
      name === "down" ||
      name === "pageup" ||
      name === "pagedown"
    ) {
      key.preventDefault();
      const count = selector ? choices.length : rows.length;
      const delta =
        name === "up"
          ? -1
          : name === "down"
            ? 1
            : name === "pageup"
              ? -visibleCount
              : visibleCount;
      setSelected((i) => Math.max(0, Math.min(count - 1, i + delta)));
    } else if (name === "return") {
      key.preventDefault();
      if (selector) choose();
      else {
        const row = rows[Math.min(selectedRef.current, rows.length - 1)];
        if (row) open(row.screen);
      }
    }
  });

  const start = (index: number, count: number) =>
    Math.max(0, Math.min(index - visibleCount + 1, count - visibleCount));
  const list = selector
    ? choices
    : rows.map((r) => ({ id: r.screen, label: r.label, hint: r.value }));
  const index = selector ? choiceIndex : menuIndex;
  const first = start(index, list.length);
  const safeValue = (value: string) =>
    safeNotice(value, values, editing, screen === "key");
  const help = rows[menuIndex]?.help ?? "";
  const hints =
    innerWidth < 50
      ? page === "appearance"
        ? "↑↓ · Enter применить · Esc отмена"
        : field
          ? "Enter готово · Esc отмена"
          : selector
            ? "Поиск · ↑↓ · Enter · Esc назад"
            : "↑↓ Enter · Tab · Ctrl+S · Esc"
      : page === "appearance"
        ? "↑↓ предпросмотр · Enter применить · Esc отменить"
        : field
          ? "Enter подтвердить · Esc отменить"
          : selector
            ? "Поиск · ↑↓ выбрать · Enter · Esc назад"
            : "↑↓ / Enter · Tab раздел · Ctrl+S сохранить";
  return (
    <OpenTuiDialog
      id="settings"
      width={width}
      height={height}
      palette={palette}
      onClose={close}
    >
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={palette.accent} height={1}>
          <strong>Настройки ChiselCode</strong>
        </text>
        <DialogAction
          id="settings-close"
          label="Esc ×"
          palette={palette}
          onSelect={close}
          disabled={busy === "save" || busy === "theme"}
        />
      </box>
      {roomy && (
        <text height={1} fg={palette.muted}>
          {setup
            ? "Подключите сервис, чтобы начать работу"
            : "Ваше подключение и оформление"}
        </text>
      )}
      <box
        height={1}
        flexShrink={0}
        marginTop={roomy ? 1 : 0}
        flexDirection="row"
        gap={1}
      >
        <DialogAction
          id="settings-connection"
          label="Подключение"
          palette={palette}
          active={page === "connection"}
          disabled={!actions}
          onSelect={() => changePage("connection")}
        />
        <DialogAction
          id="settings-appearance"
          label="Оформление"
          palette={palette}
          active={page === "appearance"}
          onSelect={() => changePage("appearance")}
        />
      </box>
      <box
        height={bodyHeight}
        flexShrink={0}
        marginTop={roomy ? 1 : 0}
        flexDirection="column"
        overflow="hidden"
      >
        {page === "appearance" ? (
          <box flexDirection="row" height="100%" width="100%">
            <box
              width={wide ? listWidth : innerWidth}
              height="100%"
              flexDirection="column"
            >
              {THEME_NAMES.slice(
                start(themeIndex, THEME_NAMES.length),
                start(themeIndex, THEME_NAMES.length) + visibleCount,
              ).map((name) => {
                const colors = THEMES[name];
                const active = name === currentTheme;
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: Arrow keys preview themes and Enter applies.
                  <box
                    id={`settings-theme-${name}`}
                    key={name}
                    height={rowHeight}
                    flexShrink={0}
                    flexDirection="column"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={active ? palette.raised : palette.surface}
                    onMouseUp={(event) => {
                      event.stopPropagation();
                      if (!busy) {
                        setThemeIndex(THEME_NAMES.indexOf(name));
                        setNotice("");
                      }
                    }}
                  >
                    <box
                      height={1}
                      flexDirection="row"
                      justifyContent="space-between"
                    >
                      <text
                        height={1}
                        fg={active ? palette.accent : palette.text}
                      >
                        {(active ? "❯ " : "  ") +
                          colors.label +
                          (name === savedTheme ? " ✓" : "")}
                      </text>
                      <text height={1} fg={colors.accent} selectable={false}>
                        <span fg={colors.bg}>■ </span>
                        <span fg={colors.surface}>■ </span>
                        <span fg={colors.accent}>■</span>
                      </text>
                    </box>
                    {roomy && (
                      <text height={1} fg={palette.muted}>
                        {colors.description}
                      </text>
                    )}
                  </box>
                );
              })}
            </box>
            {wide && (
              <box
                width={innerWidth - listWidth}
                height="100%"
                paddingLeft={2}
                flexDirection="column"
              >
                <text height={1} fg={palette.accent}>
                  <strong>{THEMES[currentTheme].label}</strong>
                </text>
                <text fg={palette.muted}>
                  {THEMES[currentTheme].description}
                </text>
                <box
                  marginTop={1}
                  height={5}
                  backgroundColor={palette.bg}
                  border
                  borderStyle="rounded"
                  borderColor={palette.border}
                  paddingLeft={1}
                  flexDirection="column"
                >
                  <text fg={palette.muted}>❯ Проверь мой проект</text>
                  <text fg={palette.accent}>◆ Chisel</text>
                  <text fg={palette.text}>Готов к следующей задаче.</text>
                </box>
                <text marginTop={1} fg={palette.muted}>
                  Стрелки показывают тему во всём интерфейсе. Примените
                  понравившийся вариант или нажмите Esc, чтобы вернуться.
                </text>
              </box>
            )}
          </box>
        ) : field ? (
          <box width="100%" height="100%" flexDirection="column">
            <text height={1} fg={palette.accent}>
              {labels[screen]}
            </text>
            <box
              width="100%"
              height={roomy ? 3 : 1}
              marginTop={roomy ? 1 : 0}
              border={roomy ? true : []}
              borderStyle="rounded"
              borderColor={palette.accent}
              backgroundColor={palette.raised}
              paddingLeft={1}
              paddingRight={1}
            >
              {screen === "key" ? (
                <SettingsSecretInput
                  value={editing}
                  onChange={setEditing}
                  onSubmit={acceptField}
                  palette={palette}
                />
              ) : (
                <input
                  key={screen}
                  id="settings-field"
                  value={editing}
                  focused
                  maxLength={screen === "profile-id" ? 128 : 4096}
                  placeholder={
                    screen === "base-url"
                      ? "https://api.example.com"
                      : screen === "profile-id"
                        ? "например work"
                        : "Точное название модели"
                  }
                  backgroundColor={palette.raised}
                  focusedBackgroundColor={palette.raised}
                  textColor={palette.text}
                  focusedTextColor={palette.text}
                  placeholderColor={palette.muted}
                  onInput={(value) => {
                    setEditing(cleanSettingsInput(value));
                    setNotice("");
                  }}
                  onSubmit={acceptField}
                />
              )}
            </box>
            {roomy && (
              <text marginTop={1} fg={palette.muted}>
                {screen === "key"
                  ? "Ключ скрыт и будет записан только после сохранения подключения."
                  : screen === "profile-id"
                    ? "Уникальное имя для отдельного аккаунта этого сервиса."
                    : "Введите значение. Enter подтвердит его, Esc отменит редактирование."}
              </text>
            )}
          </box>
        ) : (
          <>
            {selector && (
              <box
                height={1}
                flexShrink={0}
                backgroundColor={palette.raised}
                paddingLeft={1}
              >
                <input
                  key={screen}
                  id="settings-search"
                  value={query}
                  focused
                  placeholder={`${labels[screen]} · поиск…`}
                  backgroundColor={palette.raised}
                  focusedBackgroundColor={palette.raised}
                  textColor={palette.text}
                  focusedTextColor={palette.text}
                  placeholderColor={palette.muted}
                  onInput={(value) => {
                    setQuery(cleanSettingsInput(value));
                    setSelected(0);
                  }}
                />
              </box>
            )}
            <box width="100%" flexGrow={1} minHeight={0} flexDirection="row">
              <box
                width={listWidth}
                height="100%"
                flexDirection="column"
                onMouseScroll={(event) => {
                  event.stopPropagation();
                  const direction = event.scroll?.direction;
                  if (!busy && (direction === "up" || direction === "down"))
                    setSelected((i) =>
                      Math.max(
                        0,
                        Math.min(
                          list.length - 1,
                          i + (direction === "up" ? -1 : 1),
                        ),
                      ),
                    );
                }}
              >
                {page === "connection" && !loaded ? (
                  <text fg={palette.muted}>
                    {busy
                      ? "Загружаем подключение…"
                      : "Не удалось загрузить настройки"}
                  </text>
                ) : (
                  list
                    .slice(
                      first,
                      first +
                        Math.max(
                          1,
                          Math.floor(
                            (bodyHeight - (selector ? 1 : 0)) / rowHeight,
                          ),
                        ),
                    )
                    .map((item, offset) => (
                      // biome-ignore lint/a11y/noStaticElementInteractions: Enter also activates the selected item.
                      <box
                        key={item.id}
                        id={`settings-row-${item.id}`}
                        height={rowHeight}
                        flexShrink={0}
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={
                          first + offset === index
                            ? palette.raised
                            : palette.surface
                        }
                        flexDirection="column"
                        onMouseUp={(event) => {
                          event.stopPropagation();
                          if (
                            busy &&
                            !(busy === "models" && item.id === "__manual")
                          )
                            return;
                          setSelected(first + offset);
                          if (selector) choose(first + offset);
                          else {
                            const row = rows[first + offset];
                            if (row) open(row.screen);
                          }
                        }}
                      >
                        <text
                          height={1}
                          fg={
                            first + offset === index
                              ? palette.accent
                              : palette.text
                          }
                        >
                          {terminalSafeText(
                            (first + offset === index ? "❯ " : "  ") +
                              item.label +
                              (!roomy && !selector
                                ? `: ${safeValue(item.hint ?? "")}`
                                : ""),
                            listWidth - 2,
                          )}
                        </text>
                        {roomy && (
                          <text height={1} fg={palette.muted}>
                            {terminalSafeText(
                              safeValue(item.hint ?? ""),
                              listWidth - 2,
                            )}
                          </text>
                        )}
                      </box>
                    ))
                )}
                {!list.length && loaded && (
                  <text fg={palette.muted}>Ничего не найдено</text>
                )}
              </box>
              {wide && (
                <box
                  width={innerWidth - listWidth}
                  height="100%"
                  paddingLeft={2}
                  flexDirection="column"
                >
                  <text height={1} fg={palette.accent}>
                    <strong>
                      {selector ? labels[screen] : rows[menuIndex]?.label}
                    </strong>
                  </text>
                  <text marginTop={1} fg={palette.text}>
                    {safeValue(
                      selector
                        ? (choices[choiceIndex]?.label ?? "Нет результатов")
                        : (rows[menuIndex]?.value ?? ""),
                    )}
                  </text>
                  <text marginTop={1} fg={palette.muted}>
                    {selector
                      ? safeValue(choices[choiceIndex]?.hint ?? "")
                      : help}
                  </text>
                  {!selector && (
                    <text
                      marginTop={1}
                      fg={dirty ? palette.yellow : palette.green}
                    >
                      {dirty
                        ? "Есть несохранённые изменения"
                        : "Подключение сохранено"}
                    </text>
                  )}
                </box>
              )}
            </box>
          </>
        )}
      </box>
      {notice && (
        <text
          height={1}
          flexShrink={0}
          fg={
            noticeKind === "error"
              ? palette.red
              : noticeKind === "success"
                ? palette.green
                : palette.muted
          }
        >
          {terminalSafeText(safeValue(notice), innerWidth)}
        </text>
      )}
      <box
        height={1}
        marginTop={roomy ? 1 : 0}
        flexShrink={0}
        flexDirection="row"
        gap={1}
      >
        {page === "appearance" ? (
          <DialogAction
            id="settings-apply-theme"
            label={busy === "theme" ? "Сохраняем…" : "Применить тему"}
            primary
            palette={palette}
            disabled={!!busy}
            onSelect={applyTheme}
          />
        ) : field || selector ? (
          <>
            <DialogAction
              id="settings-back"
              label="← Назад"
              palette={palette}
              onSelect={back}
              disabled={busy === "save"}
            />
            <DialogAction
              id="settings-confirm"
              label={field ? "Подтвердить" : "Выбрать"}
              primary
              palette={palette}
              disabled={
                !!busy &&
                !(busy === "models" && choices[index]?.id === "__manual")
              }
              onSelect={field ? acceptField : () => choose()}
            />
          </>
        ) : (
          <>
            <DialogAction
              id="settings-check"
              label={
                busy === "check"
                  ? "Проверяем…"
                  : !loaded && !busy
                    ? "Повторить"
                    : "Проверить"
              }
              palette={palette}
              onSelect={check}
              disabled={!!busy}
            />
            <DialogAction
              id="settings-save"
              label={busy === "save" ? "Сохраняем…" : "Сохранить"}
              primary
              palette={palette}
              disabled={!!busy || !loaded}
              onSelect={save}
            />
          </>
        )}
      </box>
      {showHint && (
        <text height={1} marginTop={roomy ? 1 : 0} fg={palette.muted}>
          {terminalSafeText(
            busy
              ? busy === "models"
                ? "Загружаем модели… · Esc назад"
                : busy === "check"
                  ? "Проверяем подключение… · Esc закрыть"
                  : "Подождите…"
              : hints,
            innerWidth,
          )}
        </text>
      )}
    </OpenTuiDialog>
  );
}
