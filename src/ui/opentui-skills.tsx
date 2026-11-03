/** @jsxImportSource @opentui/react */

import { useEffect, useMemo, useState } from "react";
import type { Skill } from "../skills/skills.js";
import { type Palette, THEMES } from "./appearance.js";
import { MenuActions, useMenuNavigation } from "./menu-navigation.js";
import { DialogAction as Action } from "./opentui-dialog.js";
import { OpenTuiToolPane, toolPaneLayout } from "./opentui-tool-pane.js";
import { terminalSafeText } from "./opentui-transcript.js";
import { useUiKeyboard } from "./overlay-input.js";
import type { EmbeddedSettingsPanel } from "./settings-panel.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import { SKILL_MARK } from "./theme.js";

export interface OpenTuiSkillsActions {
  load(): Skill[];
  activeNames(): string[];
  toggle(name: string): void;
  editSource?(name: string): string;
}

function readCatalog(actions: OpenTuiSkillsActions) {
  try {
    return {
      skills: [...actions.load()].sort((a, b) => a.name.localeCompare(b.name)),
      error: "",
    };
  } catch (cause) {
    return { skills: [] as Skill[], error: String(cause) };
  }
}

function invocationLabel(skill: Skill): string {
  if (skill.userInvocable === false)
    return skill.disableModelInvocation ? "Вызов отключён" : "Только агент";
  return skill.disableModelInvocation ? "Вручную" : "Автовыбор";
}

export function OpenTuiSkills({
  actions,
  width,
  height,
  palette = THEMES.obsidian,
  onClose,
  onChoose,
  onCreate,
  onEdit,
  embedded = false,
  active: enabled = true,
  focused = true,
  controls,
}: EmbeddedSettingsPanel & {
  actions: OpenTuiSkillsActions;
  width: number;
  height: number;
  palette?: Palette;
  onClose: () => void;
  onChoose?: (skill: Skill) => void;
  onCreate?: () => void;
  onEdit?: (skill: Skill) => void;
}) {
  const [revision, refresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh invalidates the filesystem catalog.
  const { skills, error: loadError } = useMemo(
    () => readCatalog(actions),
    [actions, revision],
  );
  const [active, setActive] = useState<string[]>(() => {
    try {
      return actions.activeNames();
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (enabled) {
      try {
        setActive(actions.activeNames());
      } catch (cause) {
        setError(String(cause));
      }
    }
  }, [enabled, actions]);
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState<string>();
  const [page, setPage] = useState<"library" | "pin">("library");
  const [instructions, setInstructions] = useState(false);
  const [error, setError] = useState("");
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return skills.filter((skill) => {
      const haystack =
        `${skill.name} ${skill.description} ${skill.source === "bundled" ? "встроенный" : "пользовательский"}`.toLocaleLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [skills, query]);
  const index = Math.max(
    0,
    filtered.findIndex((skill) => skill.name === selectedName),
  );
  const current = filtered[index];
  const canCreate = skills.some(
    (skill) => skill.name === "skill-creator" && skill.userInvocable !== false,
  );
  const canEdit =
    !!current && current.source === "user" && canCreate && !!onEdit;
  const changePage = (next: "library" | "pin") => {
    setPage(next);
    setInstructions(false);
    setError("");
  };
  const run = (work: () => void) => {
    try {
      work();
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  };
  const choose = () => {
    if (!current) return;
    if (page === "pin")
      run(() => {
        actions.toggle(current.name);
        setActive(actions.activeNames());
      });
    else if (current.userInvocable !== false && onChoose)
      run(() => onChoose(current));
  };
  const menuActions = [
    {
      id: "skills-choose",
      label:
        page === "pin"
          ? active.includes(current?.name ?? "")
            ? "Открепить"
            : "Закрепить"
          : "Применить к задаче",
      shortLabel: page === "pin" ? undefined : "Применить",
      disabled:
        !current ||
        (page === "library" && (current.userInvocable === false || !onChoose)),
      run: choose,
    },
    {
      id: "skills-instructions-action",
      label: instructions ? "К списку" : "Инструкции",
      disabled: !current,
      run: () => {
        setInstructions((value) => !value);
        navigation.setArea("list");
      },
    },
    {
      id: "skills-create",
      label: "Создать",
      disabled: !canCreate || !onCreate,
      run: () => {
        if (onCreate) run(onCreate);
      },
    },
    {
      id: "skills-edit",
      label: "Изменить",
      disabled: !canEdit,
      run: () => {
        if (current && onEdit) run(() => onEdit(current));
      },
    },
    {
      id: "skills-refresh",
      label: "Обновить каталог",
      run: () => refresh((value) => value + 1),
    },
  ];
  const navigation = useMenuNavigation(
    ["tabs", "search", "list", "actions"],
    menuActions,
  );
  if (controls)
    controls.current = {
      save() {},
      discard() {},
      tab(reverse) {
        return navigation.tab(reverse, false);
      },
      back() {
        if (instructions) {
          setInstructions(false);
          return true;
        }
        return false;
      },
    };
  useUiKeyboard((key) => {
    if (!enabled || !focused) return;
    const name = key.name.toLowerCase();
    if (key.ctrl && name === "c") return;
    if (embedded && ["escape", "tab"].includes(name)) return;
    if (embedded && key.ctrl && ["f", "s"].includes(name)) return;
    if (navigation.handle(key)) return;
    if (key.ctrl || key.meta || key.option) return;
    if (name === "escape") {
      key.preventDefault();
      if (instructions) setInstructions(false);
      else onClose();
    } else if (
      navigation.area === "tabs" &&
      ["left", "right", "return", "space"].includes(name)
    ) {
      key.preventDefault();
      if (!key.repeated) changePage(page === "library" ? "pin" : "library");
    } else if (name === "/" && navigation.area !== "search") {
      key.preventDefault();
      navigation.setArea("search");
    } else if (
      name === "return" ||
      name === "enter" ||
      (name === "space" && navigation.area === "list")
    ) {
      if (instructions) return;
      key.preventDefault();
      if (!key.repeated) choose();
    } else if (
      !instructions &&
      ["list", "search"].includes(navigation.area) &&
      (name === "up" ||
        name === "down" ||
        name === "pageup" ||
        name === "pagedown" ||
        (navigation.area === "list" && ["home", "end"].includes(name)))
    ) {
      key.preventDefault();
      const delta =
        name === "home"
          ? -filtered.length
          : name === "end"
            ? filtered.length
            : name === "up"
              ? -1
              : name === "down"
                ? 1
                : name === "pageup"
                  ? -5
                  : 5;
      setSelectedName(
        filtered[Math.max(0, Math.min(filtered.length - 1, index + delta))]
          ?.name,
      );
    }
  });

  const { innerWidth, popupHeight, roomy, tiny } = toolPaneLayout(
    width,
    height,
    embedded,
  );
  const wide = innerWidth >= 70 && roomy;
  const bodyHeight = Math.max(
    1,
    popupHeight - (embedded ? (tiny ? 5 : roomy ? 12 : 5) : roomy ? 16 : 7),
  );
  const listWidth = wide
    ? Math.min(36, Math.floor(innerWidth * 0.43))
    : innerWidth;
  const rowHeight = roomy ? 3 : 2;
  const rows = Math.max(1, Math.floor(bodyHeight / rowHeight));
  const start = Math.max(0, Math.min(index - rows + 1, filtered.length - rows));

  return (
    <OpenTuiToolPane
      embedded={embedded}
      id="skills"
      width={width}
      height={height}
      palette={palette}
      onClose={onClose}
    >
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={palette.accent} height={1}>
          <strong>
            {terminalLine(
              embedded ? "Библиотека навыков" : `${SKILL_MARK} Скиллы`,
              Math.max(1, innerWidth - (embedded ? 0 : 7)),
            )}
          </strong>
        </text>
        {!embedded && (
          <Action label="Esc x" palette={palette} onSelect={onClose} />
        )}
      </box>
      {roomy && (
        <text fg={palette.muted} height={1}>
          Агент сам подбирает подходящий навык
        </text>
      )}
      <box
        height={roomy ? 3 : 1}
        flexShrink={0}
        marginTop={roomy ? 1 : 0}
        border={roomy ? true : []}
        borderStyle="rounded"
        borderColor={
          !instructions && focused && navigation.area === "search"
            ? palette.accent
            : palette.border
        }
        backgroundColor={palette.raised}
        paddingLeft={1}
        paddingRight={1}
      >
        <input
          id="skills-search"
          value={query}
          focused={
            enabled && focused && !instructions && navigation.area === "search"
          }
          placeholder="Поиск по названию или описанию..."
          backgroundColor={palette.raised}
          focusedBackgroundColor={palette.raised}
          textColor={palette.text}
          focusedTextColor={palette.text}
          placeholderColor={palette.muted}
          onInput={(value) => {
            setQuery(value);
            setSelectedName(undefined);
          }}
        />
      </box>
      {
        <box
          height={1}
          flexShrink={0}
          marginTop={roomy ? 1 : 0}
          flexDirection="row"
          gap={1}
        >
          <Action
            id="skills-library-tab"
            label={`${navigation.area === "tabs" && page === "library" && focused ? "› " : ""}Библиотека${innerWidth >= 45 ? ` ${skills.length}` : ""}`}
            active={navigation.area === "tabs" && page === "library"}
            palette={palette}
            onSelect={() => changePage("library")}
          />
          <Action
            id="skills-pins-tab"
            label={`${navigation.area === "tabs" && page === "pin" && focused ? "› " : ""}Закрепление${innerWidth >= 45 ? ` ${active.length}` : ""}`}
            active={navigation.area === "tabs" && page === "pin"}
            palette={palette}
            onSelect={() => changePage("pin")}
          />
        </box>
      }
      <box
        height={bodyHeight}
        flexShrink={0}
        marginTop={roomy ? 1 : 0}
        flexDirection="row"
      >
        {instructions && current ? (
          <box width="100%" height="100%" flexDirection="column">
            <text height={1} fg={palette.accent}>
              Инструкции | /{current.name}
            </text>
            <TerminalScrollbox
              id="skills-instructions"
              flexGrow={1}
              focused={enabled && focused && navigation.area === "list"}
              viewportCulling
              scrollbarOptions={{ visible: false }}
            >
              {embedded && (
                <>
                  <text fg={palette.muted}>
                    {current.source === "bundled"
                      ? "Встроенный"
                      : "Пользовательский"}{" "}
                    · {invocationLabel(current)}
                    {"\n"}
                    {terminalSafeText(current.dir)}
                  </text>
                  <text fg={palette.text} marginBottom={1}>
                    {terminalSafeText(current.description)}
                  </text>
                </>
              )}
              <text fg={palette.text} selectable>
                {terminalSafeText(current.instructions)}
              </text>
            </TerminalScrollbox>
          </box>
        ) : (
          <>
            <box
              width={listWidth}
              height="100%"
              flexDirection="column"
              onMouseScroll={(event) => {
                const direction = event.scroll?.direction;
                if (direction !== "up" && direction !== "down") return;
                event.stopPropagation();
                setSelectedName(
                  filtered[
                    Math.max(
                      0,
                      Math.min(
                        filtered.length - 1,
                        index + (direction === "up" ? -1 : 1),
                      ),
                    )
                  ]?.name,
                );
              }}
            >
              {loadError || error ? (
                <text fg={palette.red}>
                  {terminalSafeText(loadError || error, listWidth * rows)}
                </text>
              ) : filtered.length === 0 ? (
                <box flexDirection="column" paddingTop={roomy ? 2 : 0}>
                  <text fg={palette.text}>
                    {query ? "Ничего не найдено" : "Пока нет скиллов"}
                  </text>
                  {roomy && (
                    <text fg={palette.muted}>
                      {query
                        ? "Попробуйте другой запрос"
                        : "Создайте первый навык через /skill-creator"}
                    </text>
                  )}
                </box>
              ) : (
                filtered.slice(start, start + rows).map((skill, offset) => {
                  const selectedRow = start + offset === index;
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: Arrow keys select the same rows.
                    <box
                      key={skill.name}
                      height={rowHeight}
                      flexShrink={0}
                      flexDirection="row"
                      backgroundColor={
                        selectedRow ? palette.raised : palette.surface
                      }
                      onMouseUp={(event) => {
                        if (event.button !== 0) return;
                        setSelectedName(skill.name);
                      }}
                    >
                      <box
                        width={1}
                        height="100%"
                        backgroundColor={
                          selectedRow ? palette.accent : palette.surface
                        }
                      />
                      <box paddingLeft={1} flexGrow={1} flexDirection="column">
                        <text
                          height={1}
                          fg={selectedRow ? palette.accent : palette.text}
                        >
                          {page === "pin"
                            ? active.includes(skill.name)
                              ? "* "
                              : "o "
                            : ""}
                          {terminalLine(
                            `${skill.userInvocable === false ? "" : "/"}${skill.name}`,
                            Math.max(1, listWidth - 4),
                          )}
                        </text>
                        <text height={1} fg={palette.muted}>
                          {terminalLine(
                            skill.description.replace(/\s+/g, " "),
                            Math.max(1, listWidth - 4),
                          )}
                        </text>
                      </box>
                    </box>
                  );
                })
              )}
            </box>
            {wide && current && (
              <>
                <box
                  width={1}
                  height="100%"
                  marginLeft={1}
                  marginRight={2}
                  backgroundColor={palette.border}
                />
                <box
                  flexGrow={1}
                  height="100%"
                  flexDirection="column"
                  overflow="hidden"
                >
                  <text fg={palette.text} height={1}>
                    <strong>{current.name}</strong>
                  </text>
                  <text fg={palette.muted} height={1}>
                    {current.source === "bundled"
                      ? "Встроенный"
                      : "Пользовательский"}{" "}
                    | {invocationLabel(current)}
                  </text>
                  {embedded && (
                    <text fg={palette.muted} height={1}>
                      {terminalLine(
                        current.dir,
                        Math.max(1, innerWidth - listWidth - 4),
                      )}
                    </text>
                  )}
                  <TerminalScrollbox
                    flexGrow={1}
                    marginTop={1}
                    viewportCulling
                    scrollbarOptions={{ visible: false }}
                  >
                    <text fg={palette.text}>
                      {terminalSafeText(current.description)}
                    </text>
                    <text fg={palette.muted} marginTop={1}>
                      {page === "pin"
                        ? "Для постоянных правил. Закреплённые инструкции добавляются к каждому сообщению этой вкладки."
                        : current.userInvocable === false
                          ? current.disableModelInvocation
                            ? "Вызов этого навыка отключён в его настройках."
                            : "Этот навык доступен агенту. Опишите задачу обычным сообщением."
                          : "Примените к одному сообщению. После выбора можно добавить задачу и отправить её."}
                    </text>
                  </TerminalScrollbox>
                </box>
              </>
            )}
          </>
        )}
      </box>
      <MenuActions
        id="skills-actions"
        actions={menuActions}
        navigation={{
          ...navigation,
          area: enabled && focused ? navigation.area : "inactive",
        }}
        width={innerWidth}
        palette={palette}
        compact={!roomy}
      />
      <text height={1} flexShrink={0} fg={error ? palette.red : palette.muted}>
        {terminalLine(
          error ||
            (navigation.area === "actions"
              ? "←→ действие · Enter · Esc"
              : width < 50
                ? "Tab области · Enter · Esc"
                : "↑↓ выбор · Tab области · Enter · Esc"),
          innerWidth,
        )}
      </text>
    </OpenTuiToolPane>
  );
}
