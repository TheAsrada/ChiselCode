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
import type { SettingsPanelControl } from "./opentui-lsp-settings.js";
import {
  cleanSettingsInput,
  SettingsSecretInput,
} from "./opentui-settings-input.js";
import { useUiKeyboard } from "./overlay-input.js";
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
type View = "catalog" | "source" | "review" | "versions" | "settings";
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
}) {
  const [items, setItems] = useState<CatalogExtension[]>([]),
    [selectedId, setSelectedId] = useState(""),
    [filter, setFilter] = useState(0),
    [query, setQuery] = useState(""),
    [searching, setSearching] = useState(false);
  const [view, setView] = useState<View>("catalog"),
    [detail, setDetail] = useState(false),
    [source, setSource] = useState(""),
    [sourceKind, setSourceKind] = useState<"install" | "update">("install");
  const [review, setReview] = useState<ExtensionReview>(),
    [trust, setTrust] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [progress, setProgress] = useState("");
  const [failed, setFailed] = useState(false);
  const [settings, setSettings] = useState<ExtensionSettings>(),
    [values, setValues] = useState<Record<string, SettingValue>>({}),
    [secrets, setSecrets] = useState<Record<string, string>>({}),
    [clearSecrets, setClearSecrets] = useState<string[]>([]);
  const [fieldIndex, setFieldIndex] = useState(0),
    [edit, setEdit] = useState<SettingField>(),
    [input, setInput] = useState(""),
    [versionIndex, setVersionIndex] = useState(0);
  const pending = useRef(false),
    request = useRef<string | undefined>(undefined),
    alive = useRef(true),
    detailScroll = useRef<ScrollBoxRenderable | null>(null),
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
      clearSecrets.length > 0);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  const selected = items.find((i) => i.id === selectedId);
  const visible = items.filter(
    (i) =>
      `${i.name} ${i.id}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()) &&
      (filter === 0 ||
        (filter === 1 && i.origin === "builtin") ||
        (filter === 2 && i.origin === "installed") ||
        (filter === 3 &&
          (i.state === "error" ||
            i.state === "not_trusted" ||
            i.restartRequired ||
            i.projectBlocked ||
            i.deferredRemoval))),
  );
  const refresh = useCallback(async () => {
    const list = await management.list(root);
    if (alive.current) {
      setItems(list.items);
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
      setView("catalog");
      setSelectedId(result.id);
      await refresh();
      setNotice(
        `Сохранено.${result.restartRequired ? " Примените через перезапуск ChiselCode: сначала дождитесь задач или остановите их; сохраните черновик. Загруженный JS продолжает работать до выхода." : ""}${result.deferred ? " Удаление занятых файлов отложено. Пользовательские данные сохранены." : ""}${result.warning ? " " + result.warning : ""}`,
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
        "Сохранено. Параметры расширения применятся после перезапуска приложения.",
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
          setFieldIndex(0);
          setView("settings");
        });
    } else if (name === "update") {
      setSourceKind("update");
      setSource("");
      setView("source");
    } else if (name === "versions") {
      setVersionIndex(0);
      setView("versions");
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
            ? "Сохранено. Примените через перезапуск приложения после завершения задач; сохраните черновик."
            : "Настройка возможности сохранена.",
        );
      });
  };
  const back = () => {
    if (busy || review) {
      cancel();
      setView("catalog");
      setNotice("Операция отменена; прежняя версия сохранена.");
      return true;
    }
    if (edit) {
      setEdit(undefined);
      setInput("");
      return true;
    }
    if (searching) {
      setSearching(false);
      return true;
    }
    if (view !== "catalog") {
      if (dirty) {
        setNotice("Сохраните или отмените изменения перед возвратом.");
        return true;
      }
      setView("catalog");
      return true;
    }
    if (detail && width < 65) {
      setDetail(false);
      return true;
    }
    return false;
  };
  useLayoutEffect(() => {
    controls.current = {
      save: () => saveSettings(),
      back,
      discard: () => {
        if (settings) setValues(settings.values);
        setSecrets({});
        setClearSecrets([]);
        setEdit(undefined);
        cancel();
      },
    };
    return () => {
      controls.current = undefined;
    };
  });
  const acceptEdit = () => {
    if (!edit) return;
    if (edit.secret) {
      setSecrets({ ...secrets, [edit.name]: input });
      setClearSecrets(clearSecrets.filter((k) => k !== edit.name));
    } else
      setValues({
        ...values,
        [edit.name]: edit.type === "number" ? Number(input) : input,
      });
    setEdit(undefined);
    setInput("");
  };
  const editField = (index: number) => {
    const f = settings?.schema.fields[index];
    if (!f) return;
    setFieldIndex(index);
    if (f.type === "boolean")
      setValues({ ...values, [f.name]: !values[f.name] });
    else if (f.type === "enum") {
      const options = f.options ?? [],
        at = options.findIndex((o) => o.value === values[f.name]);
      setValues({
        ...values,
        [f.name]: options[(at + 1) % options.length]?.value ?? "",
      });
    } else {
      setEdit(f);
      setInput(f.secret ? "" : String(values[f.name] ?? ""));
    }
  };
  useUiKeyboard((key) => {
    if (
      !active ||
      !focused ||
      key.ctrl ||
      key.name === "escape" ||
      key.name === "tab"
    )
      return;
    if (view === "source" || searching || edit) return;
    const name = key.name.toLowerCase();
    if (name === "pageup" || name === "pagedown") {
      key.preventDefault();
      detailScroll.current?.scrollBy(
        name === "pageup" ? -Math.max(1, height - 3) : Math.max(1, height - 3),
      );
      return;
    }
    if (["up", "down"].includes(name)) {
      key.preventDefault();
      const delta = name === "up" ? -1 : 1;
      if (view === "settings")
        setFieldIndex(
          Math.max(
            0,
            Math.min(
              (settings?.schema.fields.length ?? 1) - 1,
              fieldIndex + delta,
            ),
          ),
        );
      else if (view === "versions")
        setVersionIndex(
          Math.max(
            0,
            Math.min(
              (selected?.versions.length ?? 1) - 1,
              versionIndex + delta,
            ),
          ),
        );
      else {
        const at = visible.findIndex((i) => i.id === selectedId);
        setSelectedId(
          visible[Math.max(0, Math.min(visible.length - 1, at + delta))]?.id ??
            selectedId,
        );
      }
    } else if (name === "return") {
      key.preventDefault();
      if (view === "review") commit();
      else if (view === "settings") editField(fieldIndex);
      else if (view === "versions" && selected?.versions[versionIndex])
        prepare({
          kind: "rollback",
          id: selected.id,
          versionKey: selected.versions[versionIndex]!.key,
        });
      else setDetail(true);
    } else if (name === "t" && view === "review") {
      key.preventDefault();
      setTrust(!trust);
    } else if (name === "f" && view === "catalog") {
      key.preventDefault();
      setFilter((filter + 1) % filters.length);
    } else if (name === "/" && view === "catalog") {
      key.preventDefault();
      setSearching(true);
    } else if (name === "i" && view === "catalog") {
      key.preventDefault();
      setSourceKind("install");
      setSource("");
      setView("source");
    } else if (view === "settings" && name === "r") {
      key.preventDefault();
      saveSettings(true);
    } else if (view === "settings" && name === "d" && settings) {
      key.preventDefault();
      setValues(settings.values);
      setSecrets({});
      setClearSecrets([]);
    } else if (name === "r" && failed && notice && lastAttempt.current) {
      key.preventDefault();
      prepare(lastAttempt.current);
    } else if (view === "catalog") {
      const map: Record<string, ExtensionAction> = {
        e: selected?.desiredEnabled ? "disable" : "enable",
        s: "settings",
        u: "update",
        v: "versions",
        delete: "remove",
        t: "trust",
      };
      if (map[name]) {
        key.preventDefault();
        action(map[name]!);
      }
    }
  });
  const text = (value: string, color = palette.text) => (
    <text key={value} fg={color}>
      {terminalSafeText(value, 8000)}
    </text>
  );
  const digestLines = (digest: string) =>
    digest
      .match(new RegExp(`.{1,${Math.max(8, Math.min(64, width - 4))}}`, "g"))
      ?.join("\n") ?? digest;
  const listWidth = Math.min(32, Math.floor(width * 0.4)),
    wide = width >= 65;
  const compact = width < 40 || height < 10;
  const noticeRows = notice
    ? compact
      ? 1
      : Math.min(3, Math.max(1, height - 5))
    : 0;
  const listCount = Math.max(
    1,
    Math.floor((height - (compact ? 3 : 4) - (busy ? 1 : 0) - noticeRows) / 2),
  );
  const listStart = Math.max(
    0,
    Math.min(
      visible.findIndex((i) => i.id === selectedId) - listCount + 1,
      visible.length - listCount,
    ),
  );
  return (
    <box
      id="extensions-panel"
      width="100%"
      height={height}
      flexDirection="column"
      overflow="hidden"
    >
      {busy && text(`Выполняется… ${progress}`, palette.accent)}
      {notice && (
        <box height={noticeRows} flexShrink={0}>
          {text(compact ? terminalLine(notice, width) : notice, palette.yellow)}
        </box>
      )}
      {view === "source" ? (
        <box flexDirection="column" gap={1}>
          {text(
            sourceKind === "install"
              ? "Установить: путь к подготовленной папке или ZIP"
              : `Обновить ${selected?.name}: путь к новому пакету`,
          )}
          <input
            id="extensions-source"
            value={source}
            focused={active && focused && !busy}
            onInput={(v) => setSource(cleanSettingsInput(v))}
            onSubmit={() =>
              prepare({
                kind: sourceKind,
                source: source.trim(),
                ...(sourceKind === "update" ? { id: selectedId } : {}),
              })
            }
            backgroundColor={palette.raised}
            textColor={palette.text}
          />
          <DialogAction
            id="extensions-prepare"
            label="Проверить пакет (Enter)"
            palette={palette}
            disabled={busy || !source.trim()}
            onSelect={() =>
              prepare({
                kind: sourceKind,
                source: source.trim(),
                ...(sourceKind === "update" ? { id: selectedId } : {}),
              })
            }
          />
          {text(
            "Проверка не выполняет JavaScript и не обращается к модели.",
            palette.muted,
          )}
        </box>
      ) : view === "review" && review ? (
        <TerminalScrollbox ref={detailScroll} width="100%" height="100%">
          <box flexDirection="column" gap={1}>
            {text(
              `${review.name} · ${review.oldVersion ? review.oldVersion + " → " : ""}${review.version}`,
              palette.accent,
            )}
            {text(
              `ID: ${review.id}\n${review.description}\n${review.incompatible ?? "Совместим"} · ${review.compatibility}\n${review.location}\nSHA-256:\n${digestLines(review.digest)}\n${review.files} файлов · ${review.bytes} байт\nentry: ${review.entry}`,
            )}
            {review.oldDigest &&
              review.oldDigest !== review.digest &&
              text(
                `Новое содержимое. Прежний SHA-256:\n${digestLines(review.oldDigest)}`,
                palette.yellow,
              )}
            {review.kind === "remove" ? (
              text(
                "Подключение будет удалено. Занятые файлы сохраняются до выхода; пользовательские данные и история остаются.",
                palette.yellow,
              )
            ) : (
              <>
                {text(
                  "Доверенный JS получает доступ процесса к файлам, сети и запуску программ. SHA-256 не подтверждает автора.",
                  palette.yellow,
                )}
                <DialogAction
                  id="extensions-trust"
                  label={`[${trust ? "*" : " "}] Я доверяю этому содержимому (T)`}
                  palette={palette}
                  active={trust}
                  disabled={busy || !!review.incompatible}
                  onSelect={() => setTrust(!trust)}
                />
              </>
            )}
            <DialogAction
              id="extensions-commit"
              label={
                review.kind === "remove"
                  ? "Удалить (Enter)"
                  : review.kind === "install" && !trust
                    ? "Установить без доверия (Enter)"
                    : review.kind === "rollback"
                      ? "Вернуть эту версию (Enter)"
                      : "Подтвердить (Enter)"
              }
              palette={palette}
              primary
              disabled={
                busy ||
                !!review.incompatible ||
                (review.kind !== "install" &&
                  review.kind !== "remove" &&
                  review.trustRequired &&
                  !trust)
              }
              onSelect={commit}
            />
            <DialogAction
              id="extensions-cancel"
              label="Отмена (Esc)"
              palette={palette}
              onSelect={back}
            />
            {review.contents.map((f) =>
              text(`${f.path} · ${f.bytes} байт · ${f.digest.slice(0, 12)}`),
            )}
          </box>
        </TerminalScrollbox>
      ) : view === "versions" && selected ? (
        <TerminalScrollbox ref={detailScroll} width="100%" height="100%">
          <box flexDirection="column">
            {text(
              "Версии · Enter проверяет выбранный rollback",
              palette.accent,
            )}
            {selected.versions.map((v, i) => (
              <DialogAction
                key={v.key}
                id={`extensions-version-${i}`}
                active={versionIndex === i}
                label={`${v.selected ? "* " : ""}${v.version} · ${v.digest.slice(0, 12)}${v.inUse ? " · используется" : ""}`}
                palette={palette}
                onSelect={() =>
                  prepare({
                    kind: "rollback",
                    id: selected.id,
                    versionKey: v.key,
                  })
                }
              />
            ))}
          </box>
        </TerminalScrollbox>
      ) : view === "settings" && settings ? (
        <TerminalScrollbox ref={detailScroll} width="100%" height="100%">
          <box flexDirection="column" gap={1}>
            {text(`Настройки · ${selected?.name}`, palette.accent)}
            {!settings.schema.fields.length &&
              text("У этого расширения нет настроек.")}
            {settings.unknownKeys.length > 0 &&
              text(
                `Сохранены неизвестные поля: ${settings.unknownKeys.join(", ")}`,
                palette.yellow,
              )}
            {settings.issues.map((issue) => text(issue, palette.yellow))}
            {settings.schema.fields.map((f, i) => (
              <box key={f.name} flexDirection="column">
                <DialogAction
                  id={`extensions-setting-${f.name}`}
                  label={`${f.label}: ${f.secret ? (secrets[f.name] ? "Новый секрет" : clearSecrets.includes(f.name) ? "Будет удалён" : settings.secretSet[f.name] ? "Сохранён" : "Не задан") : String(values[f.name] ?? "Не задано")}`}
                  palette={palette}
                  active={fieldIndex === i}
                  disabled={busy}
                  onSelect={() => editField(i)}
                />
                {f.description && text(f.description, palette.muted)}
                {f.secret && (
                  <DialogAction
                    label="Сбросить секрет"
                    palette={palette}
                    disabled={busy}
                    onSelect={() => {
                      setClearSecrets([...clearSecrets, f.name]);
                      const next = { ...secrets };
                      delete next[f.name];
                      setSecrets(next);
                    }}
                  />
                )}
              </box>
            ))}
            {edit && (
              <box flexDirection="column">
                {text(edit.label)}
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
                    value={input}
                    onInput={setInput}
                    onSubmit={acceptEdit}
                    focused={active && focused}
                    backgroundColor={palette.raised}
                    textColor={palette.text}
                  />
                )}
              </box>
            )}
            {settings.schema.fields.length > 0 && (
              <box flexDirection="row" gap={1}>
                <DialogAction
                  id="extensions-settings-save"
                  label="Сохранить (F2)"
                  palette={palette}
                  disabled={busy}
                  onSelect={() => saveSettings()}
                />
                <DialogAction
                  id="extensions-settings-reset"
                  label="Сбросить (R)"
                  palette={palette}
                  disabled={busy}
                  onSelect={() => saveSettings(true)}
                />
                <DialogAction
                  id="extensions-settings-discard"
                  label="Отменить изменения (D)"
                  palette={palette}
                  disabled={busy}
                  onSelect={() => {
                    setValues(settings.values);
                    setSecrets({});
                    setClearSecrets([]);
                    setEdit(undefined);
                    setInput("");
                  }}
                />
                <DialogAction
                  id="extensions-settings-refresh"
                  label="Перечитать, сохранив ввод"
                  palette={palette}
                  disabled={busy}
                  onSelect={() =>
                    run(async () => {
                      if (selected?.digest) {
                        const current = await management.settings({
                          id: selected.id,
                          digest: selected.digest,
                          revision: selected.revision,
                        });
                        setSettings(current);
                        setNotice(
                          "Состояние перечитано; введённые значения сохранены. Подтвердите сохранение заново.",
                        );
                      }
                    })
                  }
                />
              </box>
            )}
            {text(
              "Параметры применяются после перезапуска приложения.",
              palette.muted,
            )}
          </box>
        </TerminalScrollbox>
      ) : (
        <>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <DialogAction
              id="extensions-install"
              label={compact ? "Установить (I)" : "Установить (I)"}
              palette={palette}
              disabled={busy}
              onSelect={() => {
                setSourceKind("install");
                setSource("");
                setView("source");
              }}
            />
            {!compact && (
              <DialogAction
                id="extensions-refresh"
                label="Обновить список"
                palette={palette}
                disabled={busy}
                onSelect={() => run(refresh)}
              />
            )}
          </box>
          {searching ? (
            <input
              id="extensions-search"
              value={query}
              onInput={setQuery}
              onSubmit={() => setSearching(false)}
              focused={active && focused}
              placeholder="Найти расширение"
              backgroundColor={palette.raised}
              textColor={palette.text}
            />
          ) : !compact ? (
            <DialogAction
              label={`Поиск (/): ${query || "Все"}`}
              palette={palette}
              onSelect={() => setSearching(true)}
            />
          ) : null}
          <box flexDirection="row" flexShrink={0}>
            <DialogAction
              id="extensions-filter"
              label={
                compact
                  ? `${filters[filter]} (F)`
                  : `Фильтр (F): ${filters[filter]}`
              }
              palette={palette}
              onSelect={() => setFilter((filter + 1) % filters.length)}
            />
          </box>
          <box flexDirection="row" flexGrow={1} minHeight={0}>
            {(wide || !detail) && (
              <TerminalScrollbox
                width={wide ? listWidth : "100%"}
                height="100%"
              >
                <box flexDirection="column">
                  {!visible.length &&
                    text("Нет расширений по фильтру.", palette.muted)}
                  {visible.slice(listStart, listStart + listCount).map((i) => (
                    <DialogAction
                      key={i.id}
                      id={`extensions-item-${i.id}`}
                      label={terminalLine(
                        i.name,
                        wide ? listWidth - 2 : width - 2,
                      )}
                      subtitle={terminalLine(
                        `${i.version} · ${EXTENSION_STATE_LABELS[i.state]}`,
                        wide ? listWidth - 2 : width - 2,
                      )}
                      palette={palette}
                      active={i.id === selectedId}
                      onSelect={() => {
                        setSelectedId(i.id);
                        setDetail(true);
                      }}
                    />
                  ))}
                </box>
              </TerminalScrollbox>
            )}
            {(wide || detail) && (
              <TerminalScrollbox
                ref={detailScroll}
                width={wide ? width - listWidth : "100%"}
                height="100%"
              >
                <box flexDirection="column" gap={1}>
                  {selected ? (
                    <>
                      {text(
                        compact
                          ? terminalLine(selected.name, width)
                          : `${selected.name} · ${selected.version}`,
                        palette.accent,
                      )}
                      {text(
                        compact
                          ? terminalLine(
                              `${selected.version} · ${EXTENSION_STATE_LABELS[selected.state]}`,
                              width,
                            )
                          : EXTENSION_STATE_LABELS[selected.state],
                      )}
                      {text(
                        `${selected.description}\nID: ${selected.id}\nИсточник: ${selected.source}\nСовместимость: ${selected.compatibility}\nДоверие: ${selected.trusted ? "Подтверждено" : "Не выдано"}\nСохранено: ${selected.desiredEnabled ? "Включено" : "Выключено"}\nСейчас: ${selected.actualLabel}`,
                      )}
                      {selected.reason && text(selected.reason, palette.yellow)}
                      {selected.restartRequired &&
                        text(
                          "Загруженная версия сохраняется до выхода. Дождитесь задач или остановите их; сохраните черновик и перезапустите ChiselCode.",
                          palette.yellow,
                        )}
                      {selected.deferredRemoval &&
                        text(
                          "Удаление занятых файлов отложено; пользовательские данные сохранены.",
                          palette.yellow,
                        )}
                      {selected.actions.map((a) => (
                        <DialogAction
                          key={a}
                          id={`extensions-action-${a}`}
                          label={actionLabels[a]}
                          palette={palette}
                          disabled={busy}
                          onSelect={() => action(a)}
                        />
                      ))}
                    </>
                  ) : (
                    text("Выберите расширение.", palette.muted)
                  )}
                </box>
              </TerminalScrollbox>
            )}
          </box>
        </>
      )}
      <text height={1} fg={palette.muted}>
        {terminalLine(
          "↑↓ выбор · Enter детали · I установка · E вкл · S настройки · U обновить · V версии · Esc назад",
          width,
        )}
      </text>
    </box>
  );
}
