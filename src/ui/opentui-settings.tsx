/** @jsxImportSource @opentui/react */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundSettingsActions } from "../background/settings.js";
import { ProfileIdSchema } from "../config/schema.js";
import type { ExtensionManagementService } from "../extensions/management.js";
import type { LspSettingsActions } from "../lsp/settings.js";
import type { OpenTuiMcpActions } from "../mcp/controller.js";
import type {
  ProviderDefinition,
  ProviderProfile,
} from "../providers/contracts.js";
import { createBuiltinProviderRegistry } from "../providers/runtime.js";
import type { Skill } from "../skills/skills.js";
import type { SubagentSettingsActions } from "../subagents/settings.js";
import { ThemeCatalog } from "../themes/catalog.js";
import type { ProviderId } from "../types/domain.js";
import type { WebSettingsActions } from "../web/settings.js";
import { type Palette, THEMES, type ThemeName } from "./appearance.js";
import { OpenTuiBackgroundSettings } from "./opentui-background-settings.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { OpenTuiExtensions } from "./opentui-extensions.js";
import { OpenTuiLspSettings } from "./opentui-lsp-settings.js";
import { OpenTuiMcp } from "./opentui-mcp.js";
import {
  cleanSettingsInput,
  SettingsSecretInput,
} from "./opentui-settings-input.js";
import { OpenTuiSkills, type OpenTuiSkillsActions } from "./opentui-skills.js";
import { OpenTuiSubagentSettings } from "./opentui-subagent-settings.js";
import { terminalSafeText } from "./opentui-transcript.js";
import { OpenTuiWebSettings } from "./opentui-web-settings.js";
import { useUiKeyboard } from "./overlay-input.js";
import {
  SETTINGS_SECTIONS,
  type SettingsRoute,
  searchSettings,
} from "./settings-catalog.js";
import { SettingsNavigation } from "./settings-navigation.js";
import type { SettingsPanelControl } from "./settings-panel.js";
import {
  type ModelListResult,
  sortModelOptions,
  type TuiSettingsValues,
} from "./settings-values.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import { FAIL_MARK } from "./theme.js";

export interface OpenTuiSettingsActions {
  extensions?: ExtensionManagementService;
  background?: BackgroundSettingsActions;
  subagents?: SubagentSettingsActions;
  web?: WebSettingsActions;
  lsp?: LspSettingsActions;
  workspaceRoot?: string;
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
type Page = SettingsRoute | "web";
type Work =
  | "load"
  | "models"
  | "check"
  | "save"
  | "profile"
  | "theme"
  | "permissions";
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
  themeCatalog,
  onThemePreview,
  onThemeChange,
  allowBypassPermissions = false,
  onBypassAvailabilityChange,
  setup = false,
  active = true,
  getMcpActions,
  skillsActions,
  onChooseSkill,
  onCreateSkill,
  onEditSkill,
}: {
  actions?: OpenTuiSettingsActions;
  width: number;
  height: number;
  palette?: Palette;
  onClose: (outcome?: "saved") => void;
  initialSelection?: number;
  initialPage?: Page;
  theme?: ThemeName;
  themeCatalog?: ThemeCatalog;
  onThemePreview?: (theme: ThemeName) => void;
  onThemeChange?: (theme: ThemeName) => void | Promise<void>;
  allowBypassPermissions?: boolean;
  onBypassAvailabilityChange?: (allowed: boolean) => Promise<void>;
  setup?: boolean;
  active?: boolean;
  getMcpActions?: () => OpenTuiMcpActions;
  skillsActions?: OpenTuiSkillsActions;
  onChooseSkill?: (skill: Skill) => void;
  onCreateSkill?: () => void;
  onEditSkill?: (skill: Skill) => void;
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
  const [page, setPage] = useState<Page>(
    actions || initialPage === "permissions" ? initialPage : "appearance",
  );
  const [shellFocus, setShellFocus] = useState<
    "search" | "navigation" | "content" | "actions"
  >("content");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [navigationIndex, setNavigationIndex] = useState(0);
  const [compactDetail, setCompactDetail] = useState(
    setup || initialPage !== "connection",
  );
  const [fieldTarget, setFieldTarget] = useState<string>();
  const [confirmClose, setConfirmClose] = useState(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const completeClose = (outcome?: "saved") => {
    const next = afterClose.current;
    afterClose.current = undefined;
    onClose(outcome);
    next?.();
  };
  const [mcp, setMcp] = useState<OpenTuiMcpActions>();
  const [mcpDirty, setMcpDirty] = useState(false);
  const recordMcpDirty = useCallback(
    (value: boolean) => setMcpDirty(value),
    [],
  );
  const mcpControls = useRef<SettingsPanelControl | undefined>(undefined);
  const skillsControls = useRef<SettingsPanelControl | undefined>(undefined);
  const [skillsVisited, setSkillsVisited] = useState(
    initialPage === "tools.skills",
  );
  useEffect(() => {
    if (page === "tools.skills") setSkillsVisited(true);
    if (page === "tools.mcp" && !mcp && getMcpActions) {
      try {
        setMcp(getMcpActions());
      } catch (cause) {
        setNotice(String(cause));
      }
    }
  }, [page, mcp, getMcpActions]);
  const [backgroundDirty, setBackgroundDirty] = useState(false);
  const [extensionsDirty, setExtensionsDirty] = useState(false);
  const extensionsControls = useRef<SettingsPanelControl | undefined>(
    undefined,
  );
  const recordExtensionsDirty = useCallback(
    (dirty: boolean) => setExtensionsDirty(dirty),
    [],
  );
  const backgroundControls = useRef<SettingsPanelControl | undefined>(
    undefined,
  );
  const recordBackgroundDirty = useCallback(
    (value: boolean) => setBackgroundDirty(value),
    [],
  );
  const [subagentDirty, setSubagentDirty] = useState(false);
  const subagentControls = useRef<SettingsPanelControl | undefined>(undefined);
  const recordSubagentDirty = useCallback(
    (value: boolean) => setSubagentDirty(value),
    [],
  );
  const [webDirty, setWebDirty] = useState(false);
  const webControls = useRef<SettingsPanelControl | undefined>(undefined);
  const recordWebDirty = useCallback(
    (value: boolean) => setWebDirty(value),
    [],
  );
  const [closeSelection, setCloseSelection] = useState(0);
  const [lspDirty, setLspDirty] = useState(false);
  const lspControls = useRef<SettingsPanelControl | undefined>(undefined);
  const recordLspDirty = useCallback(
    (dirty: boolean) => setLspDirty(dirty),
    [],
  );
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
  const catalog = useMemo(
    () => themeCatalog ?? new ThemeCatalog(),
    [themeCatalog],
  );
  const [themeSearch, setThemeSearch] = useState("");
  const [themeSearchFocus, setThemeSearchFocus] = useState(false);
  const themes = catalog
    .list()
    .filter((item) =>
      `${item.name} ${item.source} ${item.description} ${item.variant === "light" ? "светлая" : "тёмная"}`
        .toLocaleLowerCase()
        .includes(themeSearch.toLocaleLowerCase()),
    );
  const names = themes.map((item) => item.key);
  const [themeIndex, setThemeIndexState] = useState(
    Math.max(0, names.indexOf(theme)),
  );
  const themeIndexRef = useRef(Math.max(0, names.indexOf(theme)));
  const setThemeIndex = (value: number | ((current: number) => number)) => {
    const next =
      typeof value === "function" ? value(themeIndexRef.current) : value;
    themeIndexRef.current = next;
    setThemeIndexState(next);
  };
  const [savedTheme, setSavedTheme] = useState(theme);
  const [bypassAllowed, setBypassAllowed] = useState(allowBypassPermissions);
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
  const {
    popupHeight,
    innerWidth: surfaceWidth,
    roomy,
    tiny,
  } = dialogLayout(width, height, 30, 104);
  const split = width >= 100 && height >= 26;
  const navigationWidth = split ? 26 : surfaceWidth;
  const innerWidth = split
    ? Math.max(1, surfaceWidth - navigationWidth - 1)
    : surfaceWidth;
  const catalogue = searchSettings(settingsQuery);
  const showNavigation = split || !compactDetail || !!settingsQuery;
  const navigationOnly = !!settingsQuery || (!split && !compactDetail);
  const route = page === "web" ? "tools.web" : page;
  const section = SETTINGS_SECTIONS.find((item) => item.id === route);
  useEffect(() => {
    if (!settingsQuery)
      setNavigationIndex(
        SETTINGS_SECTIONS.findIndex((item) => item.id === route),
      );
  }, [route, settingsQuery]);
  const simpleFooter =
    navigationOnly ||
    [
      "extensions",
      "tools.subagents",
      "tools.background",
      "tools.lsp",
      "tools.mcp",
      "tools.skills",
      "web",
    ].includes(page);
  const showHint = popupHeight >= 10 && !simpleFooter;
  const contentHeight = Math.max(
    1,
    popupHeight -
      (tiny ? 0 : 2) -
      (roomy ? 2 : 0) -
      (tiny && compactDetail && shellFocus !== "search" ? 0 : 2) -
      (showHint ? 2 : 1) -
      (notice ? 1 : 0) -
      (page === "appearance" ? 1 : 0),
  );
  const bodyHeight = Math.max(1, contentHeight - (split ? 2 : 0));
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
  const themeVisibleCount = Math.max(
    1,
    Math.floor(Math.max(1, bodyHeight - 2) / rowHeight),
  );
  const themeFirst = Math.max(
    0,
    Math.min(
      themeIndex - themeVisibleCount + 1,
      names.length - themeVisibleCount,
    ),
  );
  const definition = providers.find((p) => p.id === values.provider);
  const endpoint = definition?.endpoint.normalization !== "none";
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
                label: "Ввести вручную...",
                hint: query || "Точное название модели",
              },
            ]
          : [];
  const choiceIndex = Math.min(selected, Math.max(0, choices.length - 1));
  const currentTheme = names[themeIndex] ?? savedTheme;
  const currentColors = catalog.palette(currentTheme);
  const selector =
    screen === "providers" || screen === "profiles" || screen === "model-list";
  const field =
    screen === "model-manual" ||
    screen === "key" ||
    screen === "base-url" ||
    screen === "profile-id";
  const fieldDirty =
    field &&
    editing !==
      (screen === "key"
        ? (values.apiKey ?? "")
        : screen === "base-url"
          ? (values.baseUrl ?? "")
          : screen === "profile-id"
            ? ""
            : values.model);
  const dirty =
    !!actions &&
    loaded &&
    (baseline.current !== JSON.stringify(values) || fieldDirty);
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
    if (page === "appearance" && names.length) onThemePreview?.(currentTheme);
  }, [page, currentTheme]);
  const close = (next?: () => void) => {
    if (
      lifetime.current.busy === "save" ||
      lifetime.current.busy === "theme" ||
      lifetime.current.busy === "permissions"
    )
      return;
    afterClose.current = next;
    if (
      dirty ||
      currentTheme !== savedTheme ||
      lspDirty ||
      webDirty ||
      subagentDirty ||
      backgroundDirty ||
      extensionsDirty ||
      mcpDirty
    ) {
      setCloseSelection(0);
      setConfirmClose(true);
      return;
    }
    cancelWork();
    onThemePreview?.(restore.current.theme);
    completeClose();
  };
  const changePage = (next: Page) => {
    if (
      lifetime.current.busy === "save" ||
      lifetime.current.busy === "theme" ||
      lifetime.current.busy === "permissions"
    )
      return;
    if (next === "connection" && !actions) return;
    if (lifetime.current.busy !== "load") cancelWork();
    setNavigationIndex(
      SETTINGS_SECTIONS.findIndex(
        (item) => item.id === (next === "web" ? "tools.web" : next),
      ),
    );
    setPage(next === "tools.web" ? "web" : next);
    setCompactDetail(true);
    setShellFocus("content");
    setFieldTarget(undefined);
    setNotice("");
  };
  const save = (draftValues = values) => {
    if (!actions || !loaded) return;
    run("save", async (valid) => {
      const next = {
        ...draftValues,
        model: draftValues.model.trim(),
        apiKey: draftValues.apiKey?.trim() || undefined,
        baseUrl: draftValues.baseUrl?.trim() || undefined,
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
      if (result === "saved") {
        const saved = { ...next, apiKey: undefined };
        setValues(saved);
        baseline.current = JSON.stringify(saved);
        setHasKey(true);
        setMessage("Подключение сохранено", "success");
        if (setup) completeClose("saved");
      } else setMessage("Добавьте API-ключ для выбранного сервиса", "error");
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
          result.startsWith(FAIL_MARK) ? "error" : "success",
        );
    });
  };
  const applyTheme = () => {
    const chosen = names[themeIndexRef.current];
    if (!chosen) return;
    run("theme", async (valid) => {
      await onThemeChange?.(chosen);
      if (!valid()) return;
      restore.current.theme = chosen;
      setSavedTheme(chosen);
      setMessage("Тема сохранена", "success");
    });
  };
  const toggleBypass = () => {
    if (!onBypassAvailabilityChange) return;
    const allowed = !bypassAllowed;
    run("permissions", async (valid) => {
      await onBypassAvailabilityChange(allowed);
      if (!valid()) return;
      setBypassAllowed(allowed);
      setMessage(
        allowed
          ? "Bypass доступен в выборе режимов; текущий режим сохранён"
          : "Bypass выключен; выбранные Bypass-сессии переведены в Manual",
        "success",
      );
    });
  };
  const open = (next: Screen) => {
    setCompactDetail(true);
    setShellFocus("content");
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
    return next;
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
  const saveCurrent = () => {
    if (page === "appearance") applyTheme();
    else if (page === "tools.lsp") lspControls.current?.save();
    else if (page === "tools.subagents") subagentControls.current?.save();
    else if (page === "tools.background") backgroundControls.current?.save();
    else if (page === "extensions") extensionsControls.current?.save();
    else if (page === "web") webControls.current?.save();
    else if (page === "tools.mcp") mcpControls.current?.save();
    else if (page === "connection") {
      if (field) {
        const next = acceptField();
        if (next) save(next);
      } else save();
    }
  };
  const selectRoute = (index: number) => {
    const item = catalogue[index];
    if (!item) return;
    setNavigationIndex(index);
    changePage(item.section.id);
    setSettingsQuery("");
    if (item.field) {
      if (item.section.id === "connection") open(item.field as Screen);
      else setFieldTarget(item.field);
    }
  };
  useUiKeyboard((key) => {
    if (!active) return;
    const name = key.name.toLowerCase();
    if (key.ctrl && name === "c") return;
    if (key.ctrl && name === "f") {
      key.preventDefault();
      setShellFocus("search");
      return;
    }
    if (confirmClose) {
      key.preventDefault();
      if (name === "escape") {
        afterClose.current = undefined;
        setConfirmClose(false);
      } else if (["up", "down", "tab"].includes(name))
        setCloseSelection(
          (i) => (i + (name === "up" || key.shift ? 2 : 1)) % 3,
        );
      else if (name === "return") {
        if (closeSelection === 0) {
          afterClose.current = undefined;
          setConfirmClose(false);
        } else if (closeSelection === 1) {
          afterClose.current = undefined;
          setConfirmClose(false);
          saveCurrent();
        } else {
          webControls.current?.discard();
          lspControls.current?.discard();
          subagentControls.current?.discard();
          backgroundControls.current?.discard();
          extensionsControls.current?.discard();
          mcpControls.current?.discard();
          onThemePreview?.(restore.current.theme);
          completeClose();
        }
      }
      return;
    }
    if (page === "appearance" && !navigationOnly) {
      if (name === "/" && !key.ctrl) {
        key.preventDefault();
        setShellFocus("content");
        setThemeSearchFocus(true);
        return;
      }
      if (themeSearchFocus) {
        if (["return", "escape", "down", "tab"].includes(name)) {
          key.preventDefault();
          setThemeSearchFocus(false);
          setShellFocus("content");
        }
        return;
      }
    }
    if (name === "tab") {
      key.preventDefault();
      const zones = navigationOnly
        ? (["search", "navigation"] as const)
        : split
          ? (["search", "navigation", "content", "actions"] as const)
          : compactDetail
            ? (["content", "actions", "search"] as const)
            : (["search", "navigation"] as const);
      const index = zones.indexOf(shellFocus as never);
      setShellFocus(
        zones[(index + (key.shift ? -1 : 1) + zones.length) % zones.length] ??
          "content",
      );
      return;
    }
    if (
      (shellFocus === "navigation" ||
        shellFocus === "search" ||
        (!split && !compactDetail)) &&
      !key.ctrl
    ) {
      if (name === "escape") {
        key.preventDefault();
        if (settingsQuery) {
          setSettingsQuery("");
          setNavigationIndex(0);
          setShellFocus(compactDetail ? "content" : "navigation");
        } else close();
      } else if (["up", "down", "pageup", "pagedown"].includes(name)) {
        key.preventDefault();
        const delta =
          name === "up" ? -1 : name === "down" ? 1 : name === "pageup" ? -6 : 6;
        setNavigationIndex((i) =>
          Math.max(0, Math.min(catalogue.length - 1, i + delta)),
        );
      } else if (name === "return") {
        key.preventDefault();
        selectRoute(navigationIndex);
      }
      return;
    }
    if (name === "f2" || (key.ctrl && name === "s")) {
      key.preventDefault();
      saveCurrent();
      return;
    }
    if (shellFocus === "actions" && name === "return") {
      key.preventDefault();
      if (page === "permissions") toggleBypass();
      else saveCurrent();
      return;
    }
    if (
      page === "tools.mcp" ||
      page === "tools.skills" ||
      page === "extensions" ||
      page === "tools.lsp" ||
      page === "tools.subagents" ||
      page === "tools.background"
    ) {
      if (name === "escape") {
        key.preventDefault();
        if (
          !(
            page === "tools.mcp"
              ? mcpControls.current
              : page === "tools.skills"
                ? skillsControls.current
                : page === "extensions"
                  ? extensionsControls.current
                  : page === "tools.background"
                    ? backgroundControls.current
                    : page === "tools.subagents"
                      ? subagentControls.current
                      : lspControls.current
          )?.back()
        ) {
          if (!split) {
            setCompactDetail(false);
            setShellFocus("navigation");
          } else close();
        }
      }
      return;
    }
    if (page === "web") {
      if (name === "escape") {
        key.preventDefault();
        if (!webControls.current?.back()) {
          if (!split) {
            setCompactDetail(false);
            setShellFocus("navigation");
          } else close();
        }
      }
      return;
    }
    if (name === "escape") {
      key.preventDefault();
      if (page === "connection" && screen !== "menu") back();
      else if (!split && compactDetail) {
        setCompactDetail(false);
        setShellFocus("navigation");
      } else close();
      return;
    }
    if (shellFocus === "actions") {
      if (name === "return") {
        key.preventDefault();
        saveCurrent();
      }
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
    if (key.ctrl && name === "r") {
      key.preventDefault();
      if (page === "connection") check();
      return;
    }
    if (page === "permissions") {
      if (name === "return" || name === "space") {
        key.preventDefault();
        toggleBypass();
      }
      return;
    }
    if (page === "appearance") {
      if (name === "/") {
        key.preventDefault();
        setThemeSearchFocus(true);
        return;
      }
      if (themeSearchFocus) {
        if (name === "return" || name === "escape" || name === "down") {
          key.preventDefault();
          setThemeSearchFocus(false);
        }
        return;
      }
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
              Math.max(1, names.length)) %
            Math.max(1, names.length),
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
  return (
    <OpenTuiDialog
      id="settings"
      width={width}
      height={height}
      palette={palette}
      onClose={close}
      maxHeight={30}
      maxWidth={104}
    >
      {!(tiny && compactDetail && shellFocus !== "search") && (
        <>
          <box
            height={1}
            flexShrink={0}
            flexDirection="row"
            justifyContent="space-between"
          >
            <text fg={palette.accent} height={1}>
              <strong>
                {terminalLine(
                  split || !compactDetail
                    ? "Настройки ChiselCode"
                    : `Настройки > ${section?.title ?? ""}`,
                  surfaceWidth - 7,
                )}
              </strong>
            </text>
            <DialogAction
              id="settings-close"
              label="Esc x"
              palette={palette}
              onSelect={close}
            />
          </box>
          <box height={1} flexShrink={0} backgroundColor={palette.raised}>
            <input
              id="settings-global-search"
              value={settingsQuery}
              focused={active && !confirmClose && shellFocus === "search"}
              placeholder="Поиск настроек · Ctrl+F"
              backgroundColor={palette.raised}
              focusedBackgroundColor={palette.raised}
              textColor={palette.text}
              focusedTextColor={palette.text}
              placeholderColor={palette.muted}
              onInput={(value) => {
                if (value === settingsQuery) return;
                setSettingsQuery(cleanSettingsInput(value));
                setNavigationIndex(0);
              }}
            />
          </box>
        </>
      )}
      <box
        flexDirection="row"
        height={contentHeight}
        flexShrink={0}
        width="100%"
        gap={split && !settingsQuery ? 1 : 0}
      >
        {showNavigation && (
          <SettingsNavigation
            results={catalogue}
            selected={navigationIndex}
            height={contentHeight}
            width={settingsQuery ? surfaceWidth : navigationWidth}
            separated={split && !settingsQuery}
            palette={palette}
            query={settingsQuery}
            focused={
              shellFocus === "navigation" ||
              shellFocus === "search" ||
              !compactDetail
            }
            onMove={setNavigationIndex}
            onSelect={selectRoute}
          />
        )}
        <box
          width={settingsQuery ? 0 : innerWidth}
          height="100%"
          flexDirection="column"
          visible={
            (split && !settingsQuery) || (compactDetail && !settingsQuery)
          }
        >
          {split && (
            <box height={2} flexShrink={0} flexDirection="column">
              <text fg={palette.accent} height={1}>
                <strong>
                  {terminalLine(
                    section?.group === section?.title
                      ? (section?.title ?? "")
                      : `${section?.group ?? ""} > ${section?.title ?? ""}`,
                    innerWidth,
                  )}
                </strong>
              </text>
              <text fg={palette.muted} height={1}>
                {terminalLine(section?.description ?? "", innerWidth)}
              </text>
            </box>
          )}
          <box
            height={
              page === "extensions" ||
              page === "tools.lsp" ||
              page === "tools.subagents" ||
              page === "tools.background" ||
              page === "web"
                ? 0
                : page === "tools.mcp" || page === "tools.skills"
                  ? 0
                  : bodyHeight
            }
            visible={
              page !== "extensions" &&
              page !== "tools.lsp" &&
              page !== "tools.subagents" &&
              page !== "tools.background" &&
              page !== "web" &&
              page !== "tools.mcp" &&
              page !== "tools.skills"
            }
            flexShrink={0}
            flexDirection="column"
            overflow="hidden"
          >
            {page === "tools.lsp" ? (
              actions?.lsp ? null : (
                <text fg={palette.muted}>
                  LSP недоступен в этой composition.
                </text>
              )
            ) : page === "web" && actions?.web ? null : page ===
              "permissions" ? (
              <TerminalScrollbox width="100%" height="100%">
                <box flexDirection="column" gap={roomy ? 1 : 0}>
                  <text height={1} fg={palette.accent}>
                    <strong>Доступ к Bypass</strong>
                  </text>
                  <DialogAction
                    id="settings-bypass-toggle"
                    label={`[${bypassAllowed ? "* Вкл" : "o Выкл"}] Разрешить Bypass`}
                    palette={palette}
                    active={bypassAllowed}
                    disabled={!!busy || !onBypassAvailabilityChange}
                    onSelect={toggleBypass}
                  />
                  <text fg={palette.text}>
                    Переключатель добавляет Bypass в меню разрешений и цикл F4.
                    Сам режим выбирается отдельно.
                  </text>
                  <text fg={palette.yellow}>
                    В Bypass правки и команды выполняются без подтверждения, с
                    правами процесса ChiselCode.
                  </text>
                  <text fg={palette.muted}>
                    Явные запреты, границы файловых инструментов и режим Plan
                    сохраняются. Это не песочница.
                  </text>
                  <text fg={palette.muted}>
                    Выключение возвращает Bypass-сессии и очередь в Manual;
                    следующие действия активного запроса снова проверяют
                    разрешения.
                  </text>
                  <text fg={palette.muted}>
                    Настройка принадлежит пользователю и сохраняется сразу.
                    Проект и скиллы не могут её включить.
                  </text>
                </box>
              </TerminalScrollbox>
            ) : page === "appearance" ? (
              <box flexDirection="column" height="100%" width="100%">
                <input
                  id="settings-theme-search"
                  value={themeSearch}
                  focused={active && themeSearchFocus && !confirmClose}
                  placeholder="Поиск тем /"
                  onMouseDown={() => {
                    setShellFocus("content");
                    setThemeSearchFocus(true);
                  }}
                  backgroundColor={palette.raised}
                  textColor={palette.text}
                  focusedTextColor={palette.text}
                  placeholderColor={palette.muted}
                  onInput={(value) => {
                    if (value === themeSearch) return;
                    setThemeSearch(cleanSettingsInput(value));
                    setThemeIndex(0);
                  }}
                />
                <box
                  flexDirection="row"
                  height={Math.max(1, bodyHeight - 2)}
                  width="100%"
                >
                  <box
                    width={wide ? listWidth : innerWidth}
                    height="100%"
                    flexDirection="column"
                  >
                    {names
                      .slice(themeFirst, themeFirst + themeVisibleCount)
                      .map((name) => {
                        const colors = catalog.palette(name);
                        const item = catalog.get(name)!;
                        const active = name === currentTheme;
                        return (
                          <box
                            id={`settings-theme-row-${name}`}
                            key={name}
                            height={rowHeight}
                            flexShrink={0}
                            flexDirection="column"
                            paddingLeft={1}
                            paddingRight={1}
                            backgroundColor={
                              active ? palette.raised : palette.surface
                            }
                          >
                            <box
                              height={1}
                              flexDirection="row"
                              justifyContent="space-between"
                            >
                              <DialogAction
                                id={`settings-theme-${name}`}
                                label={terminalLine(
                                  (active ? "> " : "  ") +
                                    colors.label +
                                    (name === savedTheme ? " +" : ""),
                                  Math.max(
                                    3,
                                    listWidth - (listWidth >= 30 ? 12 : 4),
                                  ),
                                )}
                                palette={palette}
                                active={active}
                                disabled={!!busy}
                                onSelect={() => {
                                  setThemeIndex(names.indexOf(name));
                                  setNotice("");
                                }}
                              />
                              {listWidth >= 30 && (
                                <text
                                  height={1}
                                  fg={colors.accent}
                                  selectable={false}
                                >
                                  <span bg={colors.bg}>{"  "}</span>{" "}
                                  <span bg={colors.surface}>{"  "}</span>{" "}
                                  <span bg={colors.accent}>{"  "}</span>
                                </text>
                              )}
                            </box>
                            {roomy && (
                              <text height={1} fg={palette.muted}>
                                {terminalLine(
                                  `${item.variant === "light" ? "Светлая" : "Тёмная"} · ${item.source}`,
                                  listWidth - 2,
                                )}
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
                        <strong>{currentColors.label}</strong>
                      </text>
                      <text fg={palette.muted}>
                        {currentColors.description}
                      </text>
                      <text
                        height={1}
                        flexShrink={0}
                        marginTop={1}
                        fg={palette.yellow}
                      >
                        Разрешения и предупреждения
                      </text>
                      <text height={1} flexShrink={0} fg={palette.red}>
                        Ошибки и остановка
                      </text>
                      <text height={1} flexShrink={0} fg={palette.green}>
                        Завершённые действия
                      </text>
                      <text marginTop={1} fg={palette.muted}>
                        Coder Mini и округлые рамки. Шрифт должен поддерживать
                        графические символы.
                      </text>
                      <text marginTop={1} fg={palette.muted}>
                        Стрелки показывают тему во всём интерфейсе. Примените
                        понравившийся вариант или нажмите Esc, чтобы вернуться.
                      </text>
                    </box>
                  )}
                  {!names.length && (
                    <text fg={palette.muted}>Темы не найдены</text>
                  )}
                </box>
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
                      active={
                        active &&
                        !confirmClose &&
                        shellFocus === "content" &&
                        page === "connection"
                      }
                    />
                  ) : (
                    <input
                      key={screen}
                      id="settings-field"
                      value={editing}
                      focused={
                        active &&
                        !confirmClose &&
                        shellFocus === "content" &&
                        page === "connection"
                      }
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
                      focused={
                        active &&
                        !confirmClose &&
                        shellFocus === "content" &&
                        page === "connection"
                      }
                      placeholder={`${labels[screen]} | поиск...`}
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
                <box
                  width="100%"
                  flexGrow={1}
                  minHeight={0}
                  flexDirection="row"
                >
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
                          ? "Загружаем подключение..."
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
                              if (event.button !== 0) return;
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
                              {terminalLine(
                                (first + offset === index ? "> " : "  ") +
                                  item.label +
                                  (!roomy && !selector
                                    ? `: ${safeValue(item.hint ?? "")}`
                                    : ""),
                                listWidth - 2,
                              )}
                            </text>
                            {roomy && (
                              <text height={1} fg={palette.muted}>
                                {terminalLine(
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
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Tab also focuses this native panel. */}
          <box
            width="100%"
            height={page === "tools.mcp" ? bodyHeight : 0}
            visible={page === "tools.mcp" && !navigationOnly}
            overflow="hidden"
            onMouseDown={() => setShellFocus("content")}
          >
            {mcp ? (
              <OpenTuiMcp
                actions={mcp}
                embedded
                width={innerWidth}
                height={bodyHeight}
                palette={palette}
                active={
                  active &&
                  page === "tools.mcp" &&
                  !navigationOnly &&
                  !confirmClose
                }
                focused={shellFocus === "content"}
                controls={mcpControls}
                onDirty={recordMcpDirty}
                onClose={() => {
                  setCompactDetail(false);
                  setShellFocus("navigation");
                }}
              />
            ) : (
              <text fg={palette.muted}>
                {getMcpActions
                  ? "Загружаем подключения…"
                  : "MCP недоступен в текущем приложении."}
              </text>
            )}
          </box>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Tab also focuses this native panel. */}
          <box
            width="100%"
            height={page === "tools.skills" ? bodyHeight : 0}
            visible={page === "tools.skills" && !navigationOnly}
            overflow="hidden"
            onMouseDown={() => setShellFocus("content")}
          >
            {skillsVisited && skillsActions ? (
              <OpenTuiSkills
                actions={skillsActions}
                embedded
                width={innerWidth}
                height={bodyHeight}
                palette={palette}
                active={
                  active &&
                  page === "tools.skills" &&
                  !navigationOnly &&
                  !confirmClose
                }
                focused={shellFocus === "content"}
                controls={skillsControls}
                onClose={() => {
                  setCompactDetail(false);
                  setShellFocus("navigation");
                }}
                onChoose={
                  onChooseSkill
                    ? (skill) => close(() => onChooseSkill(skill))
                    : undefined
                }
                onCreate={
                  onCreateSkill ? () => close(onCreateSkill) : undefined
                }
                onEdit={
                  onEditSkill
                    ? (skill) => close(() => onEditSkill(skill))
                    : undefined
                }
              />
            ) : (
              <text fg={palette.muted}>
                Навыки недоступны в текущем приложении.
              </text>
            )}
          </box>
          {actions?.extensions && (
            <box
              width="100%"
              height={page === "extensions" ? bodyHeight : 0}
              visible={page === "extensions" && !navigationOnly}
            >
              <OpenTuiExtensions
                management={actions.extensions}
                root={actions.workspaceRoot}
                palette={palette}
                width={innerWidth}
                height={bodyHeight}
                active={
                  active &&
                  page === "extensions" &&
                  !navigationOnly &&
                  !confirmClose
                }
                focused={shellFocus === "content"}
                controls={extensionsControls}
                onOpenBuiltin={changePage}
                onDirty={recordExtensionsDirty}
                onFocus={() => setShellFocus("content")}
              />
            </box>
          )}
          {actions?.web && (
            <box
              height={page === "web" ? bodyHeight : 0}
              visible={page === "web"}
              overflow="hidden"
              flexShrink={0}
            >
              <OpenTuiWebSettings
                actions={actions.web}
                height={bodyHeight}
                palette={palette}
                active={
                  active &&
                  page === "web" &&
                  !navigationOnly &&
                  shellFocus === "content" &&
                  !confirmClose
                }
                controls={webControls}
                onDirty={recordWebDirty}
                onClose={() => {}}
              />
            </box>
          )}
          {actions?.background && (
            <box
              width="100%"
              height={page === "tools.background" ? bodyHeight : 0}
              visible={page === "tools.background" && !navigationOnly}
            >
              <OpenTuiBackgroundSettings
                actions={actions.background}
                palette={palette}
                width={innerWidth}
                height={bodyHeight}
                active={
                  active &&
                  page === "tools.background" &&
                  !navigationOnly &&
                  !confirmClose
                }
                focused={shellFocus === "content"}
                controls={backgroundControls}
                onDirty={recordBackgroundDirty}
              />
            </box>
          )}
          {actions?.subagents && (
            <box
              width="100%"
              height={page === "tools.subagents" ? bodyHeight : 0}
              visible={page === "tools.subagents" && !navigationOnly}
            >
              <OpenTuiSubagentSettings
                actions={actions.subagents}
                palette={palette}
                width={innerWidth}
                height={bodyHeight}
                active={
                  active &&
                  page === "tools.subagents" &&
                  !navigationOnly &&
                  !confirmClose
                }
                focused={shellFocus === "content"}
                controls={subagentControls}
                onDirty={recordSubagentDirty}
              />
            </box>
          )}
          {actions?.lsp && (
            <box
              width="100%"
              height={page === "tools.lsp" ? bodyHeight : 0}
              visible={
                page === "tools.lsp" &&
                ((split && !settingsQuery) || (compactDetail && !settingsQuery))
              }
            >
              <OpenTuiLspSettings
                actions={actions.lsp}
                palette={palette}
                width={innerWidth}
                height={bodyHeight}
                active={
                  active &&
                  page === "tools.lsp" &&
                  !navigationOnly &&
                  !confirmClose
                }
                focused={shellFocus === "content"}
                fieldTarget={fieldTarget}
                onFieldTargetHandled={() => setFieldTarget(undefined)}
                controls={lspControls}
                onDirty={recordLspDirty}
              />
            </box>
          )}
        </box>
      </box>
      {confirmClose && (
        <box
          position="absolute"
          left={1}
          top={1}
          width="100%"
          height={Math.max(1, popupHeight - (tiny ? 1 : 2))}
          backgroundColor={palette.surface}
          flexDirection="column"
        >
          <text height={1} fg={palette.yellow}>
            {tiny ? "Есть изменения" : "Несохранённые изменения"}
          </text>
          <DialogAction
            id="settings-stay"
            active={closeSelection === 0}
            label={tiny ? "Остаться" : "Остаться (Esc)"}
            palette={palette}
            onSelect={() => {
              afterClose.current = undefined;
              setConfirmClose(false);
            }}
          />
          <DialogAction
            id="settings-save-current"
            active={closeSelection === 1}
            label={tiny ? "Сохранить текущую" : "Сохранить текущую форму"}
            palette={palette}
            onSelect={() => {
              afterClose.current = undefined;
              setConfirmClose(false);
              saveCurrent();
            }}
          />
          <DialogAction
            id="settings-discard"
            active={closeSelection === 2}
            label={tiny ? "Сбросить всё" : "Сбросить все изменения и закрыть"}
            palette={palette}
            onSelect={() => {
              webControls.current?.discard();
              lspControls.current?.discard();
              subagentControls.current?.discard();
              backgroundControls.current?.discard();
              extensionsControls.current?.discard();
              mcpControls.current?.discard();
              onThemePreview?.(restore.current.theme);
              completeClose();
            }}
          />
        </box>
      )}
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
          {terminalLine(safeValue(notice), innerWidth)}
        </text>
      )}
      <box height={1} flexShrink={0} flexDirection="row" gap={1}>
        {simpleFooter ? (
          <text fg={palette.muted}>
            {terminalLine(
              navigationOnly
                ? surfaceWidth < 28
                  ? "Enter | Esc назад"
                  : surfaceWidth < 55
                    ? "Enter открыть | Ctrl+F | Esc назад"
                    : "Enter открыть | Tab фокус | Ctrl+F поиск | Esc назад"
                : page === "extensions"
                  ? "Tab фокус | Ctrl+F разделы | Esc назад"
                  : page === "tools.skills"
                    ? "Tab фокус | Alt+1/2 вкладки | Ctrl+O текст | Esc назад"
                    : page === "tools.mcp"
                      ? "Tab фокус | Ctrl+R проверка | Ctrl+S сохранить | Esc назад"
                      : tiny
                        ? "F2 сохр | Esc назад"
                        : surfaceWidth < 55
                          ? "F2 сохранить | Esc назад"
                          : "Ctrl+F поиск | Tab фокус | Ctrl+S/F2 сохранить | Esc назад",
              surfaceWidth,
            )}
          </text>
        ) : page === "web" ? (
          <text fg={palette.muted}>
            {terminalLine("Ctrl+S/F2 сохранить Web | Esc назад", surfaceWidth)}
          </text>
        ) : page === "permissions" ? (
          <DialogAction
            id="settings-bypass-action"
            label={
              busy === "permissions"
                ? "Сохраняем..."
                : bypassAllowed
                  ? "Выключить Bypass"
                  : "Включить Bypass"
            }
            palette={palette}
            disabled={!!busy || !onBypassAvailabilityChange}
            onSelect={toggleBypass}
          />
        ) : page === "appearance" ? (
          <>
            <DialogAction
              id="settings-apply-theme"
              label={
                busy === "theme"
                  ? "Сохраняем..."
                  : tiny
                    ? "Применить"
                    : "Применить тему"
              }
              primary
              palette={palette}
              disabled={!!busy}
              onSelect={applyTheme}
            />
            <DialogAction
              id="settings-cancel-theme"
              label={surfaceWidth < 55 ? "Отмена" : "Отменить предпросмотр"}
              palette={palette}
              disabled={!!busy}
              onSelect={() => {
                setThemeSearch("");
                setThemeSearchFocus(false);
                setThemeIndex(
                  Math.max(
                    0,
                    catalog
                      .list()
                      .findIndex((item) => item.key === restore.current.theme),
                  ),
                );
                onThemePreview?.(restore.current.theme);
                setNotice("");
              }}
            />
          </>
        ) : field || selector ? (
          <>
            <DialogAction
              id="settings-back"
              label="< Назад"
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
                  ? "Проверяем..."
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
              label={busy === "save" ? "Сохраняем..." : "Сохранить"}
              primary
              palette={palette}
              disabled={!!busy || !loaded}
              onSelect={save}
            />
          </>
        )}
      </box>
      {showHint && (
        <text height={1} fg={palette.muted}>
          {terminalSafeText(
            page !== "web" && busy
              ? busy === "models"
                ? "Загружаем модели... | Esc назад"
                : busy === "check"
                  ? "Проверяем подключение... | Esc закрыть"
                  : "Подождите..."
              : "Ctrl+F поиск | Tab фокус | Ctrl+S/F2 сохранить | Esc назад",
            innerWidth,
          )}
        </text>
      )}
    </OpenTuiDialog>
  );
}
