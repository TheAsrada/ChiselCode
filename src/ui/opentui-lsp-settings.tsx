/** @jsxImportSource @opentui/react */
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import {
  effectiveLspMode,
  globalLspMode,
  type LspConfig,
  type LspMode,
  type LspServerConfig,
  LspServerIdSchema,
  LspServerSchema,
  type ProjectLspConfig,
} from "../lsp/config.js";
import type { LspState } from "../lsp/service.js";
import type { LspSettingsActions, LspSettingsState } from "../lsp/settings.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { cleanSettingsInput } from "./opentui-settings-input.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";

export interface SettingsPanelControl {
  save(): void;
  back(): boolean;
  discard(): void;
}
interface ServerDraft {
  id: string;
  backend: "typescript" | "generic";
  languages: string;
  extensions: string;
  initialization: string;
  settings: string;
  node: string;
  server: string;
  typescript: string;
  enabled: boolean;
  args: string;
  trustedWorkspaces: string[];
}
const newDraft = (): ServerDraft => ({
  id: "typescript",
  backend: "typescript",
  languages: "",
  extensions: "",
  initialization: "{}",
  settings: "{}",
  node: "",
  server: "",
  typescript: "",
  enabled: true,
  args: "",
  trustedWorkspaces: [],
});
function draftConfig(draft: ServerDraft): LspServerConfig {
  const common = {
    enabled: draft.enabled,
    command: draft.node,
    trustedWorkspaces: [...draft.trustedWorkspaces],
  };
  const args = draft.args.split("\n").filter((arg) => arg.trim().length > 0);
  return LspServerSchema.parse(
    draft.backend === "typescript"
      ? {
          ...common,
          backend: "typescript",
          args: [draft.server, "--stdio", ...args],
          typescriptPath: draft.typescript,
        }
      : {
          ...common,
          backend: "generic",
          args,
          languageIds: draft.languages.split(/[\s,]+/).filter(Boolean),
          extensions: draft.extensions.split(/[\s,]+/).filter(Boolean),
          initializationOptions: JSON.parse(draft.initialization || "{}"),
          settings: JSON.parse(draft.settings || "{}"),
        },
  );
}
export const LSP_STATE_LABELS: Record<LspState, string> = {
  disabled: "Выключен",
  untrusted: "Нет разрешения для проекта",
  unavailable: "Не настроен / не найден",
  stopped: "Остановлен",
  starting: "Запускается",
  ready: "Готов",
  restarting: "Перезапускается",
  error: "Ошибка",
  disposed: "Workspace закрыт",
};

export function OpenTuiLspSettings({
  actions,
  palette,
  width,
  height,
  active,
  focused,
  fieldTarget,
  onFieldTargetHandled,
  controls,
  onDirty,
}: {
  actions: LspSettingsActions;
  palette: Palette;
  width: number;
  height: number;
  active: boolean;
  focused: boolean;
  fieldTarget?: string;
  onFieldTargetHandled?(): void;
  controls: MutableRefObject<SettingsPanelControl | undefined>;
  onDirty(dirty: boolean): void;
}) {
  const [state, setState] = useState<LspSettingsState>();
  const [global, setGlobal] = useState<LspConfig>({ servers: {} });
  const [project, setProject] = useState<ProjectLspConfig>({});
  const [scope, setScope] = useState<"global" | "project">("global");
  const [draft, setDraft] = useState<ServerDraft>();
  const [originalId, setOriginalId] = useState<string>();
  const [selected, setSelectedState] = useState(0);
  const selectedRef = useRef(0);
  const select = (value: number) => {
    selectedRef.current = value;
    setSelectedState(value);
  };
  const [editing, setEditing] = useState<keyof ServerDraft>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [details, setDetails] = useState(false);
  const alive = useRef(true);
  const work = useRef<AbortController | undefined>(undefined);
  const working = useRef(false);
  const argsEditor = useRef<TextareaRenderable>(null);
  const baseline = useRef({ global: "", project: "" });
  const baselineDraft = useRef("");
  const dirty =
    JSON.stringify(global) !== baseline.current.global ||
    JSON.stringify(project) !== baseline.current.project ||
    (!!draft && JSON.stringify(draft) !== baselineDraft.current) ||
    (editing !== undefined && text !== String(draft?.[editing] ?? ""));
  const apply = (
    next: LspSettingsState,
    reset: "all" | "global" | "project" | false = "all",
  ) => {
    if (!reset) {
      setState((current) =>
        current ? { ...current, status: next.status } : next,
      );
      return;
    }
    setState((current) =>
      !current || reset === "all"
        ? next
        : reset === "global"
          ? {
              ...current,
              global: next.global,
              globalRevision: next.globalRevision,
              status: next.status,
            }
          : {
              ...current,
              project: next.project,
              projectRevision: next.projectRevision,
              status: next.status,
            },
    );
    if (reset === "all" || reset === "global") {
      setGlobal(next.global);
      baseline.current.global = JSON.stringify(next.global);
    }
    if (reset === "all" || reset === "project") {
      setProject(next.project);
      baseline.current.project = JSON.stringify(next.project);
    }
  };
  const run = (operation: (signal: AbortSignal) => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    const controller = new AbortController();
    work.current = controller;
    setBusy(true);
    setNotice("");
    void operation(controller.signal)
      .catch((error) => {
        if (alive.current && !controller.signal.aborted)
          setNotice(
            terminalSafeText(
              error instanceof Error
                ? error.message
                : "Не удалось выполнить действие.",
              600,
            ),
          );
      })
      .finally(() => {
        working.current = false;
        if (work.current === controller) work.current = undefined;
        if (alive.current) setBusy(false);
      });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: One captured workspace/action set per Settings dialog.
  useEffect(() => {
    alive.current = true;
    run(async (signal) => {
      const next = await actions.load(signal);
      if (alive.current && !signal.aborted) apply(next);
    });
    return () => {
      alive.current = false;
      work.current?.abort();
    };
  }, [actions]);
  useEffect(() => {
    onDirty(!!state && dirty);
  }, [dirty, state, onDirty]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Read status only; never overwrite unsaved form fields.
  useEffect(() => {
    if (!active) {
      if (state) work.current?.abort();
      return;
    }
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (working.current) return;
      void actions
        .load(controller.signal)
        .then((next) => {
          if (alive.current && !controller.signal.aborted)
            setState((current) =>
              current ? { ...current, status: next.status } : next,
            );
        })
        .catch(() => {});
    }, 1500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [active, actions]);
  const editServer = (
    id?: string,
    backend: "typescript" | "generic" = "typescript",
  ) => {
    const server = id ? global.servers[id] : undefined;
    const next = server
      ? {
          id: id ?? "",
          backend: server.backend,
          languages:
            server.backend === "generic" ? server.languageIds.join(", ") : "",
          extensions:
            server.backend === "generic" ? server.extensions.join(", ") : "",
          initialization: JSON.stringify(
            server.backend === "generic"
              ? (server.initializationOptions ?? {})
              : {},
            null,
            2,
          ),
          settings: JSON.stringify(
            server.backend === "generic" ? (server.settings ?? {}) : {},
            null,
            2,
          ),
          node: server.command,
          server: server.args[0] ?? "",
          typescript:
            server.backend === "typescript" ? server.typescriptPath : "",
          enabled: server.enabled,
          args: (server.backend === "typescript"
            ? server.args.slice(2)
            : server.args
          ).join("\n"),
          trustedWorkspaces: [...server.trustedWorkspaces],
        }
      : {
          ...newDraft(),
          backend,
          id: backend === "generic" ? "custom" : "typescript",
        };
    if (!server) {
      let suffix = 1;
      while (global.servers[next.id])
        next.id = `${backend === "generic" ? "custom" : "typescript"}-${suffix++}`;
    }
    setDraft(next);
    setOriginalId(id);
    baselineDraft.current = server ? JSON.stringify(next) : "";
    select(0);
    setNotice("");
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Deep links focus a field when the explicit target changes.
  useEffect(() => {
    if (!fieldTarget || !active || !state) return;
    // Deep links are one-shot user navigation, not actions to replay when an
    // approval overlay returns focus to this already configured panel.
    onFieldTargetHandled?.();
    if (fieldTarget === "mode" || fieldTarget === "project") {
      setScope(fieldTarget === "project" ? "project" : "global");
      if (fieldTarget === "mode" && draft) {
        if (dirty) {
          setNotice(
            "Сохраните или сбросьте черновик своего сервера перед сменой режима.",
          );
          return;
        }
        setDraft(undefined);
      }
      select(0);
      return;
    }
    if (globalLspMode(global) !== "custom")
      setGlobal({ ...global, mode: "custom" });
    if (!draft) editServer(Object.keys(global.servers).sort()[0]);
    const index = [
      "id",
      "node",
      "server",
      "typescript",
      "enabled",
      "args",
      "trust",
    ].indexOf(fieldTarget);
    select(Math.max(0, index));
  }, [fieldTarget, active, !!state]);
  const accepted = (): ServerDraft | undefined => {
    if (!draft) return;
    const next = editing ? { ...draft, [editing]: text } : draft;
    setDraft(next);
    setEditing(undefined);
    return next;
  };
  const save = () => {
    if (!state) return;
    const nextDraft = accepted();
    run(async (signal) => {
      if (scope === "project") {
        const next = await actions.saveProject(project, state.projectRevision);
        if (alive.current && !signal.aborted) {
          apply(next, "project");
          setNotice(
            "Настройки этого проекта сохранены. Запуск — отдельное действие.",
          );
        }
      } else {
        const nextGlobal = structuredClone(global);
        if (nextDraft) {
          const id = LspServerIdSchema.parse(nextDraft.id);
          if (id !== originalId && nextGlobal.servers[id])
            throw new Error("Server ID уже существует. Выберите другое имя.");
          const server = draftConfig(nextDraft);
          if (originalId && originalId !== id)
            delete nextGlobal.servers[originalId];
          nextGlobal.servers[id] = server;
        }
        const next = await actions.saveGlobal(nextGlobal, state.globalRevision);
        if (alive.current && !signal.aborted) {
          apply(next, "global");
          setNotice(
            globalLspMode(next.global) === "auto"
              ? "Сохранено. Auto запустится при первом LSP запросе."
              : globalLspMode(next.global) === "off"
                ? "Сохранено. Анализ выключен; активные серверы закрыты."
                : "Сохранено. Для своих исполняемых файлов нужно доверие проекта.",
          );
          if (nextDraft) {
            setOriginalId(nextDraft.id);
            baselineDraft.current = JSON.stringify(nextDraft);
          }
        }
      }
    });
  };
  const discard = () => {
    if (state) {
      setGlobal(state.global);
      setProject(state.project);
      baseline.current = {
        global: JSON.stringify(state.global),
        project: JSON.stringify(state.project),
      };
    }
    setDraft(undefined);
    setEditing(undefined);
    setNotice("");
    select(0);
  };
  controls.current = {
    save,
    discard,
    back: () => {
      if (editing) {
        setEditing(undefined);
        return true;
      }
      if (draft) {
        if (dirty) {
          setNotice(
            "Есть несохранённые изменения. Ctrl+S сохранить; Esc в Settings для выбора сброса.",
          );
          return false;
        }
        setDraft(undefined);
        select(0);
        return true;
      }
      return false;
    },
  };
  const start = (serverId?: string) => {
    if (dirty) {
      setNotice(
        "Сохраните изменения LSP перед запуском. Global и project формы сохраняются отдельно.",
      );
      return;
    }
    run(async (signal) => {
      const result = await actions.restart(serverId);
      if (!alive.current || signal.aborted) return;
      const next = await actions.load(signal);
      apply(next, false);
      setNotice(
        result.isError || result.requiresApproval
          ? terminalSafeText(result.output, 600)
          : next.status.state === "ready"
            ? "[ok] Сервер готов после initialize. Перезапуск затронул все вкладки проекта."
            : "Сервер не готов; проверьте состояние.",
      );
    });
  };
  const trust = (id: string) => {
    if (dirty) {
      setNotice(
        "Сохраните изменения LSP перед изменением доверия. Global и project формы сохраняются отдельно.",
      );
      return;
    }
    run(async (signal) => {
      const allowed = !state?.global.servers[id]?.trustedWorkspaces.includes(
        state.workspaceRoot,
      );
      const next = await actions.trust(id, allowed);
      if (!alive.current || signal.aborted) return;
      apply(next);
      if (draft?.id === id && next.global.servers[id]) {
        const value = {
          ...draft,
          trustedWorkspaces: next.global.servers[id]?.trustedWorkspaces ?? [],
        };
        setDraft(value);
        baselineDraft.current = JSON.stringify(value);
      }
      setNotice(
        allowed
          ? "Разрешён только этот canonical root. Сервер пока не запущен."
          : "Доверие отозвано; запросы заблокированы, процесс закрыт.",
      );
    });
  };
  const check = () => {
    const value = accepted();
    if (!value) return;
    run(async (signal) => {
      const message = await actions.check(value.id, draftConfig(value), signal);
      if (alive.current && !signal.aborted) setNotice(message);
    });
  };
  const entries = Object.entries(global.servers).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const projectServerId =
    project.serverId ??
    (state?.status.serverId !== "auto" ? state?.status.serverId : undefined) ??
    entries[0]?.[0];
  const selectedId =
    scope === "project" ? projectServerId : (draft?.id ?? projectServerId);
  const mode = globalLspMode(global);
  const projectMode = effectiveLspMode({ global, project, ignorePatterns: [] });
  const modeLabels: Record<LspMode, string> = {
    auto: "Auto",
    custom: "Своя настройка",
    off: "Выключено",
  };
  const modes = (["auto", "custom", "off"] as const).map((value) => ({
    id: `mode-${value}`,
    label: `${mode === value ? "[x]" : "[ ]"} ${modeLabels[value]}`,
    value:
      value === "auto"
        ? "Язык и проект автоматически · подготовка при первом запросе"
        : value === "custom"
          ? "Свой установленный сервер · явное доверие"
          : "Не запускать анализ кода",
    activate() {
      setGlobal({ ...global, mode: value });
    },
  }));
  const rows: { id: string; label: string; value: string; activate(): void }[] =
    scope === "project"
      ? [
          {
            id: "mode",
            label: "Режим проекта",
            value:
              project.enabled === false
                ? "Выключено"
                : project.mode
                  ? modeLabels[project.mode]
                  : project.serverId
                    ? "Своя настройка"
                    : `Наследовать · ${modeLabels[mode]}`,
            activate() {
              const choices = ["inherit", "auto", "custom", "off"] as const;
              const current =
                project.enabled === false
                  ? "off"
                  : (project.mode ?? (project.serverId ? "custom" : "inherit"));
              const next =
                choices[(choices.indexOf(current) + 1) % choices.length];
              setProject(
                next === "inherit"
                  ? {}
                  : {
                      mode: next,
                      ...(next === "custom" && project.serverId
                        ? { serverId: project.serverId }
                        : {}),
                    },
              );
            },
          },
          ...(projectMode === "custom"
            ? [
                {
                  id: "selection",
                  label: "Сервер проекта",
                  value:
                    project.enabled === false
                      ? "Выключен"
                      : project.serverId
                        ? `${project.serverId} · выбор проекта`
                        : `Наследовать · ${state?.status.serverId ?? "не выбран"} (global)`,
                  activate() {
                    const choices = ["inherit", ...entries.map(([id]) => id)];
                    const current =
                      project.enabled === false
                        ? "disabled"
                        : (project.serverId ?? "inherit");
                    const next =
                      choices[(choices.indexOf(current) + 1) % choices.length];
                    setProject(
                      next === "inherit"
                        ? { mode: "custom" }
                        : { mode: "custom", serverId: next },
                    );
                  },
                },
              ]
            : []),
          ...(projectMode === "custom"
            ? [
                {
                  id: "trust",
                  label: "Разрешение проекта",
                  value:
                    selectedId &&
                    state?.global.servers[
                      selectedId
                    ]?.trustedWorkspaces.includes(state.workspaceRoot)
                      ? "Разрешён точный root"
                      : "Нет разрешения",
                  activate() {
                    if (selectedId) trust(selectedId);
                    else
                      setNotice(
                        "Сначала настройте и сохраните глобальный сервер.",
                      );
                  },
                },
              ]
            : []),
          ...(projectMode !== "off"
            ? [
                {
                  id: "start",
                  label:
                    state?.status.state === "ready"
                      ? "Перезапустить"
                      : "Запустить",
                  value: "Общие tools, очередь и разрешения",
                  activate() {
                    start(
                      projectMode === "auto" ? undefined : project.serverId,
                    );
                  },
                },
              ]
            : []),
        ]
      : draft
        ? [
            ...(
              [
                ["id", "Server ID"],
                [
                  "node",
                  draft.backend === "generic" ? "Исполняемый файл" : "Node.js",
                ],
                ...(draft.backend === "typescript"
                  ? ([
                      ["server", "Language server"],
                      ["typescript", "TypeScript"],
                    ] as const)
                  : ([
                      ["languages", "Language IDs (через запятую)"],
                      ["extensions", "Дополнительные расширения (.foo)"],
                    ] as const)),
              ] as const
            ).map(([id, label]) => ({
              id,
              label,
              value: String(draft[id]) || "Не задано",
              activate() {
                setEditing(id);
                setText(String(draft[id]));
              },
            })),
            {
              id: "enabled",
              label: "Включён",
              value: draft.enabled ? "[x] Да" : "[ ] Нет",
              activate() {
                setDraft({ ...draft, enabled: !draft.enabled });
              },
            },
            {
              id: "args",
              label: "Дополнительные параметры",
              value: draft.args
                ? `${draft.args.split("\n").length} argv строк`
                : draft.backend === "typescript"
                  ? "Пресет: --stdio"
                  : "Пустой argv · без shell",
              activate() {
                setEditing("args");
                setText(draft.args);
              },
            },
            ...(draft.backend === "generic"
              ? (["initialization", "settings"] as const).map((id) => ({
                  id,
                  label:
                    id === "initialization"
                      ? "Initialization options (JSON)"
                      : "Server settings (JSON)",
                  value: "Расширенные параметры · 64 KiB · без credentials",
                  activate() {
                    setEditing(id);
                    setText(draft[id]);
                  },
                }))
              : []),
            {
              id: "trust",
              label: "Разрешить этот проект / отозвать",
              value: draft.trustedWorkspaces.includes(
                state?.workspaceRoot ?? "",
              )
                ? "Точный root разрешён"
                : "Отдельное явное разрешение",
              activate() {
                if (originalId && originalId === draft.id) trust(draft.id);
                else
                  setNotice(
                    "Сначала сохраните сервер, затем явно разрешите проект.",
                  );
              },
            },
            ...draft.trustedWorkspaces.map((root, index) => ({
              id: `trusted-root-${index}`,
              label: "Удалить доверие проекта",
              value: root,
              activate() {
                setDraft({
                  ...draft,
                  trustedWorkspaces: draft.trustedWorkspaces.filter(
                    (value) => value !== root,
                  ),
                });
                setNotice(
                  "Доверие будет отозвано после сохранения. Ctrl+S остановит сервер этого проекта.",
                );
              },
            })),
            {
              id: "check",
              label: "Проверить пути",
              value: "Только filesystem, без запуска",
              activate: check,
            },
            {
              id: "start",
              label:
                state?.status.state === "ready" ? "Перезапустить" : "Запустить",
              value: "После сохранения и разрешения",
              activate() {
                if (dirty) setNotice("Сохраните draft перед запуском.");
                else start(draft.id);
              },
            },
            {
              id: "delete",
              label: "Удалить сервер",
              value: "Применяется после Ctrl+S",
              activate() {
                if (originalId) {
                  const next = structuredClone(global);
                  delete next.servers[originalId];
                  setGlobal(next);
                  setDraft(undefined);
                  select(0);
                } else discard();
              },
            },
          ]
        : [
            ...modes,
            ...(mode === "auto"
              ? [
                  {
                    id: "start",
                    label:
                      state?.status.state === "ready"
                        ? "Перезапустить"
                        : "Запустить сейчас",
                    value:
                      "Обычно запускается сам при анализе · обычные разрешения",
                    activate() {
                      start();
                    },
                  },
                ]
              : []),
            ...(mode === "auto"
              ? (state?.status.catalog ?? []).map((item) => ({
                  id: item.id,
                  label: item.title,
                  value: `${item.version} · ${item.platformAvailable === false ? "Нет Auto пакета для этой ОС/CPU · своя настройка" : (item.prerequisites ?? "Готовится автоматически")}`,
                  activate() {
                    setNotice(
                      `${item.title}: ${item.languages.join(", ")}. ${item.prerequisites ?? "Сервер готовится при первом запросе; сохранение ничего не запускает."}`,
                    );
                  },
                }))
              : []),
            ...(mode === "custom"
              ? [
                  ...entries.map(([id, server]) => ({
                    id,
                    label: id,
                    value: `${server.backend === "generic" ? server.languageIds.join(", ") : "TypeScript/JavaScript"} · ${server.enabled ? "включён" : "выключен"}`,
                    activate() {
                      editServer(id);
                    },
                  })),
                  {
                    id: "add-generic",
                    label: "Подключить совместимый LSP",
                    value: "Любой язык · stdio · свой executable и argv",
                    activate() {
                      editServer(undefined, "generic");
                    },
                  },
                  {
                    id: "add",
                    label: "Добавить TypeScript/JavaScript",
                    value: "Отдельно установленный сервер",
                    activate() {
                      editServer();
                    },
                  },
                ]
              : []),
            {
              id: "details",
              label: "Технические детали",
              value: details ? "Скрыть" : "Показать",
              activate() {
                setDetails(!details);
              },
            },
          ];
  useKeyboard((key) => {
    if (
      !active ||
      !focused ||
      working.current ||
      (key.ctrl && key.name === "c")
    )
      return;
    if (
      key.name === "escape" ||
      key.name === "tab" ||
      (key.ctrl && ["s", "f"].includes(key.name)) ||
      key.name === "f2"
    )
      return;
    if (editing) return;
    if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
      key.preventDefault();
      const delta =
        key.name === "up"
          ? -1
          : key.name === "down"
            ? 1
            : key.name === "pageup"
              ? -Math.max(1, height - 5)
              : Math.max(1, height - 5);
      select(
        Math.max(0, Math.min(rows.length - 1, selectedRef.current + delta)),
      );
    } else if (key.name === "return" || key.name === "space") {
      key.preventDefault();
      rows[selectedRef.current]?.activate();
    }
  });
  const compact = height < 9;
  const displayRows = Math.max(
    1,
    height - (compact ? 3 : 6) - (notice ? 1 : 0),
  );
  const first = Math.max(
    0,
    Math.min(selected - displayRows + 1, rows.length - displayRows),
  );
  return (
    <box width="100%" height="100%" flexDirection="column" overflow="hidden">
      {!editing && (
        <box height={1} flexShrink={0} flexDirection="row" gap={1}>
          <DialogAction
            id="lsp-global"
            label="Все проекты"
            active={scope === "global"}
            palette={palette}
            onSelect={() => {
              setScope("global");
              select(0);
            }}
          />
          <DialogAction
            id="lsp-project"
            label="Этот проект"
            active={scope === "project"}
            palette={palette}
            onSelect={() => {
              setScope("project");
              select(0);
            }}
          />
        </box>
      )}
      {!compact && !editing && (
        <text height={1} fg={palette.muted}>
          {terminalLine(state?.workspaceRoot ?? "Загрузка…", width)}
        </text>
      )}
      {!editing && (
        <text
          height={1}
          flexShrink={0}
          fg={state?.status.state === "ready" ? palette.green : palette.yellow}
        >
          {terminalLine(
            `${state?.status.state === "ready" ? "[ok]" : "[i]"} ${state?.status.requiresRestart ? "Нужен перезапуск" : state?.status.state === "stopped" && state.status.mode === "auto" ? "Ждёт запроса анализа" : LSP_STATE_LABELS[state?.status.state ?? "stopped"]} · ${modeLabels[state?.status.mode ?? projectMode]}${dirty ? " · draft *" : ""}`,
            width,
          )}
        </text>
      )}
      {editing ? (
        <box flexGrow={1} minHeight={1} flexDirection="column">
          <text height={1} fg={palette.accent}>
            {editing === "args"
              ? "Аргументы: одна строка = argv"
              : rows.find((row) => row.id === editing)?.label}
          </text>
          {["args", "initialization", "settings"].includes(editing) ? (
            <textarea
              id={`lsp-field-${editing}`}
              ref={argsEditor}
              initialValue={text}
              focused={active && focused}
              height={Math.max(1, height - 3)}
              backgroundColor={palette.raised}
              textColor={palette.text}
              onContentChange={() =>
                setText(argsEditor.current?.plainText ?? "")
              }
            />
          ) : (
            <input
              id={`lsp-field-${editing}`}
              value={text}
              focused={active && focused}
              maxLength={editing === "id" ? 64 : 4096}
              width="100%"
              backgroundColor={palette.raised}
              focusedBackgroundColor={palette.raised}
              textColor={palette.text}
              focusedTextColor={palette.text}
              onInput={(value) => setText(cleanSettingsInput(value))}
              onSubmit={accepted}
            />
          )}
          <DialogAction
            id="lsp-field-done"
            label="Готово (Enter)"
            palette={palette}
            onSelect={accepted}
          />
        </box>
      ) : (
        <box
          flexGrow={1}
          minHeight={1}
          flexDirection="column"
          onMouseScroll={(event) => {
            event.stopPropagation();
            const direction = event.scroll?.direction;
            if (direction === "up" || direction === "down")
              select(
                Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    selectedRef.current + (direction === "up" ? -1 : 1),
                  ),
                ),
              );
          }}
        >
          {rows.slice(first, first + displayRows).map((row, offset) => (
            <DialogAction
              key={row.id}
              id={`lsp-row-${row.id}`}
              label={terminalLine(
                `${first + offset === selected ? "> " : "  "}${row.label}${width > 55 ? ` · ${row.value}` : ""}`,
                width,
              )}
              active={focused && first + offset === selected}
              palette={palette}
              disabled={busy}
              onSelect={() => {
                select(first + offset);
                row.activate();
              }}
            />
          ))}
          {details && !compact && (
            <text fg={palette.muted}>
              {terminalLine(
                `server ${state?.status.versions?.server ?? "?"}${state?.status.versions?.typescript ? `; TS ${state.status.versions.typescript}` : ""}; ${state?.status.versions?.runtime ?? "?"}; generation ${state?.status.generation ?? 0}; documents ${state?.status.trackedDocuments ?? 0}`,
                width,
              )}
            </text>
          )}
        </box>
      )}
      {!compact && !editing && (
        <text height={1} fg={palette.muted}>
          {terminalLine(
            state?.status.reason ??
              (draft
                ? (rows[selected]?.value ?? "")
                : scope === "project" && projectMode === "auto"
                  ? "Auto не требует доверия каждому проекту. Свои исполняемые файлы — требуют."
                  : mode === "auto"
                    ? "Сервер и SDK готовятся по запросу. Неизвестный язык — своя настройка."
                    : mode === "off"
                      ? "Серверы остановлены. Чтобы вернуть анализ, выберите Auto."
                      : "Совместимый stdio LSP: executable, argv, языки и доверие проекта."),
            width,
          )}
        </text>
      )}
      {notice && (
        <text height={1} flexShrink={0} fg={palette.yellow}>
          {terminalLine(notice, width)}
        </text>
      )}
      {!editing && (
        <DialogAction
          id="lsp-save"
          label={busy ? "Выполняется…" : "Сохранить (Ctrl+S / F2)"}
          primary
          palette={palette}
          disabled={busy || !state}
          onSelect={save}
        />
      )}
    </box>
  );
}
