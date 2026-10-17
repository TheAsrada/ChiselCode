/** @jsxImportSource @opentui/react */
import { randomUUID } from "node:crypto";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import stringWidth from "string-width";
import type {
  CatalogExtension,
  ExtensionAction,
  ExtensionReview,
  ExtensionSettings,
  SettingField,
  SettingValue,
} from "../desktop/protocol.js";
import type { ExtensionManagementService } from "../extensions/management.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import {
  cleanSettingsInput,
  SettingsSecretInput,
} from "./opentui-settings-input.js";
import { useUiKeyboard } from "./overlay-input.js";
import type { SettingsPanelControl } from "./settings-panel.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";

export const EXTENSION_STATE_LABELS = {
  saved: "Сохранено",
  working: "Работает",
  disabled: "Выключено",
  not_trusted: "Не доверено",
  error: "Ошибка",
  restart_required: "Нужен перезапуск",
} as const;
const filters = ["Все", "Встроенные", "Установленные", "Требуют внимания"];
const actionLabels: Record<ExtensionAction, string> = {
  enable: "Включить",
  disable: "Выключить",
  trust: "Доверить и включить",
  settings: "Настройки",
  update: "Обновить из файла",
  versions: "Версии",
  remove: "Удалить",
};
type View =
  | "catalog"
  | "details"
  | "filters"
  | "source"
  | "review"
  | "versions"
  | "settings";
interface MenuEntry {
  id: string;
  label: string;
  run(): void;
  disabled?: boolean;
  subtitle?: string;
  tone?: "error" | "warning" | "success" | "muted";
}
const stateTone = (item: CatalogExtension): MenuEntry["tone"] =>
  item.state === "error"
    ? "error"
    : item.state === "not_trusted" ||
        item.restartRequired ||
        item.projectBlocked
      ? "warning"
      : item.state === "working"
        ? "success"
        : "muted";
export function OpenTuiExtensions({
  management,
  root,
  palette,
  width,
  height,
  active,
  focused,
  controls,
  onOpenBuiltin,
  onDirty,
  onFocus = () => {},
}: {
  management: ExtensionManagementService;
  root?: string;
  palette: Palette;
  width: number;
  height: number;
  active: boolean;
  focused: boolean;
  controls: MutableRefObject<SettingsPanelControl | undefined>;
  onOpenBuiltin(route: NonNullable<CatalogExtension["settingsRoute"]>): void;
  onDirty(value: boolean): void;
  onFocus?(): void;
}) {
  const [items, setItems] = useState<CatalogExtension[]>([]),
    [selectedId, setSelectedId] = useState(""),
    [filter, setFilter] = useState(0),
    [query, setQuery] = useState(""),
    [searching, setSearching] = useState(false);
  const [view, setView] = useState<View>("catalog"),
    [menuTarget, setMenuTarget] = useState(""),
    [metadata, setMetadata] = useState(false),
    [source, setSource] = useState(""),
    [sourceKind, setSourceKind] = useState<"install" | "update">("install");
  const [review, setReview] = useState<ExtensionReview>(),
    [trust, setTrust] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [progress, setProgress] = useState(""),
    [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [settings, setSettings] = useState<ExtensionSettings>(),
    [values, setValues] = useState<Record<string, SettingValue>>({}),
    [secrets, setSecrets] = useState<Record<string, string>>({}),
    [clearSecrets, setClearSecrets] = useState<string[]>([]);
  const [edit, setEdit] = useState<SettingField>(),
    [input, setInput] = useState("");
  const pending = useRef(false),
    request = useRef<string | undefined>(undefined),
    alive = useRef(true),
    detailScroll = useRef<ScrollBoxRenderable | null>(null),
    pendingScroll = useRef<string | undefined>(undefined),
    lastAttempt = useRef<
      | {
          kind: ExtensionReview["kind"];
          source?: string;
          id?: string;
          versionKey?: string;
        }
      | undefined
    >(undefined);
  const dirty =
    !!settings &&
    (JSON.stringify(values) !== JSON.stringify(settings.values) ||
      Object.keys(secrets).length > 0 ||
      clearSecrets.length > 0 ||
      !!(
        edit && input !== (edit.secret ? "" : String(values[edit.name] ?? ""))
      ));
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  const selected = items.find((i) => i.id === selectedId);
  const matching = (item: CatalogExtension, option = filter) => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const content =
      `${item.name} ${item.id} ${item.description}`.toLocaleLowerCase();
    return (
      words.every((word) => content.includes(word)) &&
      (option === 0 ||
        (option === 1 && item.origin === "builtin") ||
        (option === 2 && item.origin === "installed") ||
        (option === 3 &&
          (item.state === "error" ||
            item.state === "not_trusted" ||
            item.restartRequired ||
            item.projectBlocked ||
            item.deferredRemoval)))
    );
  };
  const visible = items.filter((item) => matching(item));
  const openView = (next: View, target = "") => {
    setView(next);
    setMenuTarget(target);
  };
  const openDetails = (item: CatalogExtension) => {
    setSelectedId(item.id);
    setMetadata(false);
    setSearching(false);
    setNotice("");
    openView("details");
  };
  const refresh = useCallback(async () => {
    const list = await management.list(root);
    if (alive.current) {
      setItems(list.items);
      setLoaded(true);
      setSelectedId((id) =>
        list.items.some((i) => i.id === id) ? id : (list.items[0]?.id ?? ""),
      );
    }
  }, [management, root]);
  const cancel = useCallback(() => {
    const id = request.current;
    request.current = undefined;
    if (id)
      void management.cancel(id).catch((e) => {
        if (alive.current) setNotice(terminalSafeText(e.message, 800));
      });
    setReview(undefined);
    setTrust(false);
  }, [management]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const id = request.current;
      if (id) void management.cancel(id).catch(() => {});
    };
  }, [management]);
  useEffect(() => {
    if (active)
      void refresh().catch((e) => setNotice(terminalSafeText(e.message, 800)));
    else if (request.current) {
      cancel();
      setView("catalog");
    }
  }, [active, refresh, cancel]);
  useEffect(() => {
    if (!busy || !request.current) return;
    const timer = setInterval(() => {
      if (!request.current) return;
      const op = management.operation(request.current);
      if (op.progress)
        setProgress(
          `${op.progress.phase} · ${op.progress.files} файлов · ${op.progress.bytes} байт`,
        );
    }, 150);
    return () => clearInterval(timer);
  }, [busy, management]);
  const run = (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    setFailed(false);
    void work()
      .catch(async (error) => {
        if (alive.current) setFailed(true);
        if (alive.current) {
          setNotice(
            terminalSafeText(
              error instanceof Error ? error.message : "Операция не завершена.",
              1000,
            ),
          );
          if (
            request.current &&
            management.operation(request.current).phase === "error"
          ) {
            cancel();
            setView("catalog");
          }
        }
        await refresh().catch(() => {});
      })
      .finally(() => {
        pending.current = false;
        if (alive.current) {
          setBusy(false);
          setProgress("");
        }
      });
  };
  const prepare = (attempt: NonNullable<typeof lastAttempt.current>) =>
    run(async () => {
      cancel();
      const requestId = randomUUID();
      request.current = requestId;
      lastAttempt.current = attempt;
      const next = await management.prepare({ ...attempt, requestId });
      if (alive.current && request.current === requestId) {
        setReview(next);
        setTrust(false);
        setView("review");
      }
    });
  const commit = () => {
    if (
      !review ||
      review.incompatible ||
      (review.kind !== "install" &&
        review.kind !== "remove" &&
        review.trustRequired &&
        !trust)
    )
      return;
    run(async () => {
      const result = await management.commit({
        requestId: review.requestId,
        digest: review.digest,
        revision: review.revision,
        trust,
        ...(review.kind === "install" || review.kind === "trust"
          ? { enable: trust }
          : {}),
      });
      request.current = undefined;
      setReview(undefined);
      openView(review.kind === "remove" ? "catalog" : "details");
      setSelectedId(result.id);
      await refresh();
      setNotice(
        `${review.kind === "install" && !trust ? "Установлено выключенным. Доверие и запуск доступны в карточке." : "Сохранено."}${result.restartRequired && (review.kind !== "install" || trust) ? " Изменения применятся после перезапуска ChiselCode." : ""}${result.deferred ? " Удаление занятых файлов отложено; пользовательские данные сохранены." : ""}${result.warning ? ` ${result.warning}` : ""}`,
      );
    });
  };
  const saveSettings = (reset = false) => {
    if (!settings || !selected?.digest) return;
    run(async () => {
      const next = await management.settings(
        {
          id: selected.id,
          digest: selected.digest!,
          revision: selected.revision,
        },
        {
          id: selected.id,
          digest: selected.digest!,
          revision: selected.revision,
          settingsRevision: settings.revision,
          values,
          secrets,
          clearSecrets,
          reset,
        },
      );
      setSettings(next);
      setValues(next.values);
      setSecrets({});
      setClearSecrets([]);
      await refresh();
      setNotice(
        next.restartRequired
          ? "Сохранено. Параметры расширения применятся после перезапуска приложения."
          : "Сохранено. Интерфейс расширения обновлён.",
      );
    });
  };
  const action = (name: ExtensionAction) => {
    if (!selected || busy || !selected.actions.includes(name)) return;
    if (name === "settings") {
      if (selected.settingsRoute) onOpenBuiltin(selected.settingsRoute);
      else
        run(async () => {
          const next = await management.settings({
            id: selected.id,
            digest: selected.digest!,
            revision: selected.revision,
          });
          setSettings(next);
          setValues(next.values);
          setSecrets({});
          setClearSecrets([]);
          openView("settings");
        });
    } else if (name === "update") {
      setSourceKind("update");
      setSource("");
      openView("source");
    } else if (name === "versions") {
      openView("versions");
    } else if (name === "remove" || name === "trust")
      prepare({ kind: name, id: selected.id });
    else
      run(async () => {
        const result = await management.setEnabled({
          id: selected.id,
          enabled: name === "enable",
          digest: selected.digest!,
          revision: selected.revision,
          path: root,
        });
        await refresh();
        setNotice(
          result.restartRequired
            ? "Сохранено. Изменения применятся после перезапуска ChiselCode."
            : "Настройка возможности сохранена.",
        );
      });
  };

  const acceptEdit = () => {
    if (!edit) return;
    if (edit.secret) {
      setSecrets({ ...secrets, [edit.name]: input });
      setClearSecrets(clearSecrets.filter((key) => key !== edit.name));
    } else {
      setValues({
        ...values,
        [edit.name]: edit.type === "number" ? Number(input) : input,
      });
    }
    setMenuTarget(`extensions-setting-${edit.name}`);
    setEdit(undefined);
    setInput("");
  };
  const editField = (field: SettingField) => {
    if (field.type === "boolean")
      setValues({ ...values, [field.name]: !values[field.name] });
    else if (field.type === "enum") {
      const options = field.options ?? [];
      const at = options.findIndex(
        (option) => option.value === values[field.name],
      );
      setValues({
        ...values,
        [field.name]: options[(at + 1) % options.length]?.value ?? "",
      });
    } else {
      setEdit(field);
      setInput(field.secret ? "" : String(values[field.name] ?? ""));
    }
  };
  const discardSettings = () => {
    if (settings) setValues(settings.values);
    setSecrets({});
    setClearSecrets([]);
    setEdit(undefined);
    setInput("");
    setNotice("Изменения отменены.");
  };
  const back = () => {
    if (edit) {
      setEdit(undefined);
      setInput("");
      return true;
    }
    if (searching) {
      setSearching(false);
      setMenuTarget(`extensions-item-${visible[0]?.id ?? ""}`);
      return true;
    }
    if (busy || review) {
      const returnView =
        review?.kind === "install" ||
        (view === "source" && sourceKind === "install")
          ? "source"
          : "details";
      cancel();
      openView(returnView);
      setNotice(
        busy
          ? "Отмена запрошена. Уже начавшееся сохранение могло завершиться."
          : "Подтверждение отменено.",
      );
      return true;
    }
    if (view === "settings" && dirty) {
      setNotice(
        "Есть несохранённые изменения. Выберите «Сохранить» или «Отменить изменения».",
      );
      return true;
    }
    if (view === "catalog") return false;
    if (
      view === "details" ||
      view === "filters" ||
      (view === "source" && sourceKind === "install")
    ) {
      openView("catalog", `extensions-item-${selectedId}`);
    } else openView("details");
    return true;
  };
  useLayoutEffect(() => {
    controls.current = {
      save: () => {
        if (view !== "settings") return;
        if (edit) setNotice("Сначала подтвердите значение клавишей Enter.");
        else saveSettings();
      },
      back,
      discard: () => {
        discardSettings();
        cancel();
      },
    };
    return () => {
      controls.current = undefined;
    };
  });

  const compact = width < 40 || height < 10;
  const roomy = width >= 50 && height >= 14;
  const text = (value: string, color = palette.text) => (
    <text key={value} fg={color}>
      {terminalSafeText(value, 8000)}
    </text>
  );
  const digestLines = (digest: string) =>
    digest
      .match(new RegExp(`.{1,${Math.max(4, Math.min(64, width - 4))}}`, "g"))
      ?.join("\n") ?? digest;
  const fieldLabel = (field: SettingField) =>
    `${field.label}: ${
      field.secret
        ? secrets[field.name]
          ? "Новый секрет"
          : clearSecrets.includes(field.name)
            ? "Будет удалён"
            : settings?.secretSet[field.name]
              ? "Сохранён"
              : "Не задан"
        : String(values[field.name] ?? "Не задано")
    }`;
  const startInstall = () => {
    setSourceKind("install");
    setSource("");
    openView("source");
  };
  const prepareSource = () =>
    prepare({
      kind: sourceKind,
      source: source.trim(),
      ...(sourceKind === "update" ? { id: selectedId } : {}),
    });
  const orderedActions: ExtensionAction[] = [
    "trust",
    "enable",
    "disable",
    "settings",
    "update",
    "versions",
    "remove",
  ];
  const entries: MenuEntry[] =
    view === "catalog"
      ? [
          {
            id: "extensions-search",
            label: "Поиск",
            run: () => setSearching(true),
          },
          {
            id: "extensions-install",
            label: compact ? "+ Установить" : "+ Установить расширение",
            run: startInstall,
          },
          {
            id: "extensions-filter",
            label: `${filters[filter]} ▾`,
            run: () => openView("filters"),
          },
          {
            id: "extensions-refresh",
            label: compact ? "↻" : "↻ Обновить",
            run: () => run(refresh),
          },
          ...visible.map(
            (item): MenuEntry => ({
              id: `extensions-item-${item.id}`,
              label: item.name,
              subtitle: `${item.version} · ${EXTENSION_STATE_LABELS[item.state]}`,
              run: () => openDetails(item),
            }),
          ),
        ]
      : view === "filters"
        ? [
            { id: "extensions-back", label: "‹ Каталог", run: back },
            ...filters.map((label, index) => ({
              id: `extensions-filter-${index}`,
              label: `${index === filter ? "●" : "○"} ${label} · ${items.filter((item) => matching(item, index)).length}`,
              run: () => {
                setFilter(index);
                openView("catalog");
              },
            })),
          ]
        : view === "details" && selected
          ? [
              { id: "extensions-back", label: "‹ Каталог", run: back },
              ...orderedActions
                .filter((name) => selected.actions.includes(name))
                .map(
                  (name): MenuEntry => ({
                    id: `extensions-action-${name}`,
                    label: actionLabels[name],
                    tone: name === "remove" ? "error" : undefined,
                    run: () => action(name),
                  }),
                ),
              {
                id: "extensions-metadata",
                label: `${metadata ? "▾" : "▸"} Технические сведения`,
                run: () => setMetadata(!metadata),
              },
            ]
          : view === "source"
            ? [
                { id: "extensions-back", label: "‹ Назад", run: back },
                {
                  id: "extensions-prepare",
                  label: "Проверить пакет",
                  disabled: !source.trim(),
                  run: prepareSource,
                },
              ]
            : view === "review" && review
              ? [
                  ...(review.kind === "remove"
                    ? []
                    : [
                        {
                          id: "extensions-trust",
                          label: `[${trust ? "✓" : " "}] ${compact ? "Доверяю коду" : "Я доверяю этому содержимому"}`,
                          disabled: !!review.incompatible,
                          run: () => setTrust(!trust),
                        },
                      ]),
                  {
                    id: "extensions-commit",
                    label:
                      review.kind === "remove"
                        ? "Удалить расширение"
                        : review.kind === "install" && !trust
                          ? "Установить выключенным"
                          : review.kind === "rollback"
                            ? "Вернуть эту версию"
                            : "Подтвердить",
                    disabled:
                      !!review.incompatible ||
                      (review.kind !== "install" &&
                        review.kind !== "remove" &&
                        review.trustRequired &&
                        !trust),
                    run: commit,
                  },
                  { id: "extensions-cancel", label: "Отмена", run: back },
                ]
              : view === "versions" && selected
                ? [
                    {
                      id: "extensions-back",
                      label: "‹ О расширении",
                      run: back,
                    },
                    ...selected.versions.map((version, index) => ({
                      id: `extensions-version-${index}`,
                      label: `${version.selected ? "● " : ""}${version.version} · ${version.digest.slice(0, 12)}`,
                      subtitle: `${version.selected ? "Выбрана" : "Сохранена"}${version.inUse ? " · используется" : ""}`,
                      run: () =>
                        prepare({
                          kind: "rollback",
                          id: selected.id,
                          versionKey: version.key,
                        }),
                    })),
                  ]
                : view === "settings" && settings
                  ? [
                      {
                        id: "extensions-back",
                        label: "‹ О расширении",
                        run: back,
                      },
                      ...settings.schema.fields.flatMap(
                        (field): MenuEntry[] => [
                          {
                            id: `extensions-setting-${field.name}`,
                            label: fieldLabel(field),
                            run: () => editField(field),
                          },
                          ...(field.secret
                            ? [
                                {
                                  id: `extensions-clear-${field.name}`,
                                  label: "Удалить сохранённый секрет",
                                  run: () => {
                                    setClearSecrets([
                                      ...clearSecrets,
                                      field.name,
                                    ]);
                                    const next = { ...secrets };
                                    delete next[field.name];
                                    setSecrets(next);
                                  },
                                },
                              ]
                            : []),
                        ],
                      ),
                      ...(settings.schema.fields.length
                        ? [
                            {
                              id: "extensions-settings-save",
                              label: "Сохранить",
                              run: () => saveSettings(),
                            },
                            {
                              id: "extensions-settings-discard",
                              label: "Отменить изменения",
                              run: discardSettings,
                            },
                            {
                              id: "extensions-settings-reset",
                              label: "Вернуть значения по умолчанию",
                              run: () => saveSettings(true),
                            },
                            {
                              id: "extensions-settings-reload",
                              label: "Перечитать состояние",
                              run: () =>
                                run(async () => {
                                  if (!selected?.digest) return;
                                  const current = await management.settings({
                                    id: selected.id,
                                    digest: selected.digest,
                                    revision: selected.revision,
                                  });
                                  setSettings(current);
                                  setNotice(
                                    "Состояние перечитано; введённые значения сохранены. Подтвердите сохранение заново.",
                                  );
                                }),
                            },
                          ]
                        : []),
                    ]
                  : [
                      {
                        id: "extensions-back",
                        label: "‹ Каталог",
                        run: () => openView("catalog"),
                      },
                    ];
  if (failed && lastAttempt.current)
    entries.push({
      id: "extensions-retry",
      label: "Повторить проверку",
      run: () => {
        if (lastAttempt.current) prepare(lastAttempt.current);
      },
    });
  const defaultTarget =
    view === "catalog"
      ? `extensions-item-${visible.find((item) => item.id === selectedId)?.id ?? visible[0]?.id}`
      : view === "details"
        ? entries[1]?.id
        : view === "review"
          ? "extensions-commit"
          : entries[1]?.id;
  const target =
    entries.find((entry) => entry.id === menuTarget) ??
    entries.find((entry) => entry.id === defaultTarget) ??
    entries[0];
  const invoke = (entry: MenuEntry) => {
    if (
      !active ||
      entry.disabled ||
      (busy && !["extensions-cancel", "extensions-back"].includes(entry.id))
    )
      return;
    onFocus();
    setMenuTarget(entry.id);
    entry.run();
  };
  const button = (
    id: string,
    options: {
      primary?: boolean;
      subtitle?: string;
      label?: string;
      trailing?: { label: string; tone?: MenuEntry["tone"] };
    } = {},
  ) => {
    const entry = entries.find((item) => item.id === id);
    return entry ? (
      <DialogAction
        key={id}
        id={id}
        label={terminalLine(
          options.label ?? entry.label,
          Math.max(1, width - 2),
        )}
        subtitle={
          options.subtitle
            ? terminalLine(options.subtitle, Math.max(1, width - 2))
            : undefined
        }
        palette={palette}
        active={target?.id === id && focused}
        primary={options.primary}
        tone={entry.tone}
        trailing={options.trailing}
        disabled={
          entry.disabled ||
          (busy && !["extensions-cancel", "extensions-back"].includes(id))
        }
        onSelect={() => invoke(entry)}
      />
    ) : null;
  };
  const targetId = target?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Resizing must reveal the selected action or native editor after layout.
  useLayoutEffect(() => {
    if (active)
      pendingScroll.current =
        view === "source"
          ? "extensions-source"
          : edit
            ? `extensions-editor-${edit.name}`
            : targetId;
  }, [active, targetId, edit, view, width, height]);
  useUiKeyboard((key) => {
    if (
      !active ||
      !focused ||
      key.ctrl ||
      key.meta ||
      key.option ||
      ["escape", "tab", "f2"].includes(key.name)
    )
      return;
    const name = key.name.toLowerCase();
    if (edit || view === "source") return;
    if (searching) {
      if (name === "down" || name === "up") {
        key.preventDefault();
        setSearching(false);
        setMenuTarget(`extensions-item-${visible[0]?.id}`);
      }
      return;
    }
    if (name === "pageup" || name === "pagedown") {
      key.preventDefault();
      detailScroll.current?.scrollBy(
        (name === "pageup" ? -1 : 1) * Math.max(1, height - 4),
      );
    } else if (
      name === "up" ||
      name === "down" ||
      name === "home" ||
      name === "end"
    ) {
      key.preventDefault();
      const index = entries.findIndex((entry) => entry.id === target?.id);
      const next =
        name === "home"
          ? 0
          : name === "end"
            ? entries.length - 1
            : Math.max(
                0,
                Math.min(entries.length - 1, index + (name === "up" ? -1 : 1)),
              );
      setMenuTarget(entries[next]?.id ?? "");
      const item = visible.find(
        (item) => `extensions-item-${item.id}` === entries[next]?.id,
      );
      if (item && view === "catalog") setSelectedId(item.id);
    } else if (name === "return" || name === "space") {
      key.preventDefault();
      if (target) invoke(target);
    } else if (name === "/" && view === "catalog") {
      key.preventDefault();
      setSearching(true);
    }
  });
  const noticeRows = notice
    ? Math.min(
        compact ? 1 : 3,
        Math.max(1, height - 4),
        Math.max(1, Math.ceil(stringWidth(notice) / Math.max(1, width))),
      )
    : 0;
  const title =
    view === "catalog"
      ? ""
      : view === "filters"
        ? "Показать расширения"
        : view === "details"
          ? "О расширении"
          : view === "settings"
            ? "Параметры расширения"
            : view === "versions"
              ? "Сохранённые версии"
              : view === "review"
                ? "Проверка пакета"
                : sourceKind === "install"
                  ? "Установка расширения"
                  : "Обновление расширения";
  return (
    <box
      id="extensions-panel"
      width="100%"
      height={height}
      flexDirection="column"
      overflow="hidden"
    >
      {busy && (
        <text height={1} flexShrink={0} fg={palette.accent}>
          {terminalLine(`Выполняется… ${progress}`, width)}
        </text>
      )}
      {notice && (
        <box height={noticeRows} flexShrink={0} overflow="hidden">
          <text fg={failed ? palette.red : palette.yellow}>
            {terminalSafeText(
              compact ? terminalLine(notice, width) : notice,
              1200,
            )}
          </text>
        </box>
      )}
      {view !== "catalog" && (
        <box
          height={1}
          flexShrink={0}
          flexDirection="row"
          justifyContent="space-between"
        >
          {view === "review" ? (
            <text height={1} fg={palette.accent}>
              {title}
            </text>
          ) : (
            button("extensions-back")
          )}
          {!compact && view !== "review" && (
            <text height={1} fg={palette.muted}>
              {title}
            </text>
          )}
        </box>
      )}
      {view === "catalog" && (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Enter focuses the same native search input. */}
          <box
            height={1}
            flexShrink={0}
            backgroundColor={palette.raised}
            onMouseDown={() => {
              onFocus();
              setSearching(true);
              setMenuTarget("extensions-search");
            }}
          >
            <input
              id="extensions-search"
              value={query}
              onInput={(value) => {
                setQuery(cleanSettingsInput(value));
                setMenuTarget("");
              }}
              onSubmit={() => {
                setSearching(false);
                setMenuTarget(`extensions-item-${visible[0]?.id}`);
              }}
              focused={active && focused && searching && !busy}
              placeholder="Поиск расширений…"
              backgroundColor={palette.raised}
              focusedBackgroundColor={palette.raised}
              textColor={palette.text}
              focusedTextColor={palette.text}
              placeholderColor={palette.muted}
            />
          </box>
          <box
            height={1}
            flexShrink={0}
            flexDirection="row"
            justifyContent="space-between"
            marginTop={roomy ? 1 : 0}
          >
            {button("extensions-install", { primary: true })}
            {button("extensions-filter")}
            {width >= 30 && button("extensions-refresh")}
          </box>
          {roomy && (
            <text height={1} marginTop={1} fg={palette.muted}>
              Показано {visible.length} из {items.length} · Выберите расширение
            </text>
          )}
        </>
      )}
      <TerminalScrollbox
        key={view}
        ref={detailScroll}
        flexGrow={1}
        minHeight={0}
        width="100%"
        viewportCulling
        scrollX={false}
        horizontalScrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{ visible: !compact }}
        renderBefore={() => {
          if (!pendingScroll.current || !detailScroll.current?.scrollHeight)
            return;
          detailScroll.current.scrollChildIntoView(pendingScroll.current);
          pendingScroll.current = undefined;
        }}
      >
        <box flexDirection="column" gap={roomy ? 1 : 0}>
          {view === "catalog" ? (
            <>
              {!loaded && text("Загружаем расширения…", palette.muted)}
              {loaded &&
                !visible.length &&
                text(
                  query
                    ? "Ничего не найдено. Измените запрос или фильтр."
                    : "В этой группе пока нет расширений.",
                  palette.muted,
                )}
              {visible.map((item) =>
                button(`extensions-item-${item.id}`, {
                  label: terminalLine(
                    item.name,
                    Math.max(
                      1,
                      width -
                        (roomy
                          ? stringWidth(EXTENSION_STATE_LABELS[item.state]) + 5
                          : 4),
                    ),
                  ),
                  trailing: roomy
                    ? {
                        label: EXTENSION_STATE_LABELS[item.state],
                        tone: stateTone(item),
                      }
                    : undefined,
                  subtitle: roomy
                    ? `${item.version} · ${item.origin === "builtin" ? "Встроенное" : "Установлено"} · ${item.description}`
                    : `${item.version} · ${EXTENSION_STATE_LABELS[item.state]}`,
                }),
              )}
            </>
          ) : view === "filters" ? (
            entries
              .filter((entry) => entry.id.startsWith("extensions-filter-"))
              .map((entry) => button(entry.id))
          ) : view === "details" && selected ? (
            <>
              <text height={1} fg={palette.accent}>
                <strong>
                  {terminalLine(
                    `${selected.name} · ${selected.version}`,
                    width,
                  )}
                </strong>
              </text>
              {text(
                EXTENSION_STATE_LABELS[selected.state],
                stateTone(selected) === "error"
                  ? palette.red
                  : stateTone(selected) === "warning"
                    ? palette.yellow
                    : selected.state === "working"
                      ? palette.green
                      : palette.muted,
              )}
              {text(
                terminalLine(
                  selected.description,
                  Math.max(1, width * (compact ? 2 : 3)),
                ),
              )}
              {text(`Сейчас: ${selected.actualLabel}`, palette.muted)}
              {selected.reason && text(selected.reason, palette.yellow)}
              {selected.restartRequired &&
                text(
                  "Изменения применятся после перезапуска ChiselCode.",
                  palette.yellow,
                )}
              {selected.deferredRemoval &&
                text(
                  "Удаление занятых файлов отложено; пользовательские данные сохранены.",
                  palette.yellow,
                )}
              <box
                id="extensions-actions"
                flexDirection="column"
                marginTop={roomy ? 1 : 0}
              >
                {orderedActions
                  .filter((name) => selected.actions.includes(name))
                  .map((name) => button(`extensions-action-${name}`))}
              </box>
              {button("extensions-metadata")}
              {metadata &&
                text(
                  `ID: ${selected.id}\nИсточник: ${selected.source}\nСовместимость: ${selected.compatibility}\nДоверие: ${selected.trusted ? "Подтверждено" : "Не выдано"}\nСохранено: ${selected.desiredEnabled ? "Включено" : "Выключено"}${selected.digest ? `\nSHA-256:\n${digestLines(selected.digest)}` : ""}`,
                  palette.muted,
                )}
            </>
          ) : view === "source" ? (
            <box flexDirection="column" gap={compact ? 0 : 1}>
              {text(
                sourceKind === "install"
                  ? "Укажите папку готового расширения или ZIP."
                  : `Новый пакет для ${selected?.name}`,
              )}
              <input
                id="extensions-source"
                value={source}
                focused={active && focused && !busy}
                onInput={(value) => setSource(cleanSettingsInput(value))}
                onSubmit={prepareSource}
                backgroundColor={palette.raised}
                focusedBackgroundColor={palette.raised}
                textColor={palette.text}
                focusedTextColor={palette.text}
                placeholder="Путь к папке или ZIP…"
              />
              {button("extensions-prepare", { primary: true })}
              {text(
                "Проверка читает пакет без запуска его кода. Перед установкой появится подтверждение.",
                palette.muted,
              )}
            </box>
          ) : view === "review" && review ? (
            <>
              <text fg={palette.accent}>
                <strong>
                  {terminalSafeText(
                    `${review.name} · ${review.oldVersion ? review.oldVersion + " → " : ""}${review.version}`,
                  )}
                </strong>
              </text>
              {text(
                `${review.description}\nID: ${review.id}\n${review.incompatible ?? "Совместим"} · ${review.compatibility}\n${review.location}\nSHA-256:\n${digestLines(review.digest)}\n${review.files} файлов · ${review.bytes} байт\nentry: ${review.entry}`,
              )}
              {review.oldDigest &&
                review.oldDigest !== review.digest &&
                text(
                  `Новое содержимое. Прежний SHA-256:\n${digestLines(review.oldDigest)}`,
                  palette.yellow,
                )}
              {text(
                review.kind === "remove"
                  ? "Подключение будет удалено. Занятые файлы сохраняются до выхода; пользовательские данные и история остаются."
                  : "Доверенный JS получает доступ процесса к файлам, сети и запуску программ. SHA-256 не подтверждает автора.",
                palette.yellow,
              )}
              {review.contents.map((file) =>
                text(
                  `${file.path} · ${file.bytes} байт · ${file.digest.slice(0, 12)}`,
                ),
              )}
            </>
          ) : view === "versions" && selected ? (
            <>
              {text(
                "Выберите версию, чтобы проверить её перед возвратом.",
                palette.muted,
              )}
              {selected.versions.map((_version, index) =>
                button(`extensions-version-${index}`, {
                  subtitle: entries.find(
                    (entry) => entry.id === `extensions-version-${index}`,
                  )?.subtitle,
                }),
              )}
            </>
          ) : view === "settings" && settings ? (
            <>
              {text(selected?.name ?? "", palette.accent)}
              {!settings.schema.fields.length &&
                text("У этого расширения нет настроек.", palette.muted)}
              {settings.unknownKeys.length > 0 &&
                text(
                  `Сохранены неизвестные поля: ${settings.unknownKeys.join(", ")}`,
                  palette.yellow,
                )}
              {settings.issues.map((issue) => text(issue, palette.yellow))}
              {settings.schema.fields.map((field) => (
                <box key={field.name} flexDirection="column">
                  {button(`extensions-setting-${field.name}`)}
                  {field.description &&
                    !compact &&
                    text(field.description, palette.muted)}
                  {field.secret && button(`extensions-clear-${field.name}`)}
                  {edit?.name === field.name && (
                    <box
                      id={`extensions-editor-${field.name}`}
                      flexDirection="column"
                      marginTop={compact ? 0 : 1}
                    >
                      {edit.secret ? (
                        <SettingsSecretInput
                          value={input}
                          onChange={setInput}
                          onSubmit={acceptEdit}
                          palette={palette}
                          active={active && focused}
                        />
                      ) : (
                        <input
                          id="extensions-setting-input"
                          value={input}
                          onInput={(value) =>
                            setInput(cleanSettingsInput(value))
                          }
                          onSubmit={acceptEdit}
                          focused={active && focused}
                          backgroundColor={palette.raised}
                          textColor={palette.text}
                        />
                      )}
                      {text("Enter подтвердить · Esc отменить", palette.muted)}
                    </box>
                  )}
                </box>
              ))}
              {settings.schema.fields.length > 0 && (
                <box flexDirection="column" marginTop={roomy ? 1 : 0}>
                  {button("extensions-settings-save", { primary: true })}
                  {button("extensions-settings-discard")}
                  {button("extensions-settings-reset")}
                  {button("extensions-settings-reload")}
                </box>
              )}
              {text(
                settings.restartRequired
                  ? "Параметры применяются после перезапуска приложения."
                  : "Параметры применяются сразу после сохранения.",
                palette.muted,
              )}
            </>
          ) : (
            text(
              "Расширение недоступно. Вернитесь в каталог и обновите список.",
              palette.yellow,
            )
          )}
          {button("extensions-retry")}
        </box>
      </TerminalScrollbox>
      {view === "review" && review && (
        <box flexDirection="column" flexShrink={0}>
          {button("extensions-trust")}
          {button("extensions-commit", { primary: true })}
          {button("extensions-cancel")}
        </box>
      )}
      <text height={1} flexShrink={0} fg={palette.muted}>
        {terminalLine(
          edit
            ? "Enter подтвердить · Esc отменить"
            : view === "source"
              ? "Enter проверить · Esc назад"
              : searching
                ? "Enter к списку · Esc назад"
                : compact
                  ? "↑↓ · Enter · Esc назад"
                  : view === "catalog"
                    ? "↑↓ выбор · Enter открыть · Esc назад"
                    : "↑↓ действие · Enter выбрать · Esc назад",
          width,
        )}
      </text>
    </box>
  );
}
