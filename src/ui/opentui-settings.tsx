/** @jsxImportSource @opentui/react */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenTuiMcpActions } from "../mcp/controller.js";
import type { Skill } from "../skills/skills.js";
import { ThemeCatalog } from "../themes/catalog.js";
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
import { SETTINGS_SECTIONS, searchSettings } from "./settings-catalog.js";
import {
  labels,
  type OpenTuiSettingsActions,
  type Page,
  type Screen,
  safeNotice,
} from "./settings-contracts.js";
import { SettingsNavigation } from "./settings-navigation.js";
import type { SettingsPanelControl } from "./settings-panel.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { isCtrlC } from "./terminal-keys.js";
import { terminalLine } from "./terminal-text.js";
import { useConnectionSettings } from "./use-connection-settings.js";

export type { OpenTuiSettingsActions } from "./settings-contracts.js";

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
          isMounted() &&
          setMessage(
            `Не удалось сохранить анимации: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          ),
      );
  };

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

  const extensionsControls = useRef<SettingsPanelControl | undefined>(
    undefined,
  );
  const backgroundControls = useRef<SettingsPanelControl | undefined>(
    undefined,
  );
  const subagentControls = useRef<SettingsPanelControl | undefined>(undefined);
  const webControls = useRef<SettingsPanelControl | undefined>(undefined);

  const lspControls = useRef<SettingsPanelControl | undefined>(undefined);
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
  const restore = useRef({ theme, preview: onThemePreview });
  restore.current.preview = onThemePreview;
  const {
    popupHeight,
    innerWidth: surfaceWidth,
    roomy,
    tiny,
  } = dialogLayout(width, height, 30, 104);

  const {
    values,
    profiles,
    hasKey,
    loaded,
    challenge,
    connectionConfirm,
    setConnectionConfirm,
    connectionChoice,
    setConnectionChoice,
    screen,
    setScreen,
    selected,
    selectedRef,
    setSelected,
    query,
    setQuery,
    editing,
    setEditing,
    notice,
    setNotice,
    noticeKind,
    busy,
    working,
    isMounted,
    reloadBaseline,
    activate,
    definition,
    subscription,
    rows,
    menuIndex,
    choices,
    choiceIndex,
    selector,
    field,
    dirty,
    setMessage,
    cancelWork,
    connectionAutosave,
    save,
    check,
    login,
    switchProfile,
    newProfile,
    open,
    back,
    acceptField,
    choose,
    confirmConnection,
  } = useConnectionSettings({
    onOpenContent: () => {
      setCompactDetail(true);
      setShellFocus("content");
    },
    actions,
    initialSelection,
  });
  useEffect(() => {
    if (page === "tools.skills") setSkillsVisited(true);
    if (page === "tools.mcp" && !mcp && getMcpActions) {
      try {
        setMcp(getMcpActions());
      } catch (cause) {
        setNotice(String(cause));
      }
    }
  }, [page, mcp, getMcpActions, setNotice]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Смена actions завершает предпросмотр прежнего окна, как и unmount.
  useEffect(
    () => () => {
      restore.current.preview?.(restore.current.theme);
    },
    [actions],
  );
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
  const currentTheme = names[themeIndex] ?? savedTheme;
  const currentColors = catalog.palette(currentTheme);
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
        working() === "save" ||
        working() === "theme" ||
        working() === "permissions"
      )
        return;
      if (next === "connection" && !actions) return;
      if (working() !== "load") cancelWork();
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
                        run: () =>
                          reloadBaseline(
                            "Данные обновлены; ввод сохранён. Повторите выход из поля.",
                          ),
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
                        run: () =>
                          activate(
                            setup ? () => completeClose("saved") : undefined,
                          ),
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
                        run: () =>
                          reloadBaseline(
                            "Данные обновлены; введённые значения сохранены. Повторите запись.",
                          ),
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
    if (isCtrlC(key)) return;
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
    if (working()) {
      if (working() === "models" && name === "return") choose();
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
