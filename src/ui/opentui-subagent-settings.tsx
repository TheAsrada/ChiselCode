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
  ProjectSubagentConfigSchema,
  SubagentConfigSchema,
} from "../subagents/config.js";
import type {
  SubagentSettingsActions,
  SubagentSettingsState,
} from "../subagents/settings.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { useUiKeyboard } from "./overlay-input.js";
import type { SettingsPanelControl } from "./settings-panel.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
export function OpenTuiSubagentSettings({
  actions,
  palette,
  width,
  height,
  active,
  focused,
  controls,
  onDirty,
}: {
  actions: SubagentSettingsActions;
  palette: Palette;
  width: number;
  height: number;
  active: boolean;
  focused: boolean;
  controls: MutableRefObject<SettingsPanelControl | undefined>;
  onDirty: (value: boolean) => void;
}) {
  const [state, setState] = useState<SubagentSettingsState>();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [project, setProject] = useState(false);
  const [selected, setSelected] = useState(0);
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
  const fields = ["enabled"] as const;
  const names = ["Помощники"];
  const save = () => {
    if (!state || busy) return;
    const validated = project
      ? ProjectSubagentConfigSchema.parse(draft)
      : SubagentConfigSchema.parse(draft);
    setBusy(true);
    void (
      project
        ? actions.saveProject(validated, state.projectRevision)
        : actions.saveGlobal(
            SubagentConfigSchema.parse(validated),
            state.globalRevision,
          )
    )
      .then((value) => {
        if (alive.current) {
          setState(value);
          setDraft({ ...(project ? value.project : value.global) });
          setNotice(
            "Сохранено. Отключение останавливает задачи, сохраняя копии.",
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
      back: () => false,
      discard,
    };
    return () => {
      controls.current = undefined;
    };
  });
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
    body.current?.scrollChildIntoView(`subagent-setting-${selected}`);
  }, [selected]);
  if (!state)
    return <text fg={palette.muted}>{notice || "Загрузка настроек…"}</text>;
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
            id={`subagent-setting-${index}`}
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
          Чтение — исходный проект. Изменения — отдельная рабочая копия, перенос
          только явно. Shell работает на host; это не sandbox.
        </text>
        <text fg={palette.muted}>
          Без квот на ходы, инструменты, время, число задач и параллельность.
          Контекст и ответ определяются моделью. Остановить помощника можно в
          панели задач. Цена без тарифа неизвестна.
        </text>
      </TerminalScrollbox>
      <text height={1} fg={notice ? palette.yellow : palette.muted}>
        {notice || "↑↓ Enter · Ctrl+S сохранить · Esc назад"}
      </text>
    </box>
  );
}
