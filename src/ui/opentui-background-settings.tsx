/** @jsxImportSource @opentui/react */

import type { ScrollBoxRenderable } from "@opentui/core";
import {
  type MutableRefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  BACKGROUND_LIMITS,
  BackgroundConfigSchema,
  ProjectBackgroundConfigSchema,
} from "../background/config.js";
import type {
  BackgroundSettingsActions,
  BackgroundSettingsState,
} from "../background/settings.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import type { SettingsPanelControl } from "./opentui-lsp-settings.js";
import { useUiKeyboard } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
export function OpenTuiBackgroundSettings({
  actions,
  palette,
  width,
  height,
  active,
  focused,
  controls,
  onDirty,
}: {
  actions: BackgroundSettingsActions;
  palette: Palette;
  width: number;
  height: number;
  active: boolean;
  focused: boolean;
  controls: MutableRefObject<SettingsPanelControl | undefined>;
  onDirty: (value: boolean) => void;
}) {
  const [state, setState] = useState<BackgroundSettingsState>();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [project, setProject] = useState(false);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const body = useRef<ScrollBoxRenderable>(null);
  const dirty =
    !!state &&
    JSON.stringify(draft) !==
      JSON.stringify(project ? state.project : state.global);
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    void actions
      .load(abort.signal)
      .then((value) => {
        if (alive.current) {
          setState(value);
          setDraft({ ...value.global });
        }
      })
      .catch((error) => {
        if (alive.current) setNotice(String(error.message));
      });
    return () => {
      alive.current = false;
      abort.abort();
    };
  }, [actions]);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const fields = [
    "enabled",
    "maxActive",
    "batchDeadlineMs",
    "serviceDeadlineMs",
    "outputBytes",
    "retentionDays",
  ] as const;
  const names = [
    "Фоновые задачи",
    "Одновременно (1–2)",
    "Проверка, мс (до 2 ч)",
    "Сервис, мс (до 8 ч)",
    "Вывод, байт (до 16 MiB)",
    "Хранение, дни (1–7)",
  ];
  const save = () => {
    if (!state || busy) return;
    const validated = project
      ? ProjectBackgroundConfigSchema.parse(draft)
      : BackgroundConfigSchema.parse(draft);
    setBusy(true);
    void (
      project
        ? actions.saveProject(validated, state.projectRevision)
        : actions.saveGlobal(
            BackgroundConfigSchema.parse(validated),
            state.globalRevision,
          )
    )
      .then((value) => {
        if (alive.current) {
          setState(value);
          setDraft({ ...(project ? value.project : value.global) });
          setNotice(
            "Сохранено. Отключение останавливает команды, сохраняя логи и файлы.",
          );
        }
      })
      .catch((error) => {
        if (alive.current) setNotice(error.message);
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  };
  const discard = () => {
    if (state) setDraft({ ...(project ? state.project : state.global) });
    setEditing(false);
  };
  useLayoutEffect(() => {
    controls.current = {
      save: () => {
        try {
          save();
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      },
      back: () => {
        if (!editing) return false;
        setEditing(false);
        return true;
      },
      discard,
    };
    return () => {
      controls.current = undefined;
    };
  });
  const accept = () => {
    if (project && !input.trim()) {
      const next = { ...draft };
      delete next[fields[selected - 1]!];
      setDraft(next);
      setEditing(false);
      return;
    }
    const value = Number(input);
    if (!Number.isInteger(value)) {
      setNotice("Нужно целое число.");
      return;
    }
    setDraft({ ...draft, [fields[selected - 1]!]: value });
    setEditing(false);
    setNotice("");
  };
  const activate = () => {
    if (selected === 0) {
      if (dirty) {
        setNotice("Сохраните или отмените изменения перед сменой области.");
        return;
      }
      const next = !project;
      setProject(next);
      setDraft({ ...(next ? state?.project : state?.global) });
    } else if (selected === 1) {
      const next = { ...draft };
      if (project && draft.enabled === true) delete next.enabled;
      else next.enabled = draft.enabled === undefined ? false : !draft.enabled;
      setDraft(next);
    } else if (selected <= fields.length) {
      setInput(
        String(
          draft[fields[selected - 1]!] ??
            state?.global[fields[selected - 1]!] ??
            "",
        ),
      );
      setEditing(true);
    } else save();
  };
  useUiKeyboard((key) => {
    if (!active || !focused) return;
    if (
      key.name === "escape" ||
      key.name === "tab" ||
      key.name === "f2" ||
      (key.ctrl && key.name === "s")
    )
      return;
    if (editing) return;
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setSelected((index) =>
        Math.max(
          0,
          Math.min(fields.length + 1, index + (key.name === "up" ? -1 : 1)),
        ),
      );
    } else if (key.name === "return") {
      key.preventDefault();
      try {
        activate();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    }
  });
  useLayoutEffect(() => {
    if (!editing)
      body.current?.scrollChildIntoView(`background-setting-${selected}`);
  }, [selected, editing]);
  if (!state)
    return <text fg={palette.muted}>{notice || "Загрузка настроек…"}</text>;
  if (editing)
    return (
      <box height={height} flexDirection="column">
        <text height={1} fg={palette.text}>
          {names[selected - 1]}
        </text>
        <input
          id="background-setting-input"
          value={input}
          onInput={setInput}
          onSubmit={accept}
          focused={active && focused}
          backgroundColor={palette.raised}
          focusedBackgroundColor={palette.raised}
          textColor={palette.text}
          focusedTextColor={palette.text}
        />
        <text fg={palette.yellow}>{notice}</text>
        <text fg={palette.muted}>Enter — принять · Esc — назад</text>
      </box>
    );
  return (
    <box width={width} height={height} flexDirection="column">
      <TerminalScrollbox ref={body} flexGrow={1} minHeight={1} viewportCulling>
        {[
          `${project ? "Этот проект" : "Все проекты"} · изменить область`,
          ...names.map(
            (name, index) =>
              `${name}: ${index === 0 ? (draft.enabled === undefined ? "наследовать" : draft.enabled ? "включены" : "выключены") : (draft[fields[index]!] ?? "наследовать")}`,
          ),
          busy ? "Сохранение…" : "Сохранить (Ctrl+S)",
        ].map((label, index) => (
          <DialogAction
            key={label}
            id={`background-setting-${index}`}
            label={label}
            active={selected === index && focused}
            palette={palette}
            onSelect={() => {
              setSelected(index);
              if (index === 0) {
                if (!dirty) {
                  setProject(!project);
                  setDraft({ ...(!project ? state.project : state.global) });
                }
              } else if (index === 1) {
                const next = { ...draft };
                if (project && draft.enabled === true) delete next.enabled;
                else
                  next.enabled =
                    draft.enabled === undefined ? false : !draft.enabled;
                setDraft(next);
              } else if (index <= fields.length) {
                setInput(
                  String(
                    draft[fields[index - 1]!] ??
                      state.global[fields[index - 1]!],
                  ),
                );
                setEditing(true);
              } else {
                try {
                  save();
                } catch (error) {
                  setNotice(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }
            }}
          />
        ))}
        <text fg={palette.muted}>
          Только обычные разрешения shell. Проект может отключать и сужать
          лимиты. Приложение: 4 процесса; очередь: 8; проверка: 10 минут,
          сервис: 1 час; вывод: 16 MiB на задачу, 128 MiB на владельца;
          хранение: 100 результатов / 7 дней.
        </text>
      </TerminalScrollbox>
      <text fg={palette.yellow}>{notice}</text>
    </box>
  );
}
