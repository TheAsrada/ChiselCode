/** @jsxImportSource @opentui/react */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundSettingsActions } from "../background/settings.js";
import { ProfileIdSchema } from "../config/schema.js";
import type { ExtensionManagementService } from "../extensions/management.js";
import type { LspSettingsActions } from "../lsp/settings.js";
import type { OpenTuiMcpActions } from "../mcp/controller.js";
import type {
  ConnectionChallenge,
  ConnectionStatus,
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
import {
  type MenuAction,
  MenuActions,
  useMenuNavigation,
} from "./menu-navigation.js";
import { OpenTuiBackgroundSettings } from "./opentui-background-settings.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { OpenTuiExtensions } from "./opentui-extensions.js";
import { OpenTuiLspSettings } from "./opentui-lsp-settings.js";
import { OpenTuiMcp } from "./opentui-mcp.js";
import { useMotion } from "./opentui-motion.js";
import {
  cleanSettingsInput,
  SettingsSecretInput,
} from "./opentui-settings-input.js";
import { OpenTuiSkills, type OpenTuiSkillsActions } from "./opentui-skills.js";
import { OpenTuiSubagentSettings } from "./opentui-subagent-settings.js";
import { terminalSafeText } from "./opentui-transcript.js";
import { OpenTuiWebSettings } from "./opentui-web-settings.js";
import { useUiKeyboard } from "./overlay-input.js";
import { useSettingsAutosave } from "./settings-autosave.js";
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
  load(profileId?: string): Promise<{
    values: TuiSettingsValues;
    hasKey: boolean;
    accountLabel?: string;
  }>;
  hasKey(provider: ProviderId, profileId?: string): Promise<boolean>;
  save(
    values: TuiSettingsValues,
    previous?: TuiSettingsValues,
  ): Promise<"saved" | "setup_required">;
  activate?(values: TuiSettingsValues): Promise<void>;
  check(values: TuiSettingsValues): Promise<string>;
  models(values: TuiSettingsValues): Promise<ModelListResult>;
  connect?(
    values: TuiSettingsValues,
    signal: AbortSignal,
    challenge: (value: ConnectionChallenge) => void,
  ): Promise<ConnectionStatus>;
  disconnect?(values: TuiSettingsValues): Promise<void>;
  removeProfile?(profileId: string, expected?: ProviderProfile): Promise<void>;
}

type Screen =
  | "menu"
  | "providers"
  | "profiles"
  | "model-list"
  | "model-manual"
  | "key"
  | "base-url"
  | "profile-id"
  | "profile-label"
  | "login"
  | "disconnect"
  | "delete-profile";
type Page = SettingsRoute | "web";
type Work =
  | "load"
  | "models"
  | "check"
  | "save"
  | "profile"
  | "theme"
  | "permissions"
  | "login"
  | "remove";
const labels: Record<Screen, string> = {
  menu: "Подключение",
  providers: "Выберите сервис",
  profiles: "Выберите профиль",
  "model-list": "Выберите модель",
  "model-manual": "Название модели",
  key: "API-ключ",
  "base-url": "Адрес API",
  "profile-id": "Новый профиль",
  "profile-label": "Название профиля",
  login: "Вход в аккаунт",
  disconnect: "Отключить аккаунт",
  "delete-profile": "Удалить профиль",
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
  onChooseProject,
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
  onChooseProject?(): void;
}) {
  const motion = useMotion();
  const changeMotion = () => {
    void motion
      .change?.(motion.preference === "full" ? "reduced" : "full")
      .catch(
        (error: unknown) =>
          lifetime.current.mounted &&
          setMessage(
            `Не удалось сохранить анимации: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          ),
      );
  };
  const [values, setValues] = useState<TuiSettingsValues>({
    provider: "",
    model: "",
  });
  const [providers, setProviders] = useState<ProviderDefinition[]>(() =>
    createBuiltinProviderRegistry().list(),
  );
  const [profiles, setProfiles] = useState<Record<string, ProviderProfile>>({});
  const [hasKey, setHasKeyState] = useState(false);
  const readiness = useRef(false);
  const setHasKey = (ready: boolean) => {
    readiness.current = ready;
    setHasKeyState(ready);
  };
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
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const completeClose = (outcome?: "saved") => {
    const next = afterClose.current;
    afterClose.current = undefined;
    onClose(outcome);
    next?.();
  };
  const recordDirty = useCallback((_dirty: boolean) => {}, []);
  const [mcp, setMcp] = useState<OpenTuiMcpActions>();
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
  const extensionsControls = useRef<SettingsPanelControl | undefined>(
    undefined,
  );
  const backgroundControls = useRef<SettingsPanelControl | undefined>(
    undefined,
  );
  const subagentControls = useRef<SettingsPanelControl | undefined>(undefined);
  const webControls = useRef<SettingsPanelControl | undefined>(undefined);

  const lspControls = useRef<SettingsPanelControl | undefined>(undefined);
  const authAbort = useRef<AbortController | undefined>(undefined);
  const [challenge, setChallenge] = useState<ConnectionChallenge>();
  const [accountLabel, setAccountLabel] = useState<string>();
  const [connectionConfirm, setConnectionConfirm] = useState<{
    type: "delete" | "disconnect";
    profileId: string;
  }>();
  const [connectionChoice, setConnectionChoice] = useState(0);
  const [addingProfile, setAddingProfile] = useState(false);
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
  const [chosenTheme, setChosenTheme] = useState(theme);
  const [savedBypass, setSavedBypass] = useState(allowBypassPermissions);
  const [bypassAllowed, setBypassAllowed] = useState(allowBypassPermissions);
  const lifetime = useRef({
    mounted: true,
    operation: 0,
    busy: undefined as Work | undefined,
  });
  const baseline = useRef("");
  const editorEpoch = useRef(0);
  const acknowledged = useRef<TuiSettingsValues | undefined>(undefined);
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
  const showHint = popupHeight >= 8 && !simpleFooter;
  const contentHeight = Math.max(
    1,
    popupHeight -
      (tiny ? 0 : 2) -
      (roomy ? 2 : 0) -
      (tiny && compactDetail && shellFocus !== "search" ? 0 : 2) -
      (showHint ? 2 : 1) -
      (notice ? 1 : 0),
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
        (wide && page === "connection" && screen !== "profiles" ? 3 : 0) -
        1 -
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
    Math.floor(
      Math.max(
        1,
        bodyHeight - (roomy ? 3 : height >= 12 || themeSearchFocus ? 1 : 0),
      ) / rowHeight,
    ),
  );
  const themeFirst = Math.max(
    0,
    Math.min(
      themeIndex - themeVisibleCount + 1,
      names.length - themeVisibleCount,
    ),
  );
  const definition = providers.find((p) => p.id === values.provider);
  const subscription = definition?.auth.type === "subscription";
  const endpoint =
    !subscription && definition?.endpoint.normalization !== "none";
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
      help: "Сервис этого профиля. Для другого сервиса добавьте подключение.",
    },
    {
      screen: "model-list",
      label: "Модель",
      value: values.model || "Не выбрана",
      help: "Выберите доступную модель или введите точный ID.",
    },
    {
      screen: subscription ? "login" : "key",
      label: subscription ? "Аккаунт" : "API-ключ",
      value: subscription
        ? hasKey
          ? (accountLabel ?? "Подключён")
          : "Войти по коду"
        : values.apiKey
          ? "Новый ключ"
          : hasKey
            ? "Сохранён"
            : definition?.auth.required === false
              ? "Не требуется"
              : "Не настроен",
      help: subscription
        ? "Войдите через браузер по одноразовому коду."
        : "Ключ скрыт при вводе. Новый ключ заменит текущий только после сохранения. Пустое поле оставляет сохранённый ключ.",
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
      help: "Все сохранённые аккаунты и подключения.",
    },
    {
      screen: "profile-id",
      label: "Добавить подключение",
      value: "Добавить аккаунт",
      help: "Выберите сервис и задайте имя нового профиля.",
    },
    {
      screen: "profile-label",
      label: "Название",
      value: values.label || values.profileId || "Без названия",
      help: "Отображаемое название аккаунта. ID профиля сохраняется.",
    },
    ...(subscription && hasKey && actions?.disconnect
      ? [
          {
            screen: "disconnect" as const,
            label: "Отключить аккаунт",
            value: "Удалить сохранённый вход",
            help: "Вход будет удалён только из этого профиля.",
          },
        ]
      : []),
    ...(values.profileId && profiles[values.profileId] && actions?.removeProfile
      ? [
          {
            screen: "delete-profile" as const,
            label: "Удалить профиль",
            value: values.label || values.profileId,
            help: "Профиль и его сохранённый вход будут удалены.",
          },
        ]
      : []),
  ];
  const menuIndex = Math.min(selected, rows.length - 1);
  const filteredProviders = providers.filter((p) =>
    `${p.id} ${p.label} ${p.description ?? ""}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const filteredProfiles = Object.entries(profiles).filter(([id, p]) =>
    `${id} ${p.label ?? ""} ${p.providerId} ${providers.find((provider) => provider.id === p.providerId)?.label ?? ""}`
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
        ? [
            ...filteredProfiles.map(([id, p]) => ({
              id,
              label: `${id === values.profileId ? "● " : ""}${p.label ?? id}`,
              hint: `${providers.find((provider) => provider.id === p.providerId)?.label ?? p.providerId} · ${p.defaultModel ?? "модель не выбрана"}`,
            })),
            {
              id: "__new-profile",
              label: "Добавить подключение",
              hint: "API или подписка",
            },
          ]
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
    screen === "profile-id" ||
    screen === "profile-label";
  const fieldDirty =
    field &&
    editing !==
      (screen === "key"
        ? (values.apiKey ?? "")
        : screen === "base-url"
          ? (values.baseUrl ?? "")
          : screen === "profile-label"
            ? (values.label ?? "")
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
    authAbort.current?.abort();
    authAbort.current = undefined;
    setChallenge(undefined);
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
      acknowledged.current = draft.values;
      setHasKey(draft.hasKey);
      setAccountLabel(draft.accountLabel);
      setLoaded(true);
      setScreen("profiles");
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Load once for each actions object; previews must not reload connection drafts.
  useEffect(() => {
    lifetime.current.mounted = true;
    load();
    return () => {
      authAbort.current?.abort();
      lifetime.current.mounted = false;
      ++lifetime.current.operation;
      restore.current.preview?.(restore.current.theme);
    };
  }, [actions]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Preview follows selection, not the callback identity.
  useEffect(() => {
    if (page === "appearance" && names.length) onThemePreview?.(currentTheme);
  }, [page, currentTheme]);
  const flushPanels = async () => {
    if (!(await connectionAutosave.flush())) return false;
    if (!(await themeAutosave.flush()) || !(await bypassAutosave.flush()))
      return false;
    for (const control of [
      webControls,
      lspControls,
      subagentControls,
      backgroundControls,
      extensionsControls,
      mcpControls,
    ]) {
      if (control.current?.flush && !(await control.current.flush()))
        return false;
    }
    return true;
  };
  const close = (next?: () => void) => {
    void (async () => {
      if (!(await flushPanels())) return;
      afterClose.current = next;
      cancelWork();
      completeClose();
    })();
  };
  const changePage = (next: Page) => {
    void (async () => {
      if (!(await flushPanels())) return;
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
    })();
  };
  const fieldValues = () =>
    field && screen !== "profile-id"
      ? {
          ...values,
          [screen === "profile-label"
            ? "label"
            : screen === "key"
              ? "apiKey"
              : screen === "base-url"
                ? "baseUrl"
                : "model"]: editing,
        }
      : values;
  const pendingValues = fieldDirty ? fieldValues() : values;
  const connectionAutosave = useSettingsAutosave(
    loaded &&
      values.profileId &&
      !addingProfile &&
      baseline.current !== JSON.stringify(pendingValues)
      ? JSON.stringify(pendingValues)
      : undefined,
    async () => {
      if (!actions) return;
      const next = {
        ...pendingValues,
        model: pendingValues.model.trim(),
        apiKey: pendingValues.apiKey?.trim() || undefined,
        baseUrl: pendingValues.baseUrl?.trim() || undefined,
      };
      if (!next.model) throw new Error("Введите название модели");
      if (next.baseUrl) {
        const url = new URL(next.baseUrl);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("Адрес API должен начинаться с http:// или https://");
      }
      setMessage("Сохранение…");
      const result = await actions.save(
        next,
        next.profileId && profiles[next.profileId]
          ? acknowledged.current
          : undefined,
      );
      const saved = { ...next, apiKey: undefined };
      baseline.current = JSON.stringify(saved);
      acknowledged.current = saved;
      // A delayed response only acknowledges its snapshot, never newer typing.
      setValues((current) =>
        JSON.stringify(current) === JSON.stringify(values) ? saved : current,
      );
      setHasKey(result === "saved");
      const catalog = await actions.catalog?.();
      if (catalog) setProfiles(catalog.profiles);
      setMessage(
        result === "saved"
          ? "Сохранено · готово к работе"
          : "Сохранено · требуется настройка / авторизация",
        result === "saved" ? "success" : "info",
      );
    },
    (error) =>
      setMessage(
        safeNotice(error, pendingValues, editing, screen === "key"),
        "error",
      ),
    field ? 350 : 0,
    loaded && values.profileId && !addingProfile
      ? JSON.stringify(pendingValues)
      : undefined,
  );
  const save = (_draftValues = values, after?: () => void) => {
    void connectionAutosave.flush().then((ok) => {
      if (ok) after?.();
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
  const themeAutosave = useSettingsAutosave(
    chosenTheme !== savedTheme ? chosenTheme : undefined,
    async () => {
      await onThemeChange?.(chosenTheme);
      restore.current.theme = chosenTheme;
      setSavedTheme(chosenTheme);
      setMessage("Тема сохранена", "success");
    },
    (error) =>
      setMessage(
        String(error instanceof Error ? error.message : error),
        "error",
      ),
    0,
    chosenTheme,
  );
  const applyTheme = () => {
    const chosen = names[themeIndexRef.current];
    if (chosen) setChosenTheme(chosen);
  };
  const bypassAutosave = useSettingsAutosave(
    bypassAllowed !== savedBypass ? String(bypassAllowed) : undefined,
    async () => {
      await onBypassAvailabilityChange?.(bypassAllowed);
      setSavedBypass(bypassAllowed);
      setMessage("Настройка разрешений сохранена", "success");
    },
    (error) =>
      setMessage(
        String(error instanceof Error ? error.message : error),
        "error",
      ),
    0,
    String(bypassAllowed),
  );
  const toggleBypass = () => {
    if (onBypassAvailabilityChange) setBypassAllowed((value) => !value);
  };
  const login = () => {
    if (!actions?.connect || !values.profileId) {
      setMessage("Сначала создайте профиль", "error");
      return;
    }
    const abort = new AbortController();
    authAbort.current?.abort();
    authAbort.current = abort;
    setScreen("login");
    setChallenge(undefined);
    run("login", async (valid) => {
      const status = await actions.connect!(values, abort.signal, (next) => {
        if (valid()) setChallenge(next);
      });
      if (!valid()) return;
      setHasKey(status.connected);
      setAccountLabel(status.label);
      setChallenge(undefined);
      const result = await actions.models(values);
      if (!valid()) return;
      setModels(result.ok ? result.models : []);
      setScreen("model-list");
      setSelected(0);
      setQuery("");
      setMessage(
        result.ok ? "Аккаунт подключён · выберите модель" : result.error,
        result.ok ? "success" : "error",
      );
    });
  };
  const switchProfile = (profileId: string) => {
    if (!actions) return;
    run("profile", async (valid) => {
      const loaded = await actions.load(profileId);
      if (!valid()) return;
      setValues(loaded.values);
      setAddingProfile(false);
      baseline.current = JSON.stringify(loaded.values);
      acknowledged.current = loaded.values;
      setHasKey(loaded.hasKey);
      setAccountLabel(loaded.accountLabel);
      setScreen("menu");
      setSelected(0);
      setQuery("");
      setNotice("");
    });
  };
  const newProfile = (discard = false) => {
    if (lifetime.current.busy || !loaded) return;
    if (!discard) {
      void connectionAutosave.flush().then((ok) => {
        if (ok) newProfile(true);
      });
      return;
    }
    setAddingProfile(true);
    setScreen("providers");
    setQuery("");
    setSelected(0);
  };
  const open = (next: Screen) => {
    setCompactDetail(true);
    setShellFocus("content");
    if (lifetime.current.busy || !loaded || connectionConfirm) return;
    setNotice("");
    setQuery("");
    setSelected(0);
    if (
      !values.profileId &&
      !addingProfile &&
      next !== "profiles" &&
      next !== "profile-id"
    ) {
      setScreen("profiles");
      setMessage("Нет подключений · выберите «Добавить подключение»");
      return;
    }
    if (next === "disconnect" || next === "delete-profile") {
      void connectionAutosave.flush().then((ok) => {
        if (ok && values.profileId) {
          setConnectionConfirm({
            type: next === "disconnect" ? "disconnect" : "delete",
            profileId: values.profileId,
          });
          setConnectionChoice(0);
        }
      });
      return;
    }
    if (next === "providers" && !addingProfile) {
      newProfile();
      return;
    }
    if (next === "login") {
      login();
      return;
    }
    if (next === "profile-id") {
      newProfile();
      return;
    }
    ++editorEpoch.current;
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
        : next === "profile-label"
          ? (values.label ?? "")
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
  const back = (accepted = false) => {
    if (field && !accepted) {
      if (screen === "profile-id") {
        setScreen("profiles");
        setAddingProfile(false);
        if (acknowledged.current) setValues(acknowledged.current);
        return;
      }
      const epoch = editorEpoch.current;
      void connectionAutosave.flush().then((ok) => {
        if (ok && epoch === editorEpoch.current) {
          setValues((current) => ({ ...current, apiKey: undefined }));
          back(true);
        }
      });
      return;
    }
    if (lifetime.current.busy === "save" || lifetime.current.busy === "theme")
      return;
    ++editorEpoch.current;
    cancelWork();
    setAddingProfile(false);
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
    if (screen !== "profile-id") {
      back();
      return;
    }
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
      next = { ...values, profileId: id, label: undefined, apiKey: undefined };
      setAddingProfile(false);
      setHasKey(false);
    } else
      next = {
        ...values,
        [screen === "profile-label"
          ? "label"
          : screen === "key"
            ? "apiKey"
            : screen === "base-url"
              ? "baseUrl"
              : "model"]: editing,
      };
    setValues(next);
    back(true);
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
      if (picked.id === "__new-profile") {
        newProfile();
        return;
      }
      if (picked.id === values.profileId) {
        back();
        return;
      }
      void connectionAutosave.flush().then((ok) => {
        if (ok) switchProfile(picked.id);
      });
    } else {
      const provider = filteredProviders[index];
      if (!provider) return;
      if (addingProfile) {
        setValues({
          provider: provider.id,
          model: provider.defaults.model ?? "",
          baseUrl:
            provider.auth.type !== "subscription" &&
            provider.endpoint.normalization !== "none"
              ? provider.endpoint.defaultBaseUrl
              : undefined,
        });
        setHasKey(false);
        setEditing("");
        setScreen("profile-id");
        setNotice("");
        return;
      }
      if (provider.id === values.provider) {
        back();
        return;
      }
      back();
    }
  };
  const saveCurrent = () => {
    if (page === "appearance") void themeAutosave.flush();
    else if (page === "permissions") void bypassAutosave.flush();
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
  const settingsMenuActions: MenuAction[] =
    page === "tools.skills"
      ? [{ id: "settings-close", label: "Закрыть настройки", run: close }]
      : page === "appearance"
        ? [
            {
              id: "settings-motion-action",
              label: `Анимации: ${motion.preference === "full" ? "плавные" : "минимум"}`,
              disabled: !!busy,
              run: changeMotion,
            },
          ]
        : page === "permissions"
          ? [
              {
                id: "settings-bypass-action",
                label: bypassAllowed ? "Выключить Bypass" : "Включить Bypass",
                disabled: !!busy || !onBypassAvailabilityChange,
                run: toggleBypass,
              },
            ]
          : page === "connection" && (field || selector || screen === "login")
            ? [
                ...(noticeKind === "error" && values.profileId
                  ? [
                      {
                        id: "settings-reload-field",
                        label: "Обновить данные",
                        run: () => {
                          void actions
                            ?.load(values.profileId)
                            .then((draft) => {
                              acknowledged.current = draft.values;
                              baseline.current = JSON.stringify(draft.values);
                              setMessage(
                                "Данные обновлены; ввод сохранён. Повторите выход из поля.",
                              );
                            })
                            .catch((error) =>
                              setMessage(
                                safeNotice(
                                  error,
                                  values,
                                  editing,
                                  screen === "key",
                                ),
                                "error",
                              ),
                            );
                        },
                      },
                    ]
                  : []),
                {
                  id: "settings-back",
                  label: "Назад",
                  disabled: busy === "save",
                  run: back,
                },
                ...(screen === "login"
                  ? []
                  : [
                      {
                        id: "settings-confirm",
                        label: field ? "Подтвердить" : "Выбрать",
                        disabled:
                          !!busy &&
                          !(
                            busy === "models" &&
                            choices[
                              Math.min(
                                selected,
                                Math.max(0, choices.length - 1),
                              )
                            ]?.id === "__manual"
                          ),
                        run: () => {
                          if (field) acceptField();
                          else choose();
                        },
                      },
                    ]),
              ]
            : [
                ...(page === "connection"
                  ? [
                      ...(subscription
                        ? [
                            {
                              id: "settings-login",
                              label: hasKey
                                ? "Войти заново"
                                : `Войти в ${definition?.label ?? "аккаунт"}`,
                              disabled: !!busy,
                              run: login,
                            },
                          ]
                        : []),
                      {
                        id: "settings-check",
                        label: "Проверить подключение",
                        shortLabel: "Проверить",
                        disabled: !!busy,
                        run: check,
                      },
                    ]
                  : []),
                ...(page === "connection" &&
                values.profileId &&
                profiles[values.profileId]
                  ? [
                      {
                        id: "settings-use-profile",
                        label: "Использовать подключение",
                        disabled: !!busy,
                        run: () => {
                          void connectionAutosave.flush().then(async (ok) => {
                            if (!ok) return;
                            try {
                              await actions?.activate?.(values);
                              if (setup && readiness.current)
                                completeClose("saved");
                              else
                                setMessage(
                                  readiness.current
                                    ? "Подключение выбрано"
                                    : "Подключение выбрано · требуется настройка",
                                  "success",
                                );
                            } catch (error) {
                              setMessage(
                                safeNotice(
                                  error,
                                  values,
                                  editing,
                                  screen === "key",
                                ),
                                "error",
                              );
                            }
                          });
                        },
                      },
                    ]
                  : []),
                ...(noticeKind === "error"
                  ? [
                      {
                        id: "settings-retry",
                        label: "Повторить",
                        run: saveCurrent,
                      },
                      {
                        id: "settings-reload",
                        label: "Обновить данные",
                        run: () => {
                          void actions
                            ?.load(values.profileId)
                            .then((draft) => {
                              acknowledged.current = draft.values;
                              baseline.current = JSON.stringify(draft.values);
                              setMessage(
                                "Данные обновлены; введённые значения сохранены. Повторите запись.",
                              );
                            })
                            .catch((error) =>
                              setMessage(
                                safeNotice(
                                  error,
                                  values,
                                  editing,
                                  screen === "key",
                                ),
                                "error",
                              ),
                            );
                        },
                      },
                    ]
                  : []),
              ];
  if (
    noticeKind === "error" &&
    !settingsMenuActions.some((item) => item.id === "settings-retry")
  )
    settingsMenuActions.push({
      id: "settings-retry",
      label: "Повторить",
      run: saveCurrent,
    });
  if (page === "connection" && screen !== "profiles")
    settingsMenuActions.push({
      id: "settings-profiles-action",
      label: "Подключения",
      run: () => {
        void connectionAutosave.flush().then((ok) => {
          if (ok) {
            setScreen("profiles");
            setSelected(0);
            setQuery("");
          }
        });
      },
    });
  const actionNavigation = useMenuNavigation(
    ["actions"],
    settingsMenuActions,
    "actions",
  );
  const confirmConnection = (choice: number) => {
    const pending = connectionConfirm;
    if (!pending || !choice) {
      setConnectionConfirm(undefined);
      return;
    }
    setConnectionConfirm(undefined);
    run("remove", async (valid) => {
      if (pending.type === "disconnect") await actions?.disconnect?.(values);
      else
        await actions?.removeProfile?.(
          pending.profileId,
          profiles[pending.profileId],
        );
      if (!valid()) return;
      if (pending.type === "disconnect") {
        setHasKey(false);
        setAccountLabel(undefined);
        setMessage("Аккаунт отключён");
      } else {
        const catalog = await actions?.catalog?.();
        const draft = await actions?.load();
        if (!valid()) return;
        if (catalog) setProfiles(catalog.profiles);
        if (draft) {
          setValues(draft.values);
          baseline.current = JSON.stringify(draft.values);
          acknowledged.current = draft.values;
          setHasKey(draft.hasKey);
        }
        setScreen("profiles");
        setSelected(0);
        setMessage("Профиль удалён");
      }
    });
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
    if (key.repeated && name === "return") {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.ctrl && name === "c") return;
    if (key.ctrl && name === "f") {
      key.preventDefault();
      if (page === "tools.lsp" && shellFocus === "content")
        lspControls.current?.search?.();
      else setShellFocus("search");
      return;
    }
    if (connectionConfirm) {
      key.preventDefault();
      if (name === "escape") setConnectionConfirm(undefined);
      else if (["up", "down", "tab"].includes(name))
        setConnectionChoice(
          (i) => (i + (name === "up" || key.shift ? 1 : 1)) % 2,
        );
      else if (name === "return") confirmConnection(connectionChoice);
      return;
    }
    if (page === "appearance" && !navigationOnly) {
      if (
        name === "/" &&
        !key.ctrl &&
        !themeSearchFocus &&
        shellFocus !== "search"
      ) {
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
      key.stopPropagation();
      if (
        shellFocus === "content" &&
        (page === "tools.skills" || page === "tools.mcp") &&
        (page === "tools.skills"
          ? skillsControls.current
          : mcpControls.current
        )?.tab?.(key.shift)
      )
        return;
      const zonesWithActions = navigationOnly
        ? (["search", "navigation"] as const)
        : split
          ? (["search", "navigation", "content", "actions"] as const)
          : compactDetail
            ? (["content", "actions", "search"] as const)
            : (["search", "navigation"] as const);
      const zones = zonesWithActions.filter(
        (zone) =>
          zone !== "actions" ||
          settingsMenuActions.some((item) => !item.disabled),
      );
      const index = zones.indexOf(shellFocus as never);
      if (field) void connectionAutosave.flush();
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
      } else if (
        [
          "up",
          "down",
          "pageup",
          "pagedown",
          ...(shellFocus === "search" ? [] : ["home", "end"]),
        ].includes(name)
      ) {
        key.preventDefault();
        const delta =
          name === "home"
            ? -catalogue.length
            : name === "end"
              ? catalogue.length
              : name === "up"
                ? -1
                : name === "down"
                  ? 1
                  : name === "pageup"
                    ? -6
                    : 6;
        setNavigationIndex((i) =>
          Math.max(0, Math.min(catalogue.length - 1, i + delta)),
        );
      } else if (name === "return") {
        key.preventDefault();
        selectRoute(navigationIndex);
      }
      return;
    }
    if (key.ctrl && name === "s") {
      key.preventDefault();
      return;
    }
    if (shellFocus === "actions" && actionNavigation.handle(key)) return;
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
      if (page === "connection" && screen === "profiles") close();
      else if (page === "connection" && screen !== "menu") back();
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
    if (lifetime.current.busy) {
      if (lifetime.current.busy === "models" && name === "return") choose();
      if (name === "return" || name === "tab") key.preventDefault();
      return;
    }
    if (key.ctrl || key.meta || key.option) return;
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
        name === "right" ||
        name === "home" ||
        name === "end"
      ) {
        key.preventDefault();
        setNotice("");
        setThemeIndex(
          (i) =>
            (i +
              (name === "home"
                ? -i
                : name === "end"
                  ? names.length - 1 - i
                  : name === "up" || name === "left"
                    ? -1
                    : 1) +
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
              focused={active && !connectionConfirm && shellFocus === "search"}
              placeholder="Поиск настроек · Ctrl+F"
              backgroundColor={palette.raised}
              focusedBackgroundColor={palette.raised}
              textColor={palette.text}
              focusedTextColor={palette.text}
              placeholderColor={palette.muted}
              onMouseDown={() => setShellFocus("search")}
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
            {page === "connection" &&
              loaded &&
              wide &&
              screen !== "profiles" && (
                <TerminalScrollbox
                  id="settings-profile-list"
                  height={3}
                  flexShrink={0}
                  width="100%"
                >
                  {Object.entries(profiles).map(([id, profile]) => (
                    <DialogAction
                      key={id}
                      id={`settings-profile-${id}`}
                      label={profile.label || id}
                      active={values.profileId === id}
                      palette={palette}
                      onSelect={() => {
                        void connectionAutosave.flush().then((ok) => {
                          if (ok) switchProfile(id);
                        });
                      }}
                    />
                  ))}
                </TerminalScrollbox>
              )}
            {page === "connection" &&
              loaded &&
              !wide &&
              (field || screen === "login") && (
                <box height={tiny ? 1 : 2} flexShrink={0} flexDirection="row">
                  <DialogAction
                    id="settings-profile-switcher"
                    label={
                      values.label || values.profileId || "Нет подключений"
                    }
                    palette={palette}
                    onSelect={() => {
                      void connectionAutosave.flush().then((ok) => {
                        if (ok) {
                          setScreen("profiles");
                          setSelected(0);
                        }
                      });
                    }}
                  />
                  <DialogAction
                    id="settings-add-profile"
                    label="Добавить подключение"
                    palette={palette}
                    onSelect={() => newProfile()}
                  />
                </box>
              )}
            {page === "connection" &&
              loaded &&
              screen === "profiles" &&
              !Object.keys(profiles).length && (
                <text height={1} fg={palette.muted}>
                  Нет подключений
                </text>
              )}
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
                {roomy && (
                  <DialogAction
                    id="settings-motion"
                    label={`Анимации: ${motion.preference === "full" ? (surfaceWidth < 35 ? "да" : "плавные") : surfaceWidth < 35 ? "мин" : "минимум"}`}
                    palette={palette}
                    disabled={motion.saving || !motion.change}
                    onSelect={changeMotion}
                  />
                )}
                {(height >= 12 || themeSearchFocus) && (
                  <input
                    id="settings-theme-search"
                    value={themeSearch}
                    focused={active && themeSearchFocus}
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
                )}
                <box
                  flexDirection="row"
                  height={Math.max(
                    1,
                    bodyHeight -
                      (roomy ? 3 : height >= 12 || themeSearchFocus ? 1 : 0),
                  )}
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
                                  applyTheme();
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
                        Coder Mini, единые поверхности, мягкое выделение и
                        спокойные переходы. Анимации можно свести к минимуму
                        клавишей M.
                      </text>
                      <text marginTop={1} fg={palette.muted}>
                        Стрелки показывают тему во всём интерфейсе. Enter
                        сохраняет понравившийся вариант или нажмите Esc, чтобы
                        вернуться.
                      </text>
                    </box>
                  )}
                  {!names.length && (
                    <text fg={palette.muted}>Темы не найдены</text>
                  )}
                </box>
              </box>
            ) : screen === "login" ? (
              <box
                width="100%"
                height="100%"
                flexDirection="column"
                paddingLeft={1}
              >
                <text fg={palette.accent} height={1}>
                  <strong>Вход в {definition?.label ?? "аккаунт"}</strong>
                </text>
                <text marginTop={roomy ? 1 : 0} fg={palette.text}>
                  {challenge
                    ? "Откройте в браузере"
                    : busy
                      ? "Получаем код…"
                      : "Не удалось войти"}
                </text>
                {challenge && (
                  <>
                    <text fg={palette.accent}>{challenge.url}</text>
                    <text marginTop={roomy ? 1 : 0} fg={palette.text}>
                      Код: <strong>{challenge.code}</strong>
                    </text>
                    <text fg={palette.muted}>
                      Ожидаем подтверждения · Esc отменить
                    </text>
                  </>
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
                      active={
                        active &&
                        !connectionConfirm &&
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
                        !connectionConfirm &&
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
                      ? "Ключ скрыт и автоматически записывается в защищённое хранилище."
                      : screen === "profile-id"
                        ? "Уникальное имя для отдельного аккаунта этого сервиса."
                        : "Введите значение. Enter и Esc завершают запись."}
                  </text>
                )}
              </box>
            ) : (
              <>
                <box
                  height={1}
                  flexShrink={0}
                  flexDirection="row"
                  justifyContent="space-between"
                >
                  <DialogAction
                    id="settings-profile-switcher"
                    label={screen === "profiles" ? "Профили" : "‹ Профили"}
                    palette={palette}
                    onSelect={() => open("profiles")}
                  />
                  {screen === "menu" && (
                    <text fg={palette.muted}>
                      {terminalLine(
                        values.label || values.profileId || "Новое подключение",
                        Math.max(1, innerWidth - 14),
                      )}
                    </text>
                  )}
                  {screen === "profiles" && (
                    <DialogAction
                      id="settings-new-profile"
                      label="+ Добавить"
                      palette={palette}
                      onSelect={newProfile}
                    />
                  )}
                </box>
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
                        !connectionConfirm &&
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
                                (bodyHeight -
                                  (wide && screen !== "profiles" ? 3 : 0) -
                                  1 -
                                  (selector ? 1 : 0)) /
                                  rowHeight,
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
                            ? "Сохранение изменений…"
                            : hasKey
                              ? "Сохранено · готово к работе"
                              : "Сохранено · требуется настройка"}
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
                active={active && page === "tools.mcp" && !navigationOnly}
                focused={shellFocus === "content"}
                controls={mcpControls}
                onDirty={recordDirty}
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
                active={active && page === "tools.skills" && !navigationOnly}
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
                active={active && page === "extensions" && !navigationOnly}
                focused={shellFocus === "content"}
                controls={extensionsControls}
                onOpenBuiltin={changePage}
                onDirty={recordDirty}
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
                  shellFocus === "content"
                }
                controls={webControls}
                onDirty={recordDirty}
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
                  active && page === "tools.background" && !navigationOnly
                }
                focused={shellFocus === "content"}
                controls={backgroundControls}
                onDirty={recordDirty}
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
                active={active && page === "tools.subagents" && !navigationOnly}
                focused={shellFocus === "content"}
                controls={subagentControls}
                onDirty={recordDirty}
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
                active={active && page === "tools.lsp" && !navigationOnly}
                focused={shellFocus === "content"}
                fieldTarget={fieldTarget}
                onFieldTargetHandled={() => setFieldTarget(undefined)}
                controls={lspControls}
                onDirty={recordDirty}
                onChooseProject={
                  onChooseProject ? () => close(onChooseProject) : undefined
                }
              />
            </box>
          )}
        </box>
      </box>
      {connectionConfirm && (
        <box
          position="absolute"
          left={1}
          top={1}
          width="100%"
          height={Math.max(1, popupHeight - 2)}
          backgroundColor={palette.surface}
          flexDirection="column"
        >
          <text fg={palette.yellow}>
            {connectionConfirm.type === "delete"
              ? `Удалить профиль ${values.label || connectionConfirm.profileId}?`
              : "Отключить аккаунт?"}
          </text>
          <DialogAction
            id="settings-connection-cancel"
            label="Отмена"
            active={connectionChoice === 0}
            palette={palette}
            onSelect={() => confirmConnection(0)}
          />
          <DialogAction
            id="settings-connection-discard"
            label={
              connectionConfirm.type === "delete" ? "Удалить" : "Отключить"
            }
            active={connectionChoice === 1}
            palette={palette}
            onSelect={() => confirmConnection(1)}
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
      {navigationOnly ? (
        <text height={1} flexShrink={0} fg={palette.muted}>
          {terminalLine("↑↓ выбор · Tab области · Enter · Esc", surfaceWidth)}
        </text>
      ) : (
        <MenuActions
          id="settings-actions"
          actions={settingsMenuActions}
          navigation={{
            ...actionNavigation,
            area: shellFocus === "actions" ? "actions" : "content",
          }}
          width={surfaceWidth}
          palette={palette}
          compact={simpleFooter || !roomy}
        />
      )}
      {showHint && (
        <text height={1} fg={palette.muted}>
          {terminalSafeText(
            page !== "web" && busy
              ? busy === "models"
                ? "Загружаем модели... | Esc назад"
                : busy === "check"
                  ? "Проверяем подключение... | Esc закрыть"
                  : "Подождите..."
              : shellFocus === "actions"
                ? "←→ · Enter · Esc"
                : innerWidth >= 70
                  ? "Tab области · ←→ действия · Esc"
                  : innerWidth >= 32
                    ? "Tab фокус · Esc назад"
                    : "Tab · Esc назад",
            innerWidth,
          )}
        </text>
      )}
    </OpenTuiDialog>
  );
}
