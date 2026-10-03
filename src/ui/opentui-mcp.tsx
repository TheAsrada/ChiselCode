/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { displayMcpCommand, parseMcpCommand } from "../mcp/command.js";
import type { McpConnectionState } from "../mcp/connection.js";
import {
  draftSecretReference,
  type McpDraft,
  type McpTestPreview,
  type OpenTuiMcpActions,
} from "../mcp/controller.js";
import type { McpDoctorReport } from "../mcp/doctor.js";
import { McpRedactor } from "../mcp/redaction.js";
import {
  DEFAULT_MCP_PERMISSIONS,
  type McpDecision,
  type McpPermissions,
  McpServerIdSchema,
  McpServerSchema,
  type McpValue,
} from "../mcp/schema.js";
import { mcpTrustPreview } from "../mcp/trust-preview.js";
import { type Palette, THEMES } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import {
  cleanSettingsInput,
  SettingsSecretInput,
} from "./opentui-settings-input.js";
import { terminalSafeText } from "./opentui-transcript.js";
import {
  TerminalScrollbox,
  useTerminalDecoration,
} from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";

export const MCP_STATE_LABELS: Record<McpConnectionState, string> = {
  disconnected: "Не подключён",
  connecting: "Подключаю",
  connected: "Подключён",
  authentication_required: "Нужна авторизация",
  reconnecting: "Переподключение",
  error: "Ошибка",
  disabled: "Отключён",
};
const categoryLabels = {
  read: "Внешнее чтение",
  write: "Внешняя запись",
  destructive: "Разрушительные действия",
  unknown: "Неизвестные действия",
};
const decisions: McpDecision[] = ["allow", "ask", "deny"];
const decisionLabels = {
  allow: "Разрешать",
  ask: "Спрашивать",
  deny: "Запретить",
};
type Screen =
  | "servers"
  | "server"
  | "tools"
  | "tool"
  | "permissions"
  | "logs"
  | "doctor"
  | "trust"
  | "add"
  | "form"
  | "env"
  | "edit"
  | "credentials"
  | "preview"
  | "preview-tools"
  | "preview-tool"
  | "preview-logs"
  | "remove";
type Field = "id" | "source" | "cwd" | "token" | "env-name" | "env-value";
type Row = {
  id: string;
  title: string;
  hint?: string;
  value?: string;
  color?: string;
  action: () => void;
};

export function OpenTuiMcp({
  actions,
  width,
  height,
  palette = THEMES.obsidian,
  onClose,
}: {
  actions: OpenTuiMcpActions;
  width: number;
  height: number;
  palette?: Palette;
  onClose: () => void;
}) {
  const { borderChars, unicode } = useTerminalDecoration();
  const [screen, setScreen] = useState<Screen>("servers");
  const [version, setVersion] = useState(0);
  const [serverId, setServerId] = useState("");
  const [toolName, setToolName] = useState("");
  const [selected, setSelectedState] = useState(0);
  const selectedRef = useRef(0);
  const select = (next: number) => {
    selectedRef.current = next;
    setSelectedState(next);
  };
  const go = (next: Screen) => {
    select(0);
    setScreen(next);
    setNotice("");
  };
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [kind, setKind] = useState<"url" | "local" | "manual">("url");
  const [id, setId] = useState("");
  const [source, setSource] = useState("");
  const [cwd, setCwd] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [token, setToken] = useState("");
  const [env, setEnv] = useState<Record<string, McpValue>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [envName, setEnvName] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [envType, setEnvType] = useState<"secret" | "env" | "literal">(
    "secret",
  );
  const [field, setField] = useState<Field>("source");
  const [editing, setEditing] = useState("");
  const [preview, setPreview] = useState<McpTestPreview>();
  const [testedDraft, setTestedDraft] = useState<McpDraft>();
  const [reports, setReports] = useState<McpDoctorReport[]>([]);
  const [permissions, setPermissions] = useState<McpPermissions>(
    structuredClone(DEFAULT_MCP_PERMISSIONS),
  );
  const lifetime = useRef({
    mounted: true,
    operation: 0,
    abort: undefined as AbortController | undefined,
  });
  const servers = actions.servers();
  const preferredHeight =
    screen === "servers"
      ? Math.min(30, Math.max(18, (servers.length + 1) * 2 + 10))
      : screen === "permissions" || screen === "add" || screen === "edit"
        ? 18
        : screen === "form" || screen === "preview"
          ? 26
          : screen === "remove"
            ? 16
            : 30;
  const { innerWidth, popupHeight, roomy, tiny } = dialogLayout(
    width,
    height,
    preferredHeight,
    102,
  );
  const server = servers.find((item) => item.id === serverId);
  const entry =
    server && !server.configurationError ? actions.entry(serverId) : undefined;
  const tools =
    screen === "preview-tools" || screen === "preview-tool"
      ? (preview?.tools ?? [])
      : server
        ? actions.tools(serverId)
        : [];
  const tool = tools.find((item) => item.tool.name === toolName);
  const statusColor = (state: McpConnectionState) =>
    state === "connected"
      ? palette.green
      : state === "error"
        ? palette.red
        : state === "disabled" || state === "disconnected"
          ? palette.muted
          : palette.yellow;
  const safe = (value: unknown, maxLength = 1200) => {
    const redactor = new McpRedactor();
    for (const value of [
      token,
      envType === "secret" ? envValue : "",
      field === "token" || (field === "env-value" && envType === "secret")
        ? editing
        : "",
      ...Object.values(secrets),
    ])
      redactor.add(value);
    return terminalSafeText(
      redactor.text(value instanceof Error ? value.message : String(value)),
      maxLength,
    );
  };
  const work = async (
    label: string,
    action: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (lifetime.current.abort) return;
    const abort = new AbortController();
    lifetime.current.abort = abort;
    const operation = ++lifetime.current.operation;
    setBusy(label);
    setNotice("");
    try {
      await action(abort.signal);
    } catch (error) {
      if (lifetime.current.mounted && operation === lifetime.current.operation)
        setNotice(abort.signal.aborted ? "Операция отменена." : safe(error));
    } finally {
      if (
        lifetime.current.mounted &&
        operation === lifetime.current.operation
      ) {
        setBusy("");
        lifetime.current.abort = undefined;
        setVersion((current) => current + 1);
      }
    }
  };
  const safeRef = useRef(safe);
  safeRef.current = safe;
  useEffect(() => {
    lifetime.current.mounted = true;
    const detach = actions.subscribe(() => {
      if (lifetime.current.mounted) setVersion((current) => current + 1);
    });
    void actions
      .load()
      .then(() => {
        if (lifetime.current.mounted) setVersion((current) => current + 1);
      })
      .catch((error) => {
        if (lifetime.current.mounted) setNotice(safeRef.current(error));
      });
    return () => {
      lifetime.current.mounted = false;
      lifetime.current.operation++;
      lifetime.current.abort?.abort();
      detach();
      void actions.discard().catch(() => {});
    };
  }, [actions]);
  const back = () => {
    if (busy) {
      lifetime.current.abort?.abort();
      return;
    }
    if (screen === "servers") {
      onClose();
      return;
    }
    if (screen === "server" || screen === "add") go("servers");
    else if (screen === "edit")
      go(field === "env-name" || field === "env-value" ? "env" : "form");
    else if (screen === "env" || screen === "preview") go("form");
    else if (screen === "preview-tools" || screen === "preview-logs")
      go("preview");
    else if (screen === "preview-tool") go("preview-tools");
    else if (screen === "form") go("add");
    else if (screen === "tool") go("tools");
    else go("server");
  };
  const edit = (next: Field, value: string) => {
    setField(next);
    setEditing(value);
    go("edit");
  };
  const confirmEdit = () => {
    if (field === "id") setId(editing.trim());
    if (field === "source") setSource(editing.trim());
    if (field === "cwd") setCwd(editing.trim());
    if (field === "token") setToken(editing);
    if (field === "env-name") setEnvName(editing.trim());
    if (field === "env-value") setEnvValue(editing);
    setEditing("");
    go(field === "env-name" || field === "env-value" ? "env" : "form");
  };
  const buildDraft = (): McpDraft => {
    if (!McpServerIdSchema.safeParse(id).success)
      throw new Error(
        "ID: латинские строчные буквы, цифры, _ или -, начиная с буквы (до 32 знаков).",
      );
    let raw: Record<string, unknown>;
    if (kind === "manual") {
      try {
        raw = JSON.parse(source);
      } catch {
        throw new Error(
          "Невалидный JSON. Введите объект конфигурации сервера.",
        );
      }
    } else
      raw = {
        transport:
          kind === "url"
            ? { type: "http", url: source }
            : {
                type: "stdio",
                ...parseMcpCommand(source),
                ...(cwd ? { cwd } : {}),
              },
        permissions: DEFAULT_MCP_PERMISSIONS,
      };
    const draftSecrets = { ...secrets };
    if (Object.keys(env).length) raw.env = env;
    if (token) {
      const ref = draftSecretReference();
      draftSecrets[ref] = token;
      raw.auth = { token: { secretRef: ref } };
    }
    const validated = McpServerSchema.safeParse(raw);
    if (!validated.success)
      throw new Error(
        `Проверьте настройки: ${validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      );
    return { id, config: validated.data, secrets: draftSecrets, scope };
  };
  const test = () =>
    void work("Проверяю подключение…", async (signal) => {
      const draft = buildDraft();
      const result = await actions.test(draft, signal);
      if (signal.aborted || !lifetime.current.mounted) return;
      setTestedDraft(draft);
      setPreview(result);
      setPermissions(structuredClone(DEFAULT_MCP_PERMISSIONS));
      go("preview");
    });
  const beginAdd = (next: typeof kind) => {
    setKind(next);
    setId("");
    setSource("");
    setCwd("");
    setEnv({});
    setSecrets({});
    setToken("");
    setPreview(undefined);
    setTestedDraft(undefined);
    go("form");
  };
  const switchDecision = (key: keyof McpPermissions["categories"]) => {
    const current = permissions.categories[key] ?? "ask";
    setPermissions({
      ...permissions,
      categories: {
        ...permissions.categories,
        [key]:
          decisions[(decisions.indexOf(current) + 1) % decisions.length] ??
          "ask",
      },
    });
  };
  let rows: Row[] = [];
  if (screen === "servers")
    rows = [
      ...servers.map((item) => ({
        id: item.id,
        title: item.label,
        value: item.configurationError
          ? "Ошибка настроек"
          : !item.trusted
            ? "Нужно доверие"
            : MCP_STATE_LABELS[item.state],
        color: item.configurationError
          ? palette.red
          : !item.trusted
            ? palette.yellow
            : statusColor(item.state),
        hint: `${item.toolsCount} tools · ${item.scope === "global" ? "Для всех проектов" : "Этот проект"}${item.lastError ? ` · ${item.lastError.message}` : ""}`,
        action: () => {
          setServerId(item.id);
          go(item.configurationError ? "logs" : "server");
        },
      })),
      {
        id: "add",
        title: "+ Добавить MCP",
        hint: "URL, локальная команда или ручная настройка",
        action: () => go("add"),
      },
    ];
  if (screen === "server" && entry && server)
    rows = [
      {
        id: "connect",
        title: !entry.trusted
          ? "Проверить и доверить"
          : server.state === "connected"
            ? "Переподключить"
            : "Подключить",
        hint: !entry.trusted
          ? "Команда проекта не запускалась"
          : "Без повторного выполнения предыдущих действий",
        action: () =>
          !entry.trusted
            ? go("trust")
            : void work("Подключаю…", async (signal) => {
                await actions.disconnect(serverId);
                await actions.connect(serverId, signal);
              }),
      },
      {
        id: "tools",
        title: "Инструменты",
        value: String(server.toolsCount),
        hint: "Назначение, эффект и правило каждого tool",
        action: () => go("tools"),
      },
      {
        id: "permissions",
        title: "Разрешения",
        hint: "Чтение, запись и опасные действия отдельно",
        action: () => {
          setPermissions(structuredClone(entry.permissions));
          go("permissions");
        },
      },
      {
        id: "doctor",
        title: "Диагностика",
        hint: "Проверка запуска, протокола и учётных данных",
        action: () =>
          void work("Диагностирую…", async (signal) => {
            const result = await actions.doctor(serverId, signal);
            setReports(result);
            go("doctor");
          }),
      },
      {
        id: "logs",
        title: "Журнал соединения",
        hint: "Без секретов и протокольных пакетов",
        action: () => go("logs"),
      },
      ...(entry.config.transport.type === "http"
        ? [
            {
              id: "auth",
              title: "Учётные данные",
              hint: "Добавить или заменить токен доступа",
              action: () => {
                setField("token");
                setEditing("");
                go("credentials");
              },
            },
          ]
        : []),
      {
        id: "enable",
        title: entry.config.enabled ? "Отключить" : "Включить",
        hint: "Настройка сохранится",
        action: () =>
          void work("Сохраняю…", (signal) =>
            actions.enable(serverId, !entry.config.enabled).then(async () => {
              if (!entry.config.enabled && entry.trusted)
                await actions.connect(serverId, signal);
            }),
          ),
      },
      {
        id: "disconnect",
        title: "Разорвать соединение",
        hint: "До следующего явного подключения",
        action: () =>
          void work("Отключаю…", () => actions.disconnect(serverId)),
      },
      {
        id: "remove",
        title: "Удалить подключение",
        action: () => go("remove"),
      },
    ];
  if (screen === "add")
    rows = [
      {
        id: "url",
        title: "Вставить URL",
        hint: "Удалённый MCP; транспорт определится автоматически",
        action: () => beginAdd("url"),
      },
      {
        id: "local",
        title: "Локальная команда",
        hint: "Запускается с вашими правами после проверки команды",
        action: () => beginAdd("local"),
      },
      {
        id: "manual",
        title: "Расширенная настройка",
        hint: "Строгий объект сервера: args, headers и ссылки на секреты",
        action: () => beginAdd("manual"),
      },
    ];
  if (screen === "form")
    rows = [
      {
        id: "id",
        title: "Название / ID",
        value: id || "Например github",
        action: () => edit("id", id),
      },
      {
        id: "source",
        title:
          kind === "url"
            ? "URL сервера"
            : kind === "local"
              ? "Команда запуска"
              : "Конфигурация JSON",
        value:
          source ||
          (kind === "url"
            ? "https://…/mcp"
            : kind === "local"
              ? "npx -y package@version"
              : '{"transport":…}'),
        action: () => edit("source", source),
      },
      ...(kind === "local"
        ? [
            {
              id: "cwd",
              title: "Рабочая папка",
              value: cwd || "Текущий проект",
              action: () => edit("cwd", cwd),
            },
            {
              id: "env",
              title: "Окружение",
              value: `${Object.keys(env).length} переменных`,
              hint: "Секрет / переменная окружения / обычное значение",
              action: () => {
                setEnvName("");
                setEnvValue("");
                setEnvType("secret");
                go("env");
              },
            },
          ]
        : kind === "url"
          ? [
              {
                id: "token",
                title: "Токен доступа",
                value: token
                  ? "Введён · скрыт"
                  : "Если сервер требует авторизацию",
                action: () => edit("token", token),
              },
            ]
          : []),
      {
        id: "scope",
        title: "Доступность",
        value: scope === "global" ? "Для всех проектов" : "Только этот проект",
        hint: "Секреты сохраняются только в вашем хранилище",
        action: () => setScope(scope === "global" ? "project" : "global"),
      },
      {
        id: "test",
        title: "Проверить подключение",
        hint:
          kind === "local"
            ? "Будет выполнена команда выше. Рекомендуется закрепить версию пакета."
            : "Инициализация и обнаружение возможностей до сохранения",
        action: test,
      },
    ];
  if (screen === "env")
    rows = [
      {
        id: "name",
        title: "Имя переменной",
        value: envName || "API_KEY",
        action: () => edit("env-name", envName),
      },
      {
        id: "type",
        title: "Значение",
        value:
          envType === "secret"
            ? "Секрет"
            : envType === "env"
              ? "Из окружения"
              : "Обычный текст",
        action: () => {
          setEnvType(
            envType === "secret"
              ? "env"
              : envType === "env"
                ? "literal"
                : "secret",
          );
          setEnvValue("");
        },
      },
      {
        id: "value",
        title: envType === "env" ? "Имя в окружении" : "Введите значение",
        value: envValue
          ? envType === "secret"
            ? "Скрыто"
            : envValue
          : "Не задано",
        action: () => edit("env-value", envValue),
      },
      {
        id: "save",
        title: "Добавить переменную",
        action: () => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName) || !envValue) {
            setNotice("Введите имя и значение переменной.");
            return;
          }
          const ref = draftSecretReference();
          const value =
            envType === "secret"
              ? { secretRef: ref }
              : envType === "env"
                ? { envRef: envValue }
                : { literal: envValue };
          setEnv({ ...env, [envName]: value });
          if (envType === "secret") setSecrets({ ...secrets, [ref]: envValue });
          setEnvValue("");
          go("form");
        },
      },
      ...Object.entries(env).map(([name, value]) => ({
        id: name,
        title: name,
        hint: "Enter удалит переменную",
        value:
          "secretRef" in value
            ? "Секрет"
            : "envRef" in value
              ? `env: ${value.envRef}`
              : value.literal,
        action: () => {
          const next = { ...env };
          delete next[name];
          setEnv(next);
        },
      })),
    ];
  if (screen === "tools" || screen === "preview-tools")
    rows = tools.map((info) => ({
      id: info.tool.name,
      title: info.tool.title ?? info.tool.name,
      value: info.classification.category,
      hint: info.tool.description?.slice(0, 160),
      action: () => {
        setToolName(info.tool.name);
        go(screen === "preview-tools" ? "preview-tool" : "tool");
      },
    }));
  if (screen === "preview")
    rows.unshift(
      {
        id: "preview-tools",
        title: "Обнаруженные инструменты",
        value: String(preview?.tools.length ?? 0),
        hint: "Проверьте назначение и классификацию перед сохранением",
        action: () => go("preview-tools"),
      },
      {
        id: "preview-logs",
        title: "Результаты проверки",
        hint: "Запуск, инициализация и безопасные сообщения сервера",
        action: () => go("preview-logs"),
      },
    );
  if (screen === "permissions" || screen === "preview")
    rows = Object.entries(categoryLabels).map(([key, title]) => ({
      id: key,
      title,
      value:
        decisionLabels[
          permissions.categories[key as keyof typeof permissions.categories] ??
            "ask"
        ],
      hint:
        key === "read"
          ? "Read tools доступны и в Plan"
          : key === "unknown"
            ? "Неясные эффекты требуют подтверждения"
            : "В Plan всегда заблокировано",
      action: () => switchDecision(key as keyof typeof permissions.categories),
    }));
  const bodyHeight = Math.max(
    1,
    popupHeight -
      (roomy ? 9 : tiny ? 3 : 6) -
      (screen === "server" || screen === "preview" ? 3 : 0) -
      (notice || busy ? 1 : 0),
  );
  const rowHeight = roomy ? 2 : 1;
  const visibleCount = Math.max(1, Math.floor(bodyHeight / rowHeight));
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, rows.length - visibleCount),
      selected - Math.floor(visibleCount / 2),
    ),
  );
  const save = () =>
    void work("Сохраняю…", async () => {
      if (screen === "permissions") {
        await actions.permissions(serverId, permissions);
        go("server");
      } else if (
        screen === "preview" &&
        testedDraft &&
        ["connected", "authentication_required"].includes(
          preview?.server.state ?? "",
        )
      ) {
        await actions.save(testedDraft, permissions);
        setToken("");
        setSecrets({});
        setTestedDraft(undefined);
        setServerId(testedDraft.id);
        go("server");
      }
    });
  const trust = () => {
    if (entry)
      void work("Запускаю…", async (signal) => {
        await actions.trust(
          serverId,
          entry.fingerprint,
          DEFAULT_MCP_PERMISSIONS,
        );
        await actions.connect(serverId, signal);
        go("server");
      });
  };
  const remove = () =>
    void work("Удаляю…", async () => {
      await actions.remove(serverId);
      go("servers");
    });
  const changeToolPermission = () => {
    if (entry)
      void work("Сохраняю правило…", async () => {
        const cycle: Array<McpDecision | undefined> = [
          undefined,
          "ask",
          "allow",
          "deny",
        ];
        const next =
          cycle[
            (cycle.indexOf(entry.permissions.tools[toolName]) + 1) %
              cycle.length
          ];
        const rules = { ...entry.permissions.tools };
        if (next) rules[toolName] = next;
        else delete rules[toolName];
        await actions.permissions(serverId, {
          ...entry.permissions,
          tools: rules,
        });
      });
  };
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      lifetime.current.abort?.abort();
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      back();
      return;
    }
    if (
      !busy &&
      key.ctrl &&
      key.name === "s" &&
      (screen === "permissions" || screen === "preview")
    ) {
      key.preventDefault();
      save();
      return;
    }
    if (!busy && key.ctrl && key.name === "r" && screen === "form") {
      key.preventDefault();
      test();
      return;
    }
    if (
      busy ||
      screen === "edit" ||
      screen === "credentials" ||
      key.ctrl ||
      key.meta ||
      key.option
    )
      return;
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      select(
        Math.max(
          0,
          Math.min(
            rows.length - 1,
            selectedRef.current + (key.name === "up" ? -1 : 1),
          ),
        ),
      );
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      select(
        Math.max(
          0,
          Math.min(
            rows.length - 1,
            selectedRef.current +
              (key.name === "pageup" ? -visibleCount : visibleCount),
          ),
        ),
      );
    }
    if (key.name === "return") {
      key.preventDefault();
      if (screen === "trust") trust();
      else if (screen === "remove") remove();
      else if (screen === "tool") changeToolPermission();
      else rows[selectedRef.current]?.action();
    }
  });
  const heading =
    screen === "servers"
      ? "MCP · Центр подключений"
      : screen === "add"
        ? "Добавить MCP"
        : screen === "form" || screen === "env" || screen === "edit"
          ? "Новое подключение"
          : screen === "preview"
            ? preview?.server.state === "connected"
              ? "Подключение проверено"
              : preview?.server.state === "authentication_required"
                ? "Нужна авторизация"
                : "Не удалось подключиться"
            : screen === "trust"
              ? "Доверие к серверу проекта"
              : screen === "remove"
                ? "Удалить подключение?"
                : (entry?.config.label ?? serverId);
  const hint =
    screen === "servers"
      ? "Внешние инструменты под контролем ваших разрешений"
      : screen === "preview"
        ? "Выберите правила и сохраните подключение"
        : screen === "permissions"
          ? "Запреты имеют приоритет; разрешение относится только к выбранному правилу"
          : screen === "tools" || screen === "preview-tools"
            ? "Инструменты сервера · Enter: подробности и индивидуальное правило"
            : screen === "logs" ||
                screen === "preview-logs" ||
                screen === "doctor"
              ? "Диагностика текущего соединения · секреты скрыты"
              : screen === "trust"
                ? "Проверьте точную команду и доступ к окружению"
                : "Esc назад · Ctrl+C остановить проверку";
  const command =
    entry?.config.transport.type === "stdio"
      ? displayMcpCommand(
          entry.config.transport.command,
          entry.config.transport.args,
        )
      : entry?.config.transport.url;
  void version;
  return (
    <OpenTuiDialog
      id="mcp"
      width={width}
      height={height}
      palette={palette}
      maxHeight={preferredHeight}
      maxWidth={102}
      onClose={back}
    >
      <box flexDirection="row" height={1} flexShrink={0}>
        <text fg={palette.accent} flexGrow={1}>
          <strong>{terminalLine(heading, Math.max(1, innerWidth - 8))}</strong>
        </text>
        <DialogAction
          id="mcp-close"
          label="Esc x"
          palette={palette}
          onSelect={back}
        />
      </box>
      {!tiny && (
        <text fg={palette.muted} height={1}>
          {terminalLine(hint, innerWidth)}
        </text>
      )}
      {((screen === "server" && server) ||
        (screen === "preview" && preview)) && (
        <box marginTop={roomy ? 1 : 0} flexDirection="column" flexShrink={0}>
          <text
            fg={statusColor(
              (screen === "preview" ? preview?.server.state : server?.state) ??
                "disconnected",
            )}
            height={1}
          >
            {
              MCP_STATE_LABELS[
                (screen === "preview"
                  ? preview?.server.state
                  : server?.state) ?? "disconnected"
              ]
            }{" "}
            ·{" "}
            {(screen === "preview"
              ? preview?.server.toolsCount
              : server?.toolsCount) ?? 0}{" "}
            tools ·{" "}
            {(screen === "preview"
              ? preview?.server.latencyMs
              : server?.latencyMs) ?? 0}{" "}
            мс
          </text>
          <text fg={palette.muted} height={1}>
            {terminalLine(
              screen === "preview"
                ? (preview?.server.lastError?.message ??
                    `Протокол ${preview?.server.info?.protocolVersion ?? "—"}`)
                : (server?.lastError?.message ??
                    `Протокол ${server?.info?.protocolVersion ?? "—"} · ${server?.transport ?? ""}`),
              innerWidth,
            )}
          </text>
        </box>
      )}
      <box
        flexGrow={1}
        minHeight={0}
        flexDirection="column"
        marginTop={roomy ? 1 : 0}
      >
        {screen === "credentials" ? (
          <box flexDirection="column" gap={1}>
            <text fg={palette.accent}>Токен доступа</text>
            <text fg={palette.muted}>
              {terminalLine(command ?? "", innerWidth)}
            </text>
            <box
              border
              customBorderChars={borderChars}
              borderColor={palette.accent}
              paddingLeft={1}
              paddingRight={1}
            >
              <SettingsSecretInput
                value={editing}
                onChange={setEditing}
                onSubmit={() =>
                  void work("Авторизую…", async (signal) => {
                    await actions.authenticate(serverId, editing, signal);
                    setEditing("");
                    go("server");
                  })
                }
                palette={palette}
              />
            </box>
            <text fg={palette.muted}>
              Enter сохранить и подключить · Esc отменить
            </text>
            {roomy && (
              <text fg={palette.muted}>
                Хранится в зашифрованном хранилище. Browser OAuth пока не
                поддерживается.
              </text>
            )}
          </box>
        ) : screen === "edit" ? (
          <box flexDirection="column" gap={1}>
            <text fg={palette.accent}>
              {field === "source"
                ? kind === "url"
                  ? "Адрес MCP"
                  : kind === "local"
                    ? "Команда и аргументы"
                    : "Объект конфигурации сервера"
                : field === "token"
                  ? "Токен доступа · хранится отдельно"
                  : field === "id"
                    ? "ID подключения"
                    : field === "cwd"
                      ? "Рабочая папка"
                      : field === "env-name"
                        ? "Имя переменной"
                        : "Значение"}
            </text>
            <box
              border
              customBorderChars={borderChars}
              borderColor={palette.accent}
              paddingLeft={1}
              paddingRight={1}
            >
              {field === "token" ||
              (field === "env-value" && envType === "secret") ? (
                <SettingsSecretInput
                  value={editing}
                  onChange={setEditing}
                  onSubmit={confirmEdit}
                  palette={palette}
                />
              ) : (
                <input
                  id="mcp-input"
                  focused
                  value={editing}
                  onInput={(value) => setEditing(cleanSettingsInput(value))}
                  onSubmit={confirmEdit}
                  backgroundColor={palette.raised}
                  textColor={palette.text}
                  focusedBackgroundColor={palette.raised}
                  focusedTextColor={palette.text}
                  placeholderColor={palette.muted}
                />
              )}
            </box>
            <text fg={palette.muted}>Enter подтвердить · Esc отменить</text>
          </box>
        ) : screen === "trust" && entry ? (
          <TerminalScrollbox flexGrow={1} minHeight={0} focused>
            <text fg={palette.text}>
              {terminalSafeText(mcpTrustPreview(entry), 1_200_000)}
            </text>
          </TerminalScrollbox>
        ) : screen === "doctor" ? (
          <TerminalScrollbox flexGrow={1} minHeight={0} focused>
            {reports.flatMap((report) => [
              <text key={report.id} fg={palette.accent}>
                <strong>{report.label}</strong>
              </text>,
              ...report.checks.map((check) => (
                <text
                  key={`${report.id}-${check.name}-${check.message}`}
                  fg={check.ok ? palette.green : palette.red}
                >
                  {safe(`${check.ok ? "+" : "x"} ${check.message}`)}
                </text>
              )),
            ])}
          </TerminalScrollbox>
        ) : screen === "logs" || screen === "preview-logs" ? (
          <TerminalScrollbox flexGrow={1} minHeight={0} focused>
            <text fg={palette.text}>
              {safe(
                (screen === "preview-logs"
                  ? (preview?.logs ?? [])
                  : actions.logs(serverId)
                )
                  .map(
                    (log) =>
                      `${log.timestamp.slice(11, 19)} ${log.level}: ${log.message}`,
                  )
                  .join("\n") || "Журнал пуст. Запустите диагностику.",
                120_000,
              )}
            </text>
          </TerminalScrollbox>
        ) : (screen === "tool" || screen === "preview-tool") && tool ? (
          <TerminalScrollbox flexGrow={1} minHeight={0} focused>
            <text fg={palette.accent}>{tool.tool.title ?? tool.tool.name}</text>
            <text fg={palette.muted}>
              {screen === "preview-tool" ? testedDraft?.id : serverId}.
              {tool.tool.name} · {tool.classification.effect}
            </text>
            <text fg={palette.text}>{safe(tool.tool.description ?? "")}</text>
            <text fg={palette.yellow}>{tool.classification.reason}</text>
            <text fg={palette.muted}>
              {safe(JSON.stringify(tool.tool.inputSchema, null, 2))}
            </text>
          </TerminalScrollbox>
        ) : screen === "remove" ? (
          <text
            fg={palette.text}
          >{`Подключение ${server?.label ?? serverId} будет удалено из ${entry?.scope === "project" ? ".chiselrc" : "ваших настроек"}. Внешние данные сохранятся.`}</text>
        ) : (
          <box
            flexDirection="column"
            onMouseScroll={(event) => {
              const direction = event.scroll?.direction;
              if (direction === "up" || direction === "down") {
                event.stopPropagation();
                select(
                  Math.max(
                    0,
                    Math.min(
                      rows.length - 1,
                      selectedRef.current + (direction === "up" ? -1 : 1),
                    ),
                  ),
                );
              }
            }}
          >
            {rows.slice(start, start + visibleCount).map((row, index) => {
              const active = start + index === selected;
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: Every row has Up/Down and Enter keyboard equivalents.
                <box
                  key={row.id}
                  id={`mcp-row-${row.id}`}
                  height={rowHeight}
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active ? palette.raised : palette.surface}
                  flexDirection="column"
                  onMouseUp={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    if (!busy) {
                      select(start + index);
                      row.action();
                    }
                  }}
                >
                  <text height={1} fg={active ? palette.accent : palette.text}>
                    {row.color ? (
                      <span fg={row.color}>{unicode ? "●" : "*"} </span>
                    ) : (
                      `${active ? ">" : " "} `
                    )}
                    {terminalLine(
                      row.title,
                      Math.max(
                        1,
                        innerWidth -
                          4 -
                          (innerWidth >= 40
                            ? (row.value?.length ?? 0) + (row.value ? 2 : 0)
                            : 0),
                      ),
                    )}
                    {row.value && innerWidth >= 40 && (
                      <span
                        fg={
                          row.color ?? (active ? palette.accent : palette.muted)
                        }
                      >
                        {" "}
                        {terminalLine(row.value, Math.max(1, innerWidth - 4))}
                      </span>
                    )}
                  </text>
                  {roomy && (
                    <text height={1} fg={palette.muted}>
                      {terminalLine(`  ${row.hint ?? ""}`, innerWidth - 2)}
                    </text>
                  )}
                </box>
              );
            })}
            {rows.length === 0 && (
              <text fg={palette.muted}>
                {screen === "tools" || screen === "preview-tools"
                  ? "Инструменты появятся после подключения."
                  : "Нет подключений"}
              </text>
            )}
          </box>
        )}
      </box>
      {(busy || notice) && (
        <text
          height={Math.min(3, notice.split("\n").length || 1)}
          fg={busy ? palette.accent : palette.yellow}
        >
          {terminalSafeText(busy || notice, 1200)}
        </text>
      )}
      <box
        flexDirection="row"
        gap={1}
        height={1}
        flexShrink={0}
        marginTop={roomy ? 1 : 0}
      >
        {screen === "servers" && (
          <DialogAction
            id="mcp-add"
            label="+ Добавить MCP"
            palette={palette}
            primary
            onSelect={() => go("add")}
            disabled={!!busy}
          />
        )}
        {screen !== "servers" && (
          <DialogAction label="< Назад" palette={palette} onSelect={back} />
        )}
        {screen === "form" && (
          <DialogAction
            id="mcp-test"
            label="Проверить"
            palette={palette}
            primary
            onSelect={test}
            disabled={!!busy}
          />
        )}
        {screen === "trust" && entry && (
          <DialogAction
            id="mcp-trust"
            label={innerWidth < 48 ? "Доверить" : "Доверить и запустить"}
            palette={palette}
            primary
            onSelect={trust}
            disabled={!!busy}
          />
        )}
        {screen === "permissions" && (
          <DialogAction
            id="mcp-save-permissions"
            label="Сохранить"
            palette={palette}
            primary
            onSelect={save}
            disabled={!!busy}
          />
        )}
        {screen === "preview" && testedDraft && (
          <DialogAction
            id="mcp-save"
            label="Сохранить"
            palette={palette}
            primary
            onSelect={save}
            disabled={
              !!busy ||
              !["connected", "authentication_required"].includes(
                preview?.server.state ?? "",
              )
            }
          />
        )}
        {screen === "remove" && (
          <DialogAction
            label="Удалить"
            palette={palette}
            primary
            onSelect={remove}
            disabled={!!busy}
          />
        )}
        {screen === "tool" && entry && (
          <DialogAction
            id="mcp-tool-permission"
            label={`Правило: ${entry.permissions.tools[toolName] ? decisionLabels[entry.permissions.tools[toolName]] : "Наследовать"}`}
            palette={palette}
            onSelect={changeToolPermission}
            disabled={!!busy}
          />
        )}
      </box>
      {!tiny && (
        <text fg={palette.muted} height={1}>
          {terminalLine(
            screen === "servers"
              ? `${servers.filter((item) => item.state === "connected").length}/${servers.length} подключено · ${unicode ? "↑ ↓" : "Up Down"} выбор · Enter открыть`
              : screen === "permissions" || screen === "preview"
                ? "Enter выбор / правило · Ctrl+S сохранить"
                : screen === "form"
                  ? "Ctrl+R проверить · Esc назад"
                  : screen === "trust"
                    ? "Enter доверить и запустить · Esc отменить"
                    : screen === "remove"
                      ? "Enter удалить · Esc отменить"
                      : screen === "tool"
                        ? "Enter меняет правило · Esc назад"
                        : "Esc назад · Up / Down выбор · Enter открыть",
            innerWidth,
          )}
        </text>
      )}
    </OpenTuiDialog>
  );
}
