/** @jsxImportSource @opentui/react */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  FileDiff,
  JsonObject,
  ToolExecutionResult,
} from "../types/domain.js";
import type { WorktreeDescriptor } from "../worktrees/service.js";
import type { Palette } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { FileDiffCard } from "./opentui-file-diff.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { createTerminalClipboard } from "./terminal-clipboard.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";
import {
  sameWorktreePath,
  type WorktreeManagerActions,
  worktreeKey,
  worktreeOwned,
  worktreeRemoveBlock,
} from "./worktree-actions.js";

type Page =
  | "list"
  | "detail"
  | "create"
  | "create-review"
  | "diff"
  | "apply"
  | "remove"
  | "tabs"
  | "info"
  | "diagnostic";
const labels: Record<string, string> = {
  ready: "Готова",
  creating: "Создание не завершено",
  removing: "Удаление не завершено",
  removed: "Удалена",
  missing: "Не найдена",
  recovery_required: "Нужна проверка",
  failed: "Не создана",
};
const role = (item: WorktreeDescriptor) =>
  item.kind === "origin"
    ? "Основной проект"
    : worktreeOwned(item)
      ? "Копия ChiselCode"
      : "Другая копия Git";
const summary = (item: WorktreeDescriptor): string => {
  if (!worktreeOwned(item)) return role(item);
  if (item.state !== "ready") return labels[item.state] ?? item.state;
  if (
    [
      item.staged,
      item.unstaged,
      item.untracked,
      item.ignored,
      item.conflicted,
    ].some((count) => count === undefined)
  )
    return "Состояние не проверено";
  const changed = !!(
    item.staged ||
    item.unstaged ||
    item.untracked ||
    item.conflicted
  );
  return `${changed ? "Есть изменения" : item.ignored ? "Есть игнорируемые файлы" : "Чистая"} · ${item.activeUsers ? `используется (${item.activeUsers})` : "не открыта"}`;
};

/** All operations use the captured application's command lane and normal grants. */
export function OpenTuiWorktrees({
  actions,
  width,
  height,
  palette: p,
  active = true,
  onClose,
}: {
  actions: WorktreeManagerActions;
  width: number;
  height: number;
  palette: Palette;
  active?: boolean;
  onClose(): void;
}) {
  const renderer = useRenderer();
  const layout = dialogLayout(width, height, 44, 116);
  const inner = Math.max(1, layout.popupWidth - (layout.tiny ? 2 : 4));
  const wide = inner >= 92 && layout.popupHeight >= 28;
  const tiny = inner < 28 || layout.popupHeight < 12;
  const bodyHeight = Math.max(1, layout.popupHeight - (layout.roomy ? 10 : 8));
  const [items, setItems] = useState<WorktreeDescriptor[]>();
  const [selection, setSelection] = useState<string>();
  const [page, setPage] = useState<Page>("list");
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<
    "list" | "actions" | "search" | "label" | "ref"
  >("list");
  const [actionIndex, setActionIndex] = useState(0);
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [chosen, setChosen] = useState(new Set<string>());
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [omitted, setOmitted] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [fullPath, setFullPath] = useState(false);
  const mounted = useRef(true);
  const previousPage = useRef<Page>("list");
  const selectedKey = useRef(selection);
  selectedKey.current = selection;
  const pending = useRef(false);
  const listScroll = useRef<ScrollBoxRenderable>(null);
  const detailScroll = useRef<ScrollBoxRenderable>(null);
  const filtered = (items ?? []).filter((item) =>
    `${item.label} ${item.path}`.toLowerCase().includes(query.toLowerCase()),
  );
  const selected = (page === "list" ? filtered : items)?.find(
    (item) => worktreeKey(item) === selection,
  );
  const origin = items?.find((item) => item.kind === "origin");
  const back = () => {
    setPage("list");
    setFocus("list");
    setActionIndex(0);
    setFullPath(false);
  };
  const close = () => {
    if (pending.current) {
      setNotice("Действие ещё выполняется. Для остановки используйте Ctrl+C.");
      return;
    }
    onClose();
  };
  const readList = async () => {
    const result = await actions.run("list");
    if (result.isError || result.requiresApproval)
      throw new Error(
        `${result.errorCode ?? "WORKTREE_UNAVAILABLE"}: ${result.output}`,
      );
    const data = result.details?.worktrees;
    if (
      !Array.isArray(data) ||
      data.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          !("path" in item) ||
          typeof item.path !== "string" ||
          !("label" in item) ||
          typeof item.label !== "string",
      )
    )
      throw new Error("Менеджер получил некорректный список копий.");
    if (!mounted.current) return;
    const next = data as unknown as WorktreeDescriptor[];
    next.sort(
      (a, b) =>
        (a.kind === "origin" ? -1 : worktreeOwned(a) ? 0 : 1) -
        (b.kind === "origin" ? -1 : worktreeOwned(b) ? 0 : 1),
    );
    setItems(next);
    setStale(false);
    const current = selectedKey.current;
    if (current && !next.some((item) => worktreeKey(item) === current)) {
      setSelection(undefined);
      setPage("list");
      setFocus("list");
      setNotice("Выбранная копия исчезла. Выберите папку заново.");
    } else
      setSelection(
        current ??
          (() => {
            const here =
              next.find((item) => sameWorktreePath(item.path, actions.root)) ??
              next[0];
            return here ? worktreeKey(here) : undefined;
          })(),
      );
  };
  const perform = async (run: () => Promise<void>) => {
    if (pending.current || !active) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      await run();
    } catch (error) {
      if (mounted.current) {
        setNotice(error instanceof Error ? error.message : String(error));
        setStale(true);
        previousPage.current =
          page === "diagnostic" ? previousPage.current : page;
        setPage("diagnostic");
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const execute = async (
    operation: Parameters<WorktreeManagerActions["run"]>[0],
    input: JsonObject = {},
  ): Promise<ToolExecutionResult> => {
    const result = await actions.run(operation, input);
    if (result.isError || result.requiresApproval)
      throw new Error(
        `${result.errorCode ?? "Действие не выполнено"}: ${result.output}`,
      );
    return result;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Actions are captured once for the manager owner; refresh closures are not subscriptions.
  useEffect(() => {
    mounted.current = true;
    void perform(readList);
    return () => {
      mounted.current = false;
    };
  }, [actions]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Resize and filtering must reveal the selected row after native layout.
  useLayoutEffect(() => {
    if (selection)
      listScroll.current?.scrollChildIntoView(`worktree-row-${selection}`);
  }, [selection, query, width, height]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Native scrolling must follow the selected file after a resize.
  useLayoutEffect(() => {
    if (page === "diff")
      detailScroll.current?.scrollChildIntoView(`worktree-diff-${fileIndex}`);
  }, [page, fileIndex, width, height]);
  const pick = (key: string) => {
    setSelection(key);
    setActionIndex(0);
    setFullPath(false);
  };
  const chooseQuery = (value: string) => {
    setQuery(value);
    const first = items?.find((item) =>
      `${item.label} ${item.path}`.toLowerCase().includes(value.toLowerCase()),
    );
    setSelection(first ? worktreeKey(first) : undefined);
  };
  const showDiff = () => {
    if (!selected?.id) return;
    const id = selected.id;
    void perform(async () => {
      const result = await execute("diff", { id });
      if (!mounted.current) return;
      const preview = result.details?.worktreePreview as
        | { files?: { path: string; hash: string }[]; omitted?: number }
        | undefined;
      const next = result.diffs ?? [];
      setDiffs(next);
      setChosen(new Set(next.map((diff) => diff.path)));
      setExpanded(new Set());
      setFileIndex(0);
      setHashes(
        Object.fromEntries(
          preview?.files?.map((file) => [file.path, file.hash]) ?? [],
        ),
      );
      setOmitted(preview?.omitted ?? 0);
      setPage("diff");
      setFocus("list");
      setActionIndex(0);
    });
  };
  const mutationBlock =
    actions.mode === "plan"
      ? "Для изменений переключитесь в Build."
      : undefined;
  const removeBlock = selected
    ? worktreeRemoveBlock(selected)
    : "Выберите копию.";
  const copyPath = () => {
    if (!selected) return;
    void perform(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const clipboard = createTerminalClipboard(renderer);
        try {
          const result = await clipboard.writeText(selected.path, {
            signal: controller.signal,
            destination: "best-available",
          });
          if (mounted.current)
            setNotice(
              result.host.status === "written"
                ? "Путь скопирован."
                : result.terminal.status === "attempted"
                  ? "Запрос копирования отправлен терминалу."
                  : "Буфер обмена недоступен. Путь можно выделить в сведениях.",
            );
        } finally {
          await clipboard.dispose();
        }
      } finally {
        clearTimeout(timer);
      }
    });
  };
  const operations = selected
    ? [
        ...(selected.kind === "origin"
          ? [
              {
                label: "Открыть основной проект",
                run: () =>
                  void perform(async () => {
                    await execute("origin");
                    if (mounted.current) onClose();
                  }),
              },
            ]
          : worktreeOwned(selected) &&
              selected.id &&
              selected.state === "ready" &&
              !selected.readOnly
            ? [
                {
                  label: "Открыть копию",
                  run: () =>
                    void perform(async () => {
                      await execute("open", { id: selected.id as string });
                      if (mounted.current) onClose();
                    }),
                },
                { label: "Посмотреть изменения", run: showDiff },
                {
                  label: "Удалить копию…",
                  run: () => {
                    if (mutationBlock || removeBlock)
                      setNotice(mutationBlock ?? removeBlock ?? "");
                    else {
                      setPage("remove");
                      setActionIndex(0);
                    }
                  },
                },
              ]
            : []),
        {
          label: "Вкладки этой папки",
          run: () => {
            setPage("tabs");
            setActionIndex(0);
          },
        },
        {
          label: "Полный путь и сведения",
          run: () => {
            setPage("info");
            setFullPath(true);
          },
        },
        worktreeOwned(selected)
          ? {
              label: "Вернуться в основной проект",
              run: () =>
                void perform(async () => {
                  await execute("origin");
                  if (mounted.current) onClose();
                }),
            }
          : { label: "Скопировать путь", run: copyPath },
      ]
    : [];
  const toggleFile = () => {
    const path = diffs[fileIndex]?.path;
    if (!path) return;
    setChosen((before) => {
      const next = new Set(before);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const confirm = () => {
    if (tiny || busy || !active) return;
    if (page === "create" && !mutationBlock && name.trim()) {
      setPage("create-review");
      setFocus("actions");
      setActionIndex(0);
      return;
    }
    if (page === "create-review" && actionIndex === 1 && !mutationBlock) {
      void perform(async () => {
        const result = await execute("create", {
          label: name.trim(),
          ...(base.trim() ? { ref: base.trim() } : {}),
        });
        const item = result.details?.worktree as unknown as
          | WorktreeDescriptor
          | undefined;
        await readList();
        if (!mounted.current) return;
        if (item?.id) setSelection(item.id);
        setQuery("");
        setPage("detail");
        setFocus("actions");
        setActionIndex(0);
        setNotice(
          "Копия создана. Откройте её в отдельной вкладке; основной проект сохранён.",
        );
      });
      return;
    }
    if (
      page === "remove" &&
      actionIndex === 1 &&
      selected?.id &&
      !mutationBlock &&
      !removeBlock
    ) {
      const id = selected.id;
      void perform(async () => {
        const result = await execute("remove", { id });
        await readList();
        if (mounted.current) {
          back();
          setNotice(result.output);
        }
      });
      return;
    }
    if (
      page === "apply" &&
      actionIndex === 1 &&
      selected?.id &&
      !mutationBlock &&
      chosen.size
    ) {
      const id = selected.id;
      void perform(async () => {
        const result = await execute("apply", {
          id,
          paths: [...chosen],
          expectedFiles: Object.fromEntries(
            [...chosen].map((path) => [path, hashes[path] ?? ""]),
          ),
        });
        await readList();
        if (mounted.current) {
          setPage("detail");
          setFocus("actions");
          setNotice(`Перенос завершён. Копия сохранена.\n${result.output}`);
        }
      });
      return;
    }
    if (["create-review", "remove", "apply"].includes(page)) {
      back();
      return;
    }
    if (page === "diff" && focus === "actions") {
      if (actionIndex === 0) {
        if (
          chosen.size &&
          !mutationBlock &&
          [...chosen].every((path) => hashes[path])
        ) {
          setPage("apply");
          setActionIndex(0);
        }
      } else showDiff();
      return;
    }
    if (page === "info") {
      copyPath();
      return;
    }
    if (page === "tabs") {
      const tab = actions
        .tabs()
        .filter(
          (tab) =>
            selected !== undefined && sameWorktreePath(tab.path, selected.path),
        )[actionIndex];
      if (tab) {
        setNotice(
          actions.closeTab(tab.key)
            ? "Вкладка закрыта. Папка и файлы сохранены."
            : "Вкладка выполняет задачу. Сначала остановите её или дождитесь завершения.",
        );
      }
      return;
    }
    if (page === "list" && focus === "list") {
      if (
        selected &&
        filtered.some((item) => worktreeKey(item) === selection)
      ) {
        setPage("detail");
        setFocus("actions");
      }
      return;
    }
    if (page === "detail" || (page === "list" && focus === "actions"))
      operations[actionIndex]?.run();
  };
  useUiKeyboard((key) => {
    if (!active || capturedInputOwner(key) !== "dialog") return;
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      if (busy) {
        setNotice("Действие выполняется. Ctrl+C остановит текущий запрос.");
        return;
      }
      if (focus === "search") {
        setFocus("list");
        return;
      }
      if (page === "diagnostic") {
        setPage(previousPage.current);
        return;
      }
      if (page === "list") close();
      else if (page === "apply") {
        setPage("diff");
        setActionIndex(0);
      } else back();
      return;
    }
    if (key.ctrl || key.meta || key.option) return;
    if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      if (page === "create")
        setFocus((current) => {
          const fields = ["label", "ref", "actions"] as const;
          const index = fields.findIndex((field) => field === current);
          return (
            fields[
              (Math.max(0, index) + (key.shift ? 2 : 1)) % fields.length
            ] ?? "label"
          );
        });
      else if (page === "list" || page === "diff")
        setFocus(focus === "list" ? "actions" : "list");
      return;
    }
    if (busy || focus === "search" || focus === "label" || focus === "ref")
      return;
    if (key.name === "n" && page === "list") {
      key.preventDefault();
      key.stopPropagation();
      if (mutationBlock) setNotice(mutationBlock);
      else {
        setPage("create");
        setFocus("label");
      }
      return;
    }
    if (key.name === "/" && page === "list") {
      key.preventDefault();
      key.stopPropagation();
      setFocus("search");
      return;
    }
    if (key.name === "r") {
      key.preventDefault();
      key.stopPropagation();
      if (page === "diff") showDiff();
      else void perform(readList);
      return;
    }
    if (["pageup", "pagedown"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      detailScroll.current?.scrollBy(
        key.name === "pageup" ? -bodyHeight : bodyHeight,
      );
      return;
    }
    if (["up", "down", "home", "end"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      const delta = key.name === "up" ? -1 : 1;
      if (page === "list" && focus === "list") {
        const current = filtered.findIndex(
          (item) => worktreeKey(item) === selection,
        );
        const next =
          key.name === "home"
            ? 0
            : key.name === "end"
              ? filtered.length - 1
              : Math.max(0, Math.min(filtered.length - 1, current + delta));
        if (filtered[next]) pick(worktreeKey(filtered[next]));
      } else if (page === "diff" && focus === "list")
        setFileIndex((index) =>
          Math.max(0, Math.min(diffs.length - 1, index + delta)),
        );
      else {
        const max = ["apply", "remove", "create-review", "diff"].includes(page)
          ? 1
          : page === "create"
            ? 0
            : page === "tabs"
              ? actions
                  .tabs()
                  .filter(
                    (tab) =>
                      !!selected && sameWorktreePath(tab.path, selected.path),
                  ).length - 1
              : operations.length - 1;
        setActionIndex((index) => Math.max(0, Math.min(max, index + delta)));
      }
      return;
    }
    if (["enter", "return", "space", " "].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      if (key.repeated) return;
      if (page === "diff" && focus === "list") {
        if (key.name === "space" || key.name === " ") toggleFile();
        else {
          const path = diffs[fileIndex]?.path;
          if (path)
            setExpanded((before) => {
              const next = new Set(before);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
        }
      } else confirm();
    }
  });
  const button = (
    label: string,
    run: () => void,
    index: number,
    id: string,
    disabled = false,
  ) => (
    <DialogAction
      key={id}
      id={id}
      label={terminalLine(
        `${focus === "actions" && index === actionIndex ? "› " : ""}${label}`,
        inner - 2,
      )}
      palette={p}
      active={index === actionIndex && focus === "actions"}
      disabled={!active || busy || disabled}
      onSelect={run}
    />
  );
  const detail = () =>
    selected ? (
      <box
        flexDirection="column"
        width={wide ? inner - 40 : inner}
        minWidth={1}
      >
        <scrollbox
          ref={detailScroll}
          height={Math.max(2, bodyHeight - Math.min(operations.length, 6))}
        >
          <text fg={p.accent} height={1}>
            {role(selected)}
          </text>
          <text fg={p.text} height={1}>
            <strong>
              {terminalLine(selected.label, wide ? inner - 42 : inner)}
            </strong>
          </text>
          <text fg={p.muted} height={2}>
            {terminalLine(summary(selected), wide ? inner - 42 : inner)}
          </text>
          <text fg={p.muted} height={1}>
            {terminalLine(selected.path, wide ? inner - 42 : inner)}
          </text>
          {selected.kind === "origin" ? (
            <text fg={p.text}>
              Обычная работа с файлами подчиняется разрешениям проекта. Менеджер
              не удаляет эту папку.
            </text>
          ) : (
            <text fg={p.muted}>
              {terminalSafeText(
                selected.reason ??
                  (worktreeOwned(selected)
                    ? "Основной проект изменится только после явного переноса результата."
                    : "Менеджер не владеет этой копией. Это не запрет на обычную работу с файлами."),
              )}
            </text>
          )}
          {selected.base && (
            <text
              fg={p.muted}
            >{`База: ${selected.base.slice(0, 12)}${selected.head && selected.head !== selected.base ? " · есть новые коммиты" : ""}`}</text>
          )}
          {removeBlock && worktreeOwned(selected) && (
            <text fg={p.yellow}>{terminalSafeText(removeBlock)}</text>
          )}
        </scrollbox>
        <box flexDirection="column" flexShrink={0}>
          {operations.map((operation, index) =>
            button(
              operation.label,
              operation.run,
              index,
              `worktree-action-${index}`,
            ),
          )}
        </box>
      </box>
    ) : (
      <text fg={p.muted}>
        Выберите копию. Если она исчезла, обновите список.
      </text>
    );
  const tabs = actions
    .tabs()
    .filter(
      (tab) =>
        selected !== undefined && sameWorktreePath(tab.path, selected.path),
    );
  return (
    <OpenTuiDialog
      id="worktrees"
      width={width}
      height={height}
      maxWidth={116}
      maxHeight={44}
      palette={p}
      onClose={close}
    >
      <text height={1} flexShrink={0} fg={p.accent}>
        <strong>Рабочие копии</strong>
      </text>
      <text height={1} flexShrink={0} fg={p.muted}>
        {terminalLine(
          `${busy ? "Выполняется…" : stale ? "Данные устарели · R обновить" : actions.mode === "plan" ? "Plan · просмотр" : "Build"} · ${actions.root}`,
          inner,
        )}
      </text>
      {tiny ? (
        <box flexGrow={1} flexDirection="column">
          <text height={1} fg={p.text}>
            Мало места.
          </text>
          <text height={1} fg={p.muted}>
            Увеличьте окно.
          </text>
        </box>
      ) : (
        <box flexDirection="column" height={bodyHeight} flexShrink={0}>
          {page === "list" ? (
            <box flexDirection="row" height={bodyHeight}>
              <box flexDirection="column" width={wide ? 38 : inner}>
                <DialogAction
                  id="worktree-new"
                  label="＋ Новая копия · N"
                  palette={p}
                  disabled={busy || !active || !!mutationBlock}
                  onSelect={() => {
                    setPage("create");
                    setFocus("label");
                  }}
                />
                {focus === "search" ? (
                  <input
                    id="worktree-search"
                    focused={active}
                    value={query}
                    onInput={chooseQuery}
                    onSubmit={() => setFocus("list")}
                    placeholder="Название или путь…"
                    backgroundColor={p.raised}
                    textColor={p.text}
                  />
                ) : (
                  <DialogAction
                    id="worktree-search-open"
                    label={terminalLine(
                      query ? `Поиск: ${query}` : "/ Поиск по названию и пути",
                      wide ? 36 : inner - 2,
                    )}
                    palette={p}
                    disabled={!active || busy}
                    onSelect={() => setFocus("search")}
                  />
                )}
                <scrollbox ref={listScroll} flexGrow={1} minHeight={1}>
                  {filtered.map((item, index) => (
                    <box
                      key={worktreeKey(item)}
                      id={`worktree-row-${worktreeKey(item)}`}
                      flexDirection="column"
                      flexShrink={0}
                    >
                      {(index === 0 ||
                        role(item) !== role(filtered[index - 1] ?? item)) && (
                        <text fg={p.muted} height={1} marginTop={index ? 1 : 0}>
                          {role(item).toUpperCase()}
                        </text>
                      )}
                      <DialogAction
                        id={`worktree-select-${item.id ?? item.kind}`}
                        label={terminalLine(item.label, wide ? 34 : inner - 2)}
                        subtitle={terminalLine(
                          summary(item),
                          wide ? 34 : inner - 2,
                        )}
                        palette={p}
                        active={selection === worktreeKey(item)}
                        disabled={!active || busy}
                        onSelect={() => {
                          pick(worktreeKey(item));
                          setPage("detail");
                          setFocus("actions");
                        }}
                      />
                    </box>
                  ))}
                  {!items && (
                    <text fg={p.muted}>
                      {busy
                        ? "Проверка репозитория…"
                        : "Список недоступен · R повторить"}
                    </text>
                  )}
                  {items && !filtered.length && (
                    <text fg={p.muted}>
                      {query
                        ? "Совпадений нет. Измените поиск."
                        : "Рабочих копий нет."}
                    </text>
                  )}
                </scrollbox>
              </box>
              {wide && (
                <box
                  width={1}
                  marginLeft={0}
                  marginRight={1}
                  backgroundColor={p.border}
                />
              )}
              {wide && detail()}
            </box>
          ) : page === "diagnostic" ? (
            <scrollbox ref={detailScroll} flexGrow={1}>
              <text fg={p.yellow}>Действие не выполнено</text>
              <text fg={p.text}>{terminalSafeText(notice)}</text>
              <text fg={p.muted}>
                R — обновить сведения. Esc — вернуться. Ошибка не расширяет
                права проекта.
              </text>
            </scrollbox>
          ) : page === "detail" ? (
            detail()
          ) : page === "create" ? (
            <box flexDirection="column" flexGrow={1}>
              <text fg={p.text}>Название задачи</text>
              <input
                id="worktree-label"
                focused={active && focus === "label"}
                value={name}
                onInput={setName}
                onSubmit={() => setFocus("ref")}
                maxLength={120}
                placeholder="Например: Новая аналитика"
                textColor={p.text}
                backgroundColor={p.raised}
              />
              <text fg={p.text}>Локальная ссылка (пусто — текущий HEAD)</text>
              <input
                id="worktree-ref"
                focused={active && focus === "ref"}
                value={base}
                onInput={setBase}
                onSubmit={() => {
                  setFocus("actions");
                }}
                maxLength={256}
                placeholder="HEAD"
                textColor={p.text}
                backgroundColor={p.raised}
              />
              <text fg={p.muted}>
                {terminalSafeText(
                  `Из проекта: ${origin?.path ?? actions.root}\nКопируются файлы сохранённого коммита. Текущие правки и зависимости остаются в исходном проекте. Создание не скачивает обновление с GitHub.`,
                )}
              </text>
              {button(
                "Продолжить к проверке",
                confirm,
                0,
                "worktree-create-next",
                !name.trim() || !!mutationBlock,
              )}
            </box>
          ) : page === "create-review" ? (
            <box flexDirection="column" flexGrow={1}>
              <text fg={p.accent}>Создать отдельную копию?</text>
              <text fg={p.text}>
                {terminalSafeText(
                  `${name.trim()}\nИсходный проект: ${origin?.path ?? actions.root}\nБаза: ${base.trim() || "HEAD"}\nПапку в ChiselCode Home выберет сервис. Detached HEAD, отдельная ветка не создаётся. Файлы исходного проекта не изменятся.`,
                )}
              </text>
              {button("Отмена", back, 0, "worktree-create-cancel")}
              {button(
                "Создать копию",
                () => {
                  setActionIndex(1);
                  void perform(async () => {
                    const result = await execute("create", {
                      label: name.trim(),
                      ...(base.trim() ? { ref: base.trim() } : {}),
                    });
                    await readList();
                    if (mounted.current) {
                      const item = result.details
                        ?.worktree as unknown as WorktreeDescriptor;
                      if (item?.id) setSelection(item.id);
                      setQuery("");
                      setPage("detail");
                      setFocus("actions");
                      setNotice(
                        "Копия создана. Можно открыть её в отдельной вкладке.",
                      );
                    }
                  });
                },
                1,
                "worktree-create-confirm",
                !!mutationBlock,
              )}
            </box>
          ) : page === "diff" ? (
            <box flexDirection="column" height={bodyHeight}>
              <text fg={p.accent} height={1}>
                {terminalLine(
                  `Результат: ${selected?.label ?? ""} → ${selected?.origin ?? origin?.path ?? "основной проект"}`,
                  inner,
                )}
              </text>
              <scrollbox ref={detailScroll} flexGrow={1} minHeight={1}>
                {diffs.map((diff, index) => (
                  <box
                    key={diff.path}
                    id={`worktree-diff-${index}`}
                    flexDirection="column"
                    flexShrink={0}
                  >
                    <DialogAction
                      label={terminalLine(
                        `${chosen.has(diff.path) ? "☑" : "☐"} ${diff.path}`,
                        inner - 2,
                      )}
                      active={fileIndex === index}
                      palette={p}
                      onSelect={() => {
                        setFileIndex(index);
                        setChosen((before) => {
                          const next = new Set(before);
                          if (next.has(diff.path)) next.delete(diff.path);
                          else next.add(diff.path);
                          return next;
                        });
                      }}
                      disabled={!active || busy}
                    />
                    <FileDiffCard
                      id={`worktree-file-card-${index}`}
                      diff={diff}
                      width={inner}
                      palette={p}
                      expanded={expanded.has(diff.path)}
                      onToggle={() =>
                        setExpanded((before) => {
                          const next = new Set(before);
                          if (next.has(diff.path)) next.delete(diff.path);
                          else next.add(diff.path);
                          return next;
                        })
                      }
                    />
                  </box>
                ))}
                {!diffs.length && (
                  <text fg={p.muted}>
                    Поддерживаемых изменений для переноса нет.
                  </text>
                )}
                {omitted > 0 && (
                  <text
                    fg={p.yellow}
                  >{`Не включено файлов: ${omitted}. Политика/формат не допускают перенос; скрытые файлы не читаются ради превью.`}</text>
                )}
              </scrollbox>
              {button(
                `Перенести выбранные (${chosen.size})…`,
                () => {
                  setPage("apply");
                  setActionIndex(0);
                  setFocus("actions");
                },
                0,
                "worktree-apply-next",
                !!mutationBlock ||
                  !chosen.size ||
                  [...chosen].some((path) => !hashes[path]),
              )}
              {button(
                "Обновить сравнение",
                showDiff,
                1,
                "worktree-diff-refresh",
              )}
            </box>
          ) : page === "apply" || page === "remove" ? (
            <box flexDirection="column" flexGrow={1}>
              <text fg={p.yellow}>
                {page === "apply"
                  ? "Перенести выбранный результат?"
                  : "Удалить папку отдельной копии?"}
              </text>
              <scrollbox flexGrow={1}>
                <text fg={p.text}>
                  {terminalSafeText(
                    page === "apply"
                      ? `Источник: ${selected?.path}\nНазначение: ${selected?.origin}\nФайлов выбрано: ${chosen.size}\n${[...chosen].join("\n")}\nПеред записью результат и целевые файлы проверяются снова. Копия сохраняется.`
                      : `${selected?.label}\n${selected?.path}\nОсновной проект и история бесед сохраняются. Состояние файлов, процессы и владение проверяются повторно. Новый commit-result сохраняется внутренней ссылкой.`,
                  )}
                </text>
              </scrollbox>
              {button(
                "Отмена",
                () => (page === "apply" ? setPage("diff") : back()),
                0,
                "worktree-mutation-cancel",
              )}
              {button(
                page === "apply" ? "Перенести файлы" : "Удалить копию",
                () => {
                  setActionIndex(1);
                  if (page === "apply" && selected?.id)
                    void perform(async () => {
                      await execute("apply", {
                        id: selected.id as string,
                        paths: [...chosen],
                        expectedFiles: Object.fromEntries(
                          [...chosen].map((path) => [path, hashes[path] ?? ""]),
                        ),
                      });
                      await readList();
                      if (mounted.current) {
                        setPage("detail");
                        setFocus("actions");
                        setNotice(
                          "Результат перенесён в основной проект. Копия сохранена.",
                        );
                      }
                    });
                  else if (selected?.id)
                    void perform(async () => {
                      const result = await execute("remove", {
                        id: selected.id as string,
                      });
                      await readList();
                      if (mounted.current) {
                        back();
                        setNotice(result.output);
                      }
                    });
                },
                1,
                "worktree-mutation-confirm",
                !!mutationBlock || (page === "remove" && !!removeBlock),
              )}
            </box>
          ) : page === "tabs" ? (
            <scrollbox ref={detailScroll} flexGrow={1}>
              <text fg={p.muted}>
                Закрытие вкладки сохраняет папку. Работающий запрос нужно
                сначала остановить. Фоновые процессы владельца завершаются при
                закрытии.
              </text>
              {tabs.map((tab, index) =>
                button(
                  `${tab.busy ? "Выполняется" : tab.stopsProcesses ? "Остановить фон и закрыть" : "Закрыть"}: ${tab.label}`,
                  () =>
                    setNotice(
                      actions.closeTab(tab.key)
                        ? "Вкладка закрыта, файлы сохранены."
                        : "Сначала завершите или остановите выполняющуюся задачу.",
                    ),
                  index,
                  `worktree-tab-${tab.key}`,
                  tab.busy,
                ),
              )}
              {!tabs.length && (
                <text fg={p.muted}>
                  Открытых вкладок этой папки нет. Другие приложения и процессы
                  проверяет сервис.
                </text>
              )}
            </scrollbox>
          ) : (
            <scrollbox ref={detailScroll} flexGrow={1}>
              <text fg={p.text}>
                {terminalSafeText(
                  `${role(selected ?? { label: "", path: "", state: "external", readOnly: true })}\n${selected?.label}\n${fullPath ? selected?.path : ""}\n${selected?.id ? `ID: ${selected.id}` : "Менеджер не владеет удалением папки."}\n${selected?.base ? `Base: ${selected.base}` : ""}\n${selected?.head ? `HEAD: ${selected.head}` : ""}\n${selected?.retainedRef ? `Сохранённый результат: ${selected.retainedRef}` : ""}\n${selected?.reason ?? ""}`,
                )}
              </text>
            </scrollbox>
          )}
        </box>
      )}
      <text fg={notice ? p.yellow : p.muted} height={2} flexShrink={0}>
        {terminalLine(
          notice ||
            (mutationBlock ??
              "Рабочие копии изолируют файлы. Закрытие вкладки не удаляет папку."),
          inner,
        )}
      </text>
      <text fg={p.muted} height={1} flexShrink={0}>
        {terminalLine(
          tiny
            ? "Esc назад"
            : page === "diff"
              ? "↑↓ файл · Space выбор · Enter дифф · Tab кнопки · Esc назад"
              : page === "list"
                ? "↑↓ выбор · Enter карточка · N новая · / поиск · R обновить · Esc назад"
                : "↑↓ действие · Enter выбрать · Tab фокус · PgUp/PgDn · Esc назад",
          inner,
        )}
      </text>
    </OpenTuiDialog>
  );
}
