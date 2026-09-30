/** @jsxImportSource @opentui/react */
import { RGBA } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useMemo, useRef, useState } from "react";
import type { Skill } from "../skills/skills.js";
import { type Palette, THEMES } from "./appearance.js";
import { terminalSafeText } from "./opentui-transcript.js";

export interface OpenTuiSkillsActions {
  load(): Skill[];
  activeNames(): string[];
  toggle(name: string): void;
  editSource?(name: string): string;
}

function Action({
  label,
  onSelect,
  palette,
  active = false,
  primary = false,
  disabled = false,
}: {
  label: string;
  onSelect: () => void;
  palette: Palette;
  active?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Popup actions also have keyboard bindings.
    <box
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={
        primary && !disabled
          ? palette.accent
          : active
            ? palette.raised
            : palette.surface
      }
      onMouseUp={(event) => {
        event.stopPropagation();
        if (!disabled) onSelect();
      }}
    >
      <text
        fg={
          disabled
            ? palette.muted
            : primary
              ? palette.bg
              : active
                ? palette.accent
                : palette.text
        }
      >
        {label}
      </text>
    </box>
  );
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
}: {
  actions: OpenTuiSkillsActions;
  width: number;
  height: number;
  palette?: Palette;
  onClose: () => void;
  onChoose: (skill: Skill) => void;
  onCreate?: () => void;
  onEdit?: (skill: Skill) => void;
}) {
  const renderer = useRenderer();
  const { skills, error: loadError } = useMemo(
    () => readCatalog(actions),
    [actions],
  );
  const [active, setActive] = useState(() => actions.activeNames());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState<"library" | "pin">("library");
  const [instructions, setInstructions] = useState(false);
  const [error, setError] = useState("");
  const dismissOnRelease = useRef(false);
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return skills.filter((skill) => {
      const haystack =
        `${skill.name} ${skill.description} ${skill.source === "bundled" ? "встроенный" : "пользовательский"}`.toLocaleLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [skills, query]);
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
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
    else if (current.userInvocable !== false) run(() => onChoose(current));
  };
  useKeyboard((key) => {
    const name = key.name.toLowerCase();
    if (key.ctrl && name === "c") return;
    if (name === "escape") {
      key.preventDefault();
      if (instructions) setInstructions(false);
      else onClose();
    } else if (name === "tab") {
      key.preventDefault();
      changePage(page === "library" ? "pin" : "library");
    } else if (key.ctrl && name === "o" && current) {
      key.preventDefault();
      setInstructions((value) => !value);
    } else if (key.ctrl && name === "n" && canCreate && onCreate) {
      key.preventDefault();
      run(onCreate);
    } else if (key.ctrl && name === "e" && canEdit && current && onEdit) {
      key.preventDefault();
      run(() => onEdit(current));
    } else if (name === "return" || name === "enter") {
      key.preventDefault();
      choose();
    } else if (
      !instructions &&
      (name === "up" ||
        name === "down" ||
        name === "pageup" ||
        name === "pagedown")
    ) {
      key.preventDefault();
      const delta =
        name === "up" ? -1 : name === "down" ? 1 : name === "pageup" ? -5 : 5;
      setSelected((value) =>
        Math.max(0, Math.min(filtered.length - 1, value + delta)),
      );
    }
  });

  const popupWidth = Math.max(1, Math.min(104, width - (width >= 50 ? 4 : 2)));
  const popupHeight = Math.max(
    1,
    Math.min(30, height - (height >= 12 ? 2 : 0)),
  );
  const roomy = popupHeight >= 18;
  const tiny = popupHeight < 8 || popupWidth < 30;
  const innerWidth = Math.max(1, popupWidth - 4);
  const wide = innerWidth >= 70 && roomy;
  const bodyHeight = Math.max(1, popupHeight - (roomy ? 16 : 7));
  const listWidth = wide
    ? Math.min(36, Math.floor(innerWidth * 0.43))
    : innerWidth;
  const rowHeight = roomy ? 3 : 2;
  const rows = Math.max(1, Math.floor(bodyHeight / rowHeight));
  const start = Math.max(0, Math.min(index - rows + 1, filtered.length - rows));
  const left = Math.max(0, Math.floor((width - popupWidth) / 2));
  const top = Math.max(0, Math.floor((height - popupHeight) / 2));
  const primary =
    page === "pin"
      ? active.includes(current?.name ?? "")
        ? "Открепить"
        : "Закрепить"
      : "Применить к задаче";
  const disabled =
    !current || (page === "library" && current.userInvocable === false);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape also dismisses the modal.
    <box
      id="skills-backdrop"
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={100}
      backgroundColor={RGBA.fromInts(
        0,
        0,
        0,
        palette.bg === THEMES.paper.bg ? 65 : 150,
      )}
      onMouseDown={() => {
        dismissOnRelease.current = !renderer.getSelection()?.getSelectedText();
      }}
      onMouseUp={() => {
        if (
          dismissOnRelease.current &&
          !renderer.getSelection()?.getSelectedText()
        )
          onClose();
      }}
    >
      <box
        position="absolute"
        left={left + 1}
        top={top + 1}
        width={popupWidth}
        height={popupHeight}
        backgroundColor={RGBA.fromInts(0, 0, 0, 85)}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Keep popup clicks from dismissing its backdrop. */}
      <box
        id="skills-popup"
        position="absolute"
        left={left}
        top={top}
        width={popupWidth}
        height={popupHeight}
        border={tiny ? [] : true}
        borderStyle="rounded"
        borderColor={palette.border}
        backgroundColor={palette.surface}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={roomy ? 1 : 0}
        paddingBottom={roomy ? 1 : 0}
        flexDirection="column"
        overflow="hidden"
        onMouseUp={(event) => event.stopPropagation()}
      >
        <box
          height={1}
          flexShrink={0}
          flexDirection="row"
          justifyContent="space-between"
        >
          <text fg={palette.accent}>
            <strong>✦ Скиллы</strong>
          </text>
          <Action label="Esc ×" palette={palette} onSelect={onClose} />
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
          borderColor={instructions ? palette.border : palette.accent}
          backgroundColor={palette.raised}
          paddingLeft={1}
          paddingRight={1}
        >
          <input
            id="skills-search"
            value={query}
            focused={!instructions}
            placeholder="Поиск по названию или описанию…"
            backgroundColor={palette.raised}
            focusedBackgroundColor={palette.raised}
            textColor={palette.text}
            focusedTextColor={palette.text}
            placeholderColor={palette.muted}
            onInput={(value) => {
              setQuery(value);
              setSelected(0);
            }}
          />
        </box>
        {!tiny && (
          <box
            height={1}
            flexShrink={0}
            marginTop={roomy ? 1 : 0}
            flexDirection="row"
            gap={1}
          >
            <Action
              label={`Библиотека ${skills.length}`}
              active={page === "library"}
              palette={palette}
              onSelect={() => changePage("library")}
            />
            <Action
              label={`Закрепление ${active.length}`}
              active={page === "pin"}
              palette={palette}
              onSelect={() => changePage("pin")}
            />
          </box>
        )}
        <box
          height={tiny ? Math.max(1, popupHeight - 4) : bodyHeight}
          flexShrink={0}
          marginTop={roomy ? 1 : 0}
          flexDirection="row"
        >
          {instructions && current ? (
            <box width="100%" height="100%" flexDirection="column">
              <text height={1} fg={palette.accent}>
                Инструкции · /{current.name}
              </text>
              <scrollbox
                id="skills-instructions"
                flexGrow={1}
                focused
                viewportCulling
                scrollbarOptions={{ visible: false }}
              >
                <text fg={palette.text} selectable>
                  {terminalSafeText(current.instructions)}
                </text>
              </scrollbox>
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
                  setSelected((value) =>
                    Math.max(
                      0,
                      Math.min(
                        filtered.length - 1,
                        value + (direction === "up" ? -1 : 1),
                      ),
                    ),
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
                        onMouseUp={() => {
                          setSelected(start + offset);
                        }}
                      >
                        <box
                          width={1}
                          height="100%"
                          backgroundColor={
                            selectedRow ? palette.accent : palette.surface
                          }
                        />
                        <box
                          paddingLeft={1}
                          flexGrow={1}
                          flexDirection="column"
                        >
                          <text
                            height={1}
                            fg={selectedRow ? palette.accent : palette.text}
                          >
                            {page === "pin"
                              ? active.includes(skill.name)
                                ? "● "
                                : "○ "
                              : ""}
                            {terminalSafeText(
                              `${skill.userInvocable === false ? "" : "/"}${skill.name}`,
                              Math.max(1, listWidth - 4),
                            )}
                          </text>
                          <text height={1} fg={palette.muted}>
                            {terminalSafeText(
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
                      · {invocationLabel(current)}
                    </text>
                    <scrollbox
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
                    </scrollbox>
                    <Action
                      label="Ctrl+O  Инструкции"
                      palette={palette}
                      onSelect={() => setInstructions(true)}
                    />
                  </box>
                </>
              )}
            </>
          )}
        </box>
        {!tiny && (
          <box
            height={2}
            flexShrink={0}
            marginTop={roomy ? 1 : 0}
            flexDirection="column"
          >
            <box height={1} flexDirection="row" gap={1}>
              <Action
                label={`↵ ${primary}`}
                primary
                disabled={disabled}
                palette={palette}
                onSelect={choose}
              />
              {roomy && onCreate && canCreate && (
                <Action
                  label="Ctrl+N Создать"
                  palette={palette}
                  onSelect={() => run(onCreate)}
                />
              )}
              {wide && canEdit && current && onEdit && (
                <Action
                  label="Ctrl+E Изменить"
                  palette={palette}
                  onSelect={() => run(() => onEdit(current))}
                />
              )}
            </box>
            <text height={1} fg={palette.muted}>
              {terminalSafeText(
                error ||
                  (page === "pin"
                    ? "На каждое сообщение этой вкладки · Tab библиотека · Esc закрыть"
                    : roomy
                      ? `↑↓ выбрать · Tab закрепление · Ctrl+O инструкции · ${filtered.length} найдено`
                      : "↑↓ выбрать · Tab закрепление · Ctrl+O текст"),
                innerWidth,
              )}
            </text>
          </box>
        )}
        {tiny && (
          <text height={1} fg={palette.muted}>
            Enter выбрать · Esc закрыть
          </text>
        )}
      </box>
    </box>
  );
}
