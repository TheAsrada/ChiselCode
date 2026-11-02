/** @jsxImportSource @opentui/react */

import type { TextareaRenderable } from "@opentui/core";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import {
  globalLspMode,
  type LspConfig,
  type LspServerConfig,
  LspServerIdSchema,
  LspServerSchema,
  type ProjectLspConfig,
} from "../lsp/config.js";
import type { LspState } from "../lsp/service.js";
import type {
  LspManagedServer,
  LspSettingsActions,
  LspSettingsState,
} from "../lsp/settings.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { cleanSettingsInput } from "./opentui-settings-input.js";
import { useUiKeyboard } from "./overlay-input.js";
import type { SettingsPanelControl } from "./settings-panel.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";

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
  stopped: "Ждёт запроса",
  starting: "Запускается",
  ready: "Работает",
  restarting: "Перезапускается",
  error: "Ошибка",
  disposed: "Workspace закрыт",
};

type MenuScreen = "overview" | "card" | "strategy" | "form";
interface MenuRow {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  toggle?(): void;
  activate(): void;
}
const freshnessLabel = {
  pending: "Нет результатов проверки · ожидается ответ",
  current: "Подтверждённый результат",
  observed: "Наблюдаемые данные · актуальность не подтверждена",
  stale: "Данные устарели",
  unavailable: "Результат недоступен",
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
  onChooseProject,
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
  onChooseProject?(): void;
}) {
  const [state, setState] = useState<LspSettingsState>();
  const [global, setGlobal] = useState<LspConfig>({ servers: {} });
  const [project, setProject] = useState<ProjectLspConfig>({});
  const [scope, setScope] = useState<"global" | "project">("project");
  const [screen, setScreen] = useState<MenuScreen>("overview");
  const [cardId, setCardId] = useState<string>();
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [draft, setDraft] = useState<ServerDraft>();
  const [originalId, setOriginalId] = useState<string>();
  const formOriginCard = useRef<string | undefined>(undefined);
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const listSelection = useRef(0);
  const select = (value: number) => {
    selectedRef.current = value;
    setSelected(value);
  };
  const navigate = (next: MenuScreen) => {
    if (screen === "overview") listSelection.current = selectedRef.current;
    setScreen(next);
    select(next === "overview" ? listSelection.current : 0);
  };
  const [editing, setEditing] = useState<keyof ServerDraft>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [details, setDetails] = useState(false);
  const alive = useRef(true);
  const working = useRef(false);
  const work = useRef<AbortController | undefined>(undefined);
  const argsEditor = useRef<TextareaRenderable>(null);
  const baseline = useRef({ global: "", project: "" });
  const baselineDraft = useRef("");
  const dirty =
    JSON.stringify(global) !== baseline.current.global ||
    JSON.stringify(project) !== baseline.current.project ||
    (!!draft && JSON.stringify(draft) !== baselineDraft.current) ||
    (editing !== undefined && text !== String(draft?.[editing] ?? ""));
  const apply = (next: LspSettingsState, refresh = true) => {
    setState(next);
    if (refresh) {
      setGlobal(next.global);
      setProject(next.project);
      baseline.current = {
        global: JSON.stringify(next.global),
        project: JSON.stringify(next.project),
      };
    }
  };
  const run = (operation: (signal: AbortSignal) => Promise<void>) => {
    if (working.current) return;
    const controller = new AbortController();
    working.current = true;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: One captured workspace per menu; subscriptions never replace drafts.
  useEffect(() => {
    alive.current = true;
    run(async (signal) => {
      const next = await actions.load(signal);
      if (!alive.current || signal.aborted) return;
      apply(next);
      setScope(next.workspaceRoot ? "project" : "global");
    });
    return () => {
      alive.current = false;
      work.current?.abort();
    };
  }, [actions]);
  useEffect(() => {
    onDirty(!!state && dirty);
  }, [state, dirty, onDirty]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runtime evidence updates independently of the editable baseline.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let loading = false;
    let again = false;
    const refresh = () => {
      if (working.current || loading) {
        again = true;
        return;
      }
      loading = true;
      void actions
        .load(controller.signal)
        .then((next) => {
          if (alive.current && !controller.signal.aborted)
            setState((current) =>
              current
                ? {
                    ...current,
                    status: next.status,
                    management: next.management,
                    applicationError: next.applicationError,
                  }
                : next,
            );
        })
        .catch(() => {})
        .finally(() => {
          loading = false;
          if (again && !controller.signal.aborted) {
            again = false;
            refresh();
          }
        });
    };
    const subscription = actions.subscribe?.(refresh);
    refresh();
    return () => {
      controller.abort();
      subscription?.dispose();
    };
  }, [active, actions, busy]);
  const accepted = () => {
    if (!draft) return;
    const next = editing ? { ...draft, [editing]: text } : draft;
    setDraft(next);
    setEditing(undefined);
    return next;
  };
  const quick = (operation: () => Promise<LspSettingsState>) => {
    run(async (signal) => {
      const next = await operation();
      if (!alive.current || signal.aborted) return;
      // Quick patches own no executable/argv fields. Keep the independent form intact.
      apply(next);
      if (
        cardId &&
        !next.management?.[scope].servers.some((server) => server.id === cardId)
      ) {
        setCardId(undefined);
        navigate("overview");
      }
      setNotice(
        next.applicationError ??
          "Сохранено. Включённый сервер запускается при следующем запросе анализа.",
      );
    });
  };
  const editServer = (
    id?: string,
    backend: "typescript" | "generic" = "typescript",
  ) => {
    if (draft && dirty) {
      if (id !== originalId) {
        setNotice("Сначала сохраните или сбросьте черновик своего сервера.");
        return;
      }
      navigate("form");
      return;
    }
    const server = id ? global.servers[id] : undefined;
    const next: ServerDraft = server
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
    setCardId(id);
    formOriginCard.current = id;
    baselineDraft.current = server ? JSON.stringify(next) : "";
    navigate("form");
    setNotice("");
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: A one-shot Settings deep link must preserve the form.
  useEffect(() => {
    if (!fieldTarget || !active || !state) return;
    onFieldTargetHandled?.();
    if (["mode", "project", "enabled", "servers"].includes(fieldTarget)) {
      if (fieldTarget === "project" && state.workspaceRoot) setScope("project");
      if (fieldTarget === "servers") setAll(true);
      navigate(fieldTarget === "mode" ? "strategy" : "overview");
      return;
    }
    editServer(Object.keys(global.servers).sort()[0]);
    select(
      Math.max(
        0,
        [
          "id",
          "node",
          "server",
          "typescript",
          "enabled",
          "args",
          "trust",
        ].indexOf(fieldTarget),
      ),
    );
  }, [fieldTarget, active, !!state]);
  const save = () => {
    if (!state) return;
    if (screen !== "form" && draft) {
      navigate("form");
      setNotice("Сохранение относится к ручной форме. Проверьте черновик.");
      return;
    }
    const nextDraft = accepted();
    run(async (signal) => {
      const nextGlobal = structuredClone(global);
      nextGlobal.mode ??= globalLspMode(state.global);
      if (nextDraft) {
        const id = LspServerIdSchema.parse(nextDraft.id);
        if (id !== originalId && nextGlobal.servers[id])
          throw new Error("Server ID уже существует.");
        if (originalId && originalId !== id)
          delete nextGlobal.servers[originalId];
        nextGlobal.servers[id] = draftConfig(nextDraft);
      }
      const next = await actions.saveGlobal(nextGlobal, state.globalRevision);
      if (!alive.current || signal.aborted) return;
      apply(next);
      if (nextDraft) {
        setOriginalId(nextDraft.id);
        baselineDraft.current = JSON.stringify(nextDraft);
      }
      setNotice(
        next.applicationError ??
          "Сохранено. Для ручного сервера нужно отдельное доверие проекта.",
      );
    });
  };
  const discard = () => {
    if (state) apply(state);
    setDraft(undefined);
    setEditing(undefined);
    baselineDraft.current = "";
    navigate("overview");
    setNotice("");
  };
  const back = () => {
    if (searching) {
      setSearching(false);
      return true;
    }
    if (editing) {
      accepted();
      return true;
    }
    if (screen === "form") {
      setCardId(formOriginCard.current);
      navigate(formOriginCard.current ? "card" : "overview");
      return true;
    }
    if (screen !== "overview") {
      navigate("overview");
      return true;
    }
    return false;
  };
  controls.current = {
    save,
    discard,
    back,
    search: () => {
      accepted();
      setSearching(true);
    },
  };
  const start = (serverId?: string) => {
    run(async (signal) => {
      const result = await actions.restart(serverId);
      if (!alive.current || signal.aborted) return;
      const next = await actions.load(signal);
      if (!alive.current || signal.aborted) return;
      setState((current) =>
        current
          ? { ...current, status: next.status, management: next.management }
          : next,
      );
      setNotice(
        result.isError || result.requiresApproval
          ? terminalSafeText(result.output, 600)
          : "Сервер работает после initialize. Действие сохранено в истории инструментов.",
      );
    });
  };
  const trust = (id: string) => {
    if (!state?.workspaceRoot) {
      setNotice("Для доверия проекту выберите папку.");
      return;
    }
    if (dirty) {
      setNotice("Сначала сохраните ручную форму; доверие выдаётся отдельно.");
      return;
    }
    run(async (signal) => {
      const allowed = !state.global.servers[id]?.trustedWorkspaces.includes(
        state.workspaceRoot ?? "",
      );
      const next = await actions.trust(id, allowed);
      if (!alive.current || signal.aborted) return;
      apply(next);
      if (draft?.id === id) {
        const value = {
          ...draft,
          trustedWorkspaces: next.global.servers[id]?.trustedWorkspaces ?? [],
        };
        setDraft(value);
        baselineDraft.current = JSON.stringify(value);
      }
      setNotice(
        next.applicationError ??
          (allowed
            ? "Разрешён только этот canonical root. Сервер пока не запущен."
            : "Доверие отозвано; новые запросы запрещены."),
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
  const view = state?.management?.[scope];
  const card = view?.servers.find((server) => server.id === cardId);
  const toggleServer = (server: LspManagedServer) => {
    if (!state) return;
    quick(() =>
      actions.setServerEnabled(scope, server.id, !server.enabled, state),
    );
  };
  const overallToggle = () => {
    if (!state || !view) return;
    if (scope === "project" && view.globallyDisabled) {
      setScope("global");
      navigate("overview");
      setNotice("Анализ выключен для всех проектов. Измените общую настройку.");
      return;
    }
    quick(() => actions.setEnabled(scope, !view.enabled, state));
  };
  const refreshBaseline = () =>
    run(async (signal) => {
      const next = await actions.load(signal);
      if (!alive.current || signal.aborted) return;
      apply(next);
      setNotice(
        "Данные обновлены; черновик формы сохранён. Проверьте поля перед записью.",
      );
    });
  const summarize = (server: LspManagedServer) =>
    `${LSP_STATE_LABELS[server.state]}${server.instances.length > 1 ? ` · ${server.instances.length} корня, ошибок: ${server.instances.filter((instance) => instance.state === "error").length}` : ""}`;
  let rows: MenuRow[] = [];
  if (screen === "form" && draft) {
    rows = [
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
        label: "Разрешён по умолчанию",
        value: `${draft.enabled ? "[x] Да" : "[ ] Нет"} · без индивидуальных исключений`,
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
        value: draft.trustedWorkspaces.includes(state?.workspaceRoot ?? "")
          ? "Точный root разрешён"
          : "Отдельное явное разрешение",
        activate() {
          if (originalId && originalId === draft.id) trust(draft.id);
          else
            setNotice("Сначала сохраните сервер, затем явно разрешите проект.");
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
        label: state?.status.state === "ready" ? "Перезапустить" : "Запустить",
        value: state?.launchRestriction ?? "После сохранения и разрешения",
        disabled: !!state?.launchRestriction,
        activate() {
          if (dirty) setNotice("Сохраните draft перед запуском.");
          else start(draft.id);
        },
      },
      {
        id: "delete",
        label: "Удалить сервер",
        value: "Удалить сохранённую запись и её общее исключение",
        activate() {
          if (!originalId || !state) {
            discard();
            return;
          }
          run(async (signal) => {
            const nextGlobal = structuredClone(state.global);
            delete nextGlobal.servers[originalId];
            const next = await actions.saveGlobal(
              nextGlobal,
              state.globalRevision,
            );
            if (!alive.current || signal.aborted) return;
            apply(next);
            setDraft(undefined);
            setEditing(undefined);
            navigate("overview");
            setNotice(
              next.applicationError ??
                "Ручной сервер удалён. Проектные ссылки остаются видны как недоступные.",
            );
          });
        },
      },
    ];
  } else if (screen === "strategy") {
    rows = [
      ...(scope === "project"
        ? [
            {
              id: "mode-inherit",
              label: "Наследовать стратегию",
              value: "Общий выбор; отдельные переключатели сохраняются",
              activate: () =>
                state &&
                quick(() => actions.setStrategy(scope, undefined, state)),
            },
          ]
        : []),
      ...(["auto", "custom"] as const).map((mode) => ({
        id: `mode-${mode}`,
        label: `${view?.strategy === mode ? "[x]" : "[ ]"} ${mode === "auto" ? "Auto" : "Своя настройка"}`,
        value:
          mode === "auto"
            ? "Выбор по языку файла; запуск по запросу"
            : "Установленный вручную stdio LSP; точное доверие",
        activate: () =>
          state && quick(() => actions.setStrategy(scope, mode, state)),
      })),
      ...(scope === "project"
        ? Object.keys(global.servers).map((id) => ({
            id: `choose-${id}`,
            label: `Выбрать ${id}`,
            value: "Ручной сервер этого проекта; не выдаёт доверие",
            activate: () =>
              state &&
              quick(() =>
                actions.saveProject(
                  { ...state.project, mode: "custom", serverId: id },
                  state.projectRevision,
                ),
              ),
          }))
        : []),
    ];
  } else if (screen === "card" && card) {
    rows = [
      {
        id: "server-enabled",
        label: `${card.enabled ? "[x] Включён" : "[ ] Выключен"} · ${scope === "project" ? "Этот проект" : "Все проекты"}`,
        value: `${summarize(card)} · ${card.source === "project" ? "Изменено для проекта" : "Наследуется"}`,
        activate: () => toggleServer(card),
        toggle: () => toggleServer(card),
      },
      {
        id: "server-inherit",
        label:
          scope === "project"
            ? "Наследовать значение сервера"
            : "Сбросить исключение сервера",
        value: "Удаляет только выбранное исключение",
        activate: () =>
          state &&
          quick(() =>
            actions.setServerEnabled(scope, card.id, undefined, state),
          ),
      },
      {
        id: "start",
        label: card.state === "ready" ? "Перезапустить" : "Запустить сейчас",
        value:
          state?.launchRestriction ??
          "Запуск доступен в Build; потребуется разрешение",
        disabled:
          !!state?.launchRestriction ||
          !view?.enabled ||
          !card.enabled ||
          !card.applicable ||
          ["unavailable", "untrusted"].includes(card.state),
        activate: () => start(card.id),
      },
      ...(card.origin === "custom"
        ? [
            {
              id: "settings",
              label: "Настройки ручного сервера",
              value: "Executable, argv, языки и доверие · Все проекты",
              activate: () => editServer(card.id),
            },
          ]
        : []),
      {
        id: "server-reason",
        label: card.reason ?? summarize(card),
        value: `${card.languages.join(", ")}${card.prerequisites ? ` · ${card.prerequisites}` : ""}`,
        activate() {},
      },
      ...card.instances.flatMap((instance, index) => [
        {
          id: `root-${index}`,
          label: `${LSP_STATE_LABELS[instance.state]} · ${instance.projectRoot}`,
          value: instance.reason ?? "Экземпляр сервера в корне проекта",
          activate() {},
        },
        ...instance.documents.flatMap((doc, document) => [
          {
            id: `fresh-${index}-${document}`,
            label: `${doc.path} · ${freshnessLabel[doc.freshness]}`,
            value:
              doc.freshness === "current" && !doc.diagnostics.length
                ? "Нет ошибок в подтверждённом результате"
                : freshnessLabel[doc.freshness],
            activate() {},
          },
          ...doc.diagnostics.map((item, diagnostic) => ({
            id: `diagnostic-${index}-${document}-${diagnostic}`,
            label: `${item.path}:${item.range.start.line + 1} · ${item.message}`,
            value: `${freshnessLabel[doc.freshness]} · колонка ${item.range.start.character + 1} (UTF-16)`,
            activate: () =>
              setNotice(
                `${item.path}:${item.range.start.line + 1}:${item.range.start.character + 1} · ${item.message}`,
              ),
          })),
        ]),
      ]),
      ...(!card.instances.some((instance) => instance.documents.length)
        ? [
            {
              id: "no-diagnostics",
              label: "Нет результатов проверки",
              value: "Открытие карточки не запускает анализ",
              activate() {},
            },
          ]
        : []),
      {
        id: "details",
        label: "Технические детали",
        value: details ? "Скрыть" : "Версии, capabilities, поколения и пути",
        activate: () => setDetails(!details),
      },
      ...(details
        ? [
            {
              id: "catalog-version",
              label: `Версия каталога: ${card.version ?? "ручной сервер"}`,
              value:
                card.prerequisites ?? "Пути и capabilities экземпляров ниже",
              activate() {},
            },
            ...card.instances.map((instance, index) => ({
              id: `technical-${index}`,
              label: `Поколение ${instance.generation} · ${instance.version ?? "версия неизвестна"}`,
              value: `${instance.projectRoot}; ${instance.capabilities.join(", ")}`,
              activate: () =>
                setNotice(
                  `${instance.projectRoot}; ${instance.capabilities.join(", ")}`,
                ),
            })),
          ]
        : []),
    ];
  } else {
    const servers = (view?.servers ?? []).filter(
      (server) =>
        query ||
        all ||
        server.instances.length ||
        server.origin !== "builtin" ||
        (scope === "global"
          ? global.serverOverrides?.[server.id]
          : (project.serverOverrides?.[server.id] ??
            global.serverOverrides?.[server.id])),
    );
    const filtered = servers.filter((server) =>
      `${server.title} ${server.id} ${server.languages.join(" ")}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    );
    rows = [
      {
        id: "enabled",
        label:
          width < 34
            ? `Анализ: ${view?.enabled ? "Вкл" : "Выкл"}`
            : `Анализ кода: ${view?.enabled ? "Включён" : "Выключен"}`,
        value:
          scope === "project" && view?.globallyDisabled
            ? "Выключен для всех проектов; открыть общую настройку"
            : view?.source === "project"
              ? "Изменено для проекта"
              : "Наследуется из общих настроек",
        activate: overallToggle,
        toggle: overallToggle,
      },
      ...(scope === "project"
        ? [
            {
              id: "inherit",
              label: "Наследовать включение анализа",
              value: "Сохраняет стратегию, serverId и исключения серверов",
              activate: () =>
                state &&
                quick(() => actions.setEnabled(scope, undefined, state)),
            },
          ]
        : []),
      {
        id: "strategy",
        label: `Стратегия: ${view?.strategy === "custom" ? "Своя настройка" : "Auto"}`,
        value: "Выбрать явно",
        activate: () => navigate("strategy"),
      },
      {
        id: "catalog",
        label: all
          ? "Работавшие и настроенные серверы"
          : "Все поддерживаемые серверы",
        value: all
          ? "Свернуть каталог"
          : `${view?.servers.length ?? 0} серверов · поиск по названию и языку`,
        activate: () => {
          setAll(!all);
          select(0);
        },
      },
      ...filtered.map((server) => ({
        id: `server-${server.id}`,
        label: `${server.enabled ? "[x]" : "[ ]"} ${server.title}`,
        value: `${summarize(server)} · ${server.origin === "builtin" ? "Стандартный" : server.origin === "custom" ? "Ручной" : "Не настроен"} · ${server.languages.join(", ")}`,
        toggle: () => toggleServer(server),
        activate: () => {
          setCardId(server.id);
          navigate("card");
        },
      })),
      ...(!filtered.length
        ? [
            {
              id: "empty",
              label: query
                ? "Серверы не найдены"
                : "Серверы ещё не использовались",
              value: "Откройте полный каталог или найдите язык через Ctrl+F",
              activate() {},
            },
          ]
        : []),
      {
        id: "add-generic",
        label: "Подключить совместимый LSP",
        value: "Ручная форма · Все проекты",
        activate: () => editServer(undefined, "generic"),
      },
      {
        id: "add",
        label: "Добавить TypeScript/JavaScript",
        value: "Отдельно установленный сервер",
        activate: () => editServer(),
      },
      ...(draft
        ? [
            {
              id: "draft",
              label: "Продолжить черновик ручного сервера",
              value: draft.id,
              activate: () => navigate("form"),
            },
          ]
        : []),
      {
        id: "reload",
        label: "Обновить данные",
        value: "Сохраняет черновик; обновляет revisions после конфликта",
        activate: refreshBaseline,
      },
      ...(state?.applicationError
        ? [
            {
              id: "retry-apply",
              label: "Повторить завершение процессов",
              value: state.applicationError,
              activate: () => quick(() => actions.retryApply()),
            },
          ]
        : []),
      ...(!state?.workspaceRoot && onChooseProject
        ? [
            {
              id: "choose-project",
              label: "Выбрать проект",
              value: "Вернуться к выбору папки",
              activate: onChooseProject,
            },
          ]
        : []),
    ];
  }
  if (screen !== "form")
    rows.unshift({
      id: "scope",
      label: `Область: ${scope === "project" ? "Этот проект" : "Все проекты"}`,
      value: "Enter меняет область применения переключателей",
      activate: () => {
        setScope(
          scope === "project" || !state?.workspaceRoot ? "global" : "project",
        );
        select(0);
      },
    });
  if (query && screen === "overview")
    rows.splice(1, 0, {
      id: "clear-search",
      label: `Сбросить поиск: ${query}`,
      value: "Показать список без фильтра",
      activate: () => {
        setQuery("");
        select(0);
      },
    });
  const current = Math.min(selected, Math.max(0, rows.length - 1));
  const compact = height < 9;
  const displayRows = Math.max(
    1,
    height -
      (compact ? 2 : 5) -
      (notice ? 1 : 0) -
      (screen === "form" ? 1 : 0) -
      (searching ? 1 : 0),
  );
  const first = Math.max(
    0,
    Math.min(current - displayRows + 1, rows.length - displayRows),
  );
  useUiKeyboard((key) => {
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
      key.name === "f2" ||
      (key.ctrl && ["s", "f"].includes(key.name))
    )
      return;
    if (editing) return;
    if (searching) {
      if (key.name === "return") {
        key.preventDefault();
        key.stopPropagation();
        setSearching(false);
        select(0);
      }
      return;
    }
    if (["home", "end"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      select(key.name === "home" ? 0 : Math.max(0, rows.length - 1));
    } else if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      const delta =
        key.name === "up"
          ? -1
          : key.name === "down"
            ? 1
            : key.name === "pageup"
              ? -displayRows
              : displayRows;
      select(Math.max(0, Math.min(rows.length - 1, current + delta)));
    } else if (key.name === "return" || key.name === "space") {
      key.preventDefault();
      key.stopPropagation();
      const row = rows[current];
      if (!row?.disabled)
        (key.name === "space" ? row?.toggle : row?.activate)?.();
    }
  });
  return (
    <box
      id="lsp-menu"
      width="100%"
      height="100%"
      flexDirection="column"
      overflow="hidden"
    >
      {!editing && (
        <box height={1} flexShrink={0} flexDirection="row">
          <DialogAction
            id="lsp-project"
            label={compact ? "LSP Проект" : "Этот проект"}
            active={scope === "project"}
            disabled={!state?.workspaceRoot}
            palette={palette}
            onSelect={() => {
              setScope("project");
              select(0);
            }}
          />
          <DialogAction
            id="lsp-global"
            label={compact ? "Все" : "Все проекты"}
            active={scope === "global"}
            palette={palette}
            onSelect={() => {
              setScope("global");
              select(0);
            }}
          />
          {screen !== "overview" && (
            <DialogAction
              id="lsp-back"
              label={compact ? "‹" : "Назад"}
              palette={palette}
              onSelect={back}
            />
          )}
        </box>
      )}
      {!compact && !editing && (
        <text height={1} flexShrink={0} fg={palette.muted}>
          {terminalLine(
            state?.workspaceRoot ?? "Проект не выбран · общие настройки",
            width,
          )}
        </text>
      )}
      {!compact && !editing && (
        <text
          height={1}
          flexShrink={0}
          fg={view?.enabled ? palette.text : palette.muted}
        >
          {terminalLine(
            `${screen === "form" ? "Ручная форма · Все проекты" : screen === "card" ? `${card?.title ?? cardId} · ${card ? summarize(card) : "Недоступен"}` : `Анализ кода · LSP · ${scope === "project" ? "Этот проект" : "Все проекты"}`}${dirty ? " · draft *" : ""}`,
            width,
          )}
        </text>
      )}
      {searching && (
        <input
          id="lsp-search"
          value={query}
          focused={active && focused}
          width="100%"
          placeholder="Название или язык"
          backgroundColor={palette.raised}
          focusedBackgroundColor={palette.raised}
          textColor={palette.text}
          focusedTextColor={palette.text}
          onInput={(value) => {
            setQuery(cleanSettingsInput(value));
            if (screen !== "overview") navigate("overview");
            select(0);
          }}
        />
      )}
      {editing ? (
        <box flexGrow={1} minHeight={1} flexDirection="column">
          <text height={1} flexShrink={0} fg={palette.accent}>
            {rows.find((row) => row.id === editing)?.label}
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
            label="Готово · Esc назад"
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
                    current + (direction === "up" ? -1 : 1),
                  ),
                ),
              );
          }}
        >
          {rows.slice(first, first + displayRows).map((row, offset) => (
            <box
              key={row.id}
              height={1}
              flexShrink={0}
              flexDirection="row"
              width="100%"
            >
              <box flexGrow={1} minWidth={1}>
                <DialogAction
                  id={`lsp-row-${row.id}`}
                  label={terminalLine(
                    `${first + offset === current ? "> " : "  "}${row.label}${width > 62 ? ` · ${row.value}` : ""}`,
                    width - (row.toggle && width >= 34 ? 7 : 2),
                  )}
                  active={focused && !searching && first + offset === current}
                  disabled={busy || row.disabled || !state}
                  palette={palette}
                  onSelect={() => {
                    select(first + offset);
                    row.activate();
                  }}
                />
              </box>
              {row.toggle && width >= 34 && (
                <DialogAction
                  id={`lsp-toggle-${row.id}`}
                  label="[↔]"
                  palette={palette}
                  disabled={busy || row.disabled || !state}
                  onSelect={row.toggle}
                />
              )}
            </box>
          ))}
        </box>
      )}
      {!compact && !editing && (
        <text height={1} flexShrink={0} fg={palette.muted}>
          {terminalLine(
            rows[current]?.value ??
              "При включении сервер запускается при следующем запросе анализа",
            width,
          )}
        </text>
      )}
      {(notice || state?.applicationError) && (
        <text id="lsp-notice" height={1} flexShrink={0} fg={palette.yellow}>
          {terminalLine(notice || state?.applicationError || "", width)}
        </text>
      )}
      {busy && (
        <text id="lsp-applying" height={1} flexShrink={0} fg={palette.accent}>
          Применяется…
        </text>
      )}
      {!editing && screen === "form" && (
        <DialogAction
          id="lsp-save"
          label="Сохранить · Ctrl+S"
          primary
          palette={palette}
          disabled={busy || !state}
          onSelect={save}
        />
      )}
      {!compact && !editing && (
        <text height={1} flexShrink={0} fg={palette.muted}>
          {terminalLine(
            "↑↓ выбор · Enter открыть · Space вкл/выкл · Ctrl+F поиск · Tab фокус · Esc назад",
            width,
          )}
        </text>
      )}
    </box>
  );
}
