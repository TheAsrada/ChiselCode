/** @jsxImportSource @opentui/react */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  categoryIds,
  type MigrationActions,
  type MigrationCategory,
  type MigrationCounts,
  type MigrationInventory,
  type MigrationResult,
  type MigrationSource,
  migrationCategories,
  migrationSources,
  sourceIds,
} from "../migration/contracts.js";
import type { Palette } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import {
  MIGRATION_MOTION_MS,
  MigrationMotion,
} from "./opentui-migration-motion.js";
import { useMotion } from "./opentui-motion.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { isCtrlC } from "./terminal-keys.js";

export const migrationTotal = (counts: MigrationCounts) =>
  categoryIds.reduce((sum, category) => sum + counts[category], 0);

type Phase =
  | { name: "form" }
  | {
      name: "running";
      started: number;
      motionDone: boolean;
      result?: MigrationResult | "error";
    }
  | { name: "result"; result: MigrationResult | "error" };

export function OpenTuiMigration({
  actions,
  initialInventory,
  width,
  height,
  palette,
  onboarding,
  active,
  onClose,
}: {
  actions: MigrationActions;
  initialInventory?: MigrationInventory;
  width: number;
  height: number;
  palette: Palette;
  onboarding: boolean;
  active: boolean;
  onClose(): void;
}) {
  const [scannedInventory, setInventory] = useState<MigrationInventory>();
  const inventory = initialInventory ?? scannedInventory;
  const [scanFailed, setScanFailed] = useState(false);
  const [source, setSource] = useState<MigrationSource | "all">("all");
  const [categories, setCategories] = useState<ReadonlySet<MigrationCategory>>(
    () => new Set(categoryIds),
  );
  const [focus, setFocus] = useState("apply");
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const running = useRef(false);
  const alive = useRef(true);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const { enabled } = useMotion();
  const { popupHeight, innerWidth, roomy, tiny } = dialogLayout(
    width,
    height,
    24,
    84,
  );
  const wide = innerWidth >= 62 && popupHeight >= 16;
  const compact = popupHeight < 13;
  const found = sourceIds.filter(
    (id) => inventory && migrationTotal(inventory.counts[id]),
  );
  const sources = source === "all" ? found : [source];
  const count = (category: MigrationCategory) =>
    sources.reduce(
      (total, id) => total + (inventory?.counts[id][category] ?? 0),
      0,
    );
  const total = categoryIds.reduce(
    (sum, id) => sum + (categories.has(id) ? count(id) : 0),
    0,
  );

  useEffect(() => {
    if (initialInventory) return;
    let current = true;
    void actions.inspect().then(
      (result) => {
        if (current) setInventory(result);
      },
      () => {
        if (current) setScanFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [actions, initialInventory]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    scroll.current?.scrollChildIntoView(`migration-${focus}`);
  }, [focus]);

  const finish = useCallback(
    (result?: MigrationResult | "error", motionDone = false) => {
      if (!alive.current) return;
      setPhase((current) => {
        if (current.name !== "running") return current;
        const next = {
          ...current,
          result: result ?? current.result,
          motionDone: current.motionDone || motionDone,
        };
        return next.result && next.motionDone
          ? { name: "result", result: next.result }
          : next;
      });
    },
    [],
  );

  useEffect(() => {
    if (phase.name !== "running" || phase.motionDone) return;
    const timeout = setTimeout(
      () => finish(undefined, true),
      Math.max(0, phase.started + MIGRATION_MOTION_MS - performance.now()),
    );
    return () => clearTimeout(timeout);
  }, [phase, finish]);

  const close = () => {
    if (phase.name !== "running") onClose();
  };
  const start = () => {
    if (!active || !total || running.current) return;
    running.current = true;
    setPhase({
      name: "running",
      started: performance.now(),
      motionDone: !enabled,
    });
    void actions.run({ sources, categories: [...categories] }).then(
      (result) => finish(result),
      () => finish("error"),
    );
  };
  const changeCategory = (category: MigrationCategory) => {
    setCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
    setFocus(category);
  };
  const unavailable = scanFailed || !!inventory?.unavailable.length;
  const rows = [
    ...(["all", ...sourceIds] as const).map((id) => ({
      id,
      label: `${source === id ? "◉" : "○"}  ${id === "all" ? "Все найденные" : migrationSources[id]}`,
      value:
        id === "all"
          ? String(found.length)
          : found.includes(id)
            ? "найден"
            : "—",
      disabled: id === "all" ? !found.length : !found.includes(id),
      run: () => {
        setSource(id);
        setFocus(id);
      },
    })),
    ...categoryIds.map((id) => ({
      id,
      label: `${categories.has(id) && count(id) ? "☑" : "☐"}  ${migrationCategories[id]}`,
      value: String(count(id)),
      disabled: count(id) === 0,
      run: () => changeCategory(id),
    })),
  ];
  const focusable = [
    ...rows.filter((row) => !row.disabled).map((row) => row.id),
    ...(total ? ["apply"] : []),
    "skip",
  ];
  const focused = focusable.includes(focus) ? focus : "skip";
  useUiKeyboard((key) => {
    if (!active || capturedInputOwner(key) !== "migration") return;
    key.preventDefault();
    key.stopPropagation();
    if (phase.name === "running") return;
    if (key.name === "escape" || isCtrlC(key)) return close();
    if (phase.name === "result") {
      if (key.name === "return" && !key.repeated) close();
      return;
    }
    if (["tab", "up", "down", "left", "right"].includes(key.name)) {
      const direction =
        key.shift || key.name === "up" || key.name === "left" ? -1 : 1;
      const index = focusable.indexOf(focused);
      setFocus(
        focusable[(index + direction + focusable.length) % focusable.length] ??
          "skip",
      );
      return;
    }
    if (key.repeated || (key.name !== "return" && key.name !== "space")) return;
    if (focused === "skip") close();
    else if (focused === "apply") start();
    else rows.find((row) => row.id === focused)?.run();
  });
  const renderRow = (row: (typeof rows)[number]) => (
    <DialogAction
      key={row.id}
      id={`migration-${row.id}`}
      label={row.label}
      trailing={{ label: row.value }}
      active={focused === row.id}
      disabled={!active || row.disabled}
      palette={palette}
      onSelect={row.run}
    />
  );
  const result = phase.name === "result" ? phase.result : undefined;
  const failed =
    result && result !== "error" ? migrationTotal(result.failed) : 0;

  return (
    <OpenTuiDialog
      id="migration"
      width={width}
      height={height}
      maxWidth={84}
      maxHeight={24}
      palette={palette}
      onClose={close}
      shadow={!onboarding}
    >
      {phase.name === "running" ? (
        phase.motionDone ? (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={palette.text}>Перенос данных…</text>
          </box>
        ) : (
          <MigrationMotion
            started={phase.started}
            width={innerWidth}
            height={Math.max(1, popupHeight - (tiny ? 0 : 2) - (roomy ? 2 : 0))}
            palette={palette}
          />
        )
      ) : (
        <>
          <box flexDirection="column" flexShrink={0}>
            <text fg={palette.accent} height={1}>
              <b>↓ Центр переноса</b>
            </text>
            {!compact && (
              <text fg={palette.muted} height={1}>
                {result
                  ? "Итоги импорта"
                  : "Перенесите данные из другого помощника"}
              </text>
            )}
          </box>
          {result ? (
            <>
              <scrollbox
                flexGrow={1}
                marginTop={compact ? 0 : 1}
                verticalScrollbarOptions={{ visible: false }}
              >
                {result === "error" ? (
                  <text fg={palette.red}>
                    Импорт прервался. Повторите через /import.
                  </text>
                ) : (
                  <>
                    <text fg={failed ? palette.yellow : palette.green}>
                      <b>
                        {failed
                          ? "Перенос завершён с ошибками"
                          : "Перенос завершён"}
                      </b>
                    </text>
                    {categoryIds
                      .filter(
                        (id) =>
                          result.imported[id] ||
                          result.existing[id] ||
                          result.skipped[id] ||
                          result.failed[id],
                      )
                      .map((id) => (
                        <text key={id} fg={palette.text}>
                          {migrationCategories[id]} · {result.imported[id]}{" "}
                          добавлено
                          {result.existing[id]
                            ? ` · ${result.existing[id]} уже есть`
                            : ""}
                          {result.skipped[id]
                            ? ` · ${result.skipped[id]} пропущено`
                            : ""}
                          {result.failed[id]
                            ? ` · ${result.failed[id]} ошибок`
                            : ""}
                        </text>
                      ))}
                    {!migrationTotal(result.imported) &&
                      !migrationTotal(result.existing) &&
                      !migrationTotal(result.skipped) &&
                      !failed && (
                        <text fg={palette.muted}>
                          Выбранные источники пусты.
                        </text>
                      )}
                    {result.imported.sessions > 0 && (
                      <text fg={palette.muted}>
                        История доступна через /resume.
                      </text>
                    )}
                    {result.imported.mcp > 0 && (
                      <text fg={palette.muted}>
                        MCP добавлены выключенными. Проверьте их в /mcp.
                      </text>
                    )}
                  </>
                )}
              </scrollbox>
              <box flexDirection="row" flexShrink={0}>
                <DialogAction
                  label={onboarding ? "Подключения →" : "Готово"}
                  onSelect={close}
                  palette={palette}
                  primary
                  disabled={!active}
                />
              </box>
            </>
          ) : (
            <>
              <scrollbox
                ref={scroll}
                flexGrow={1}
                marginTop={compact ? 0 : 1}
                verticalScrollbarOptions={{ visible: false }}
              >
                {!inventory || !found.length ? (
                  <text fg={unavailable ? palette.yellow : palette.muted}>
                    {unavailable
                      ? "Не удалось прочитать часть источников."
                      : inventory
                        ? "Данные для переноса не найдены."
                        : "Поиск локальных данных…"}
                  </text>
                ) : wide ? (
                  <box flexDirection="row" gap={2}>
                    <box width={27} flexShrink={0} flexDirection="column">
                      <text paddingLeft={1} fg={palette.muted}>
                        Источник
                      </text>
                      {rows.slice(0, 4).map(renderRow)}
                    </box>
                    <box flexGrow={1} flexDirection="column">
                      <text paddingLeft={1} fg={palette.muted}>
                        Что перенести
                      </text>
                      {rows.slice(4).map(renderRow)}
                    </box>
                  </box>
                ) : (
                  <>
                    <text fg={palette.muted}>Источник</text>
                    {rows.slice(0, 4).map(renderRow)}
                    <text fg={palette.muted}>Что перенести</text>
                    {rows.slice(4).map(renderRow)}
                  </>
                )}
                {inventory && found.length > 0 && !compact && (
                  <box marginTop={1} flexDirection="column">
                    <text fg={palette.muted}>
                      Импорт выполняется локально. MCP добавляются выключенными.
                    </text>
                    {unavailable && (
                      <text fg={palette.yellow}>
                        Часть источников недоступна.
                      </text>
                    )}
                  </box>
                )}
              </scrollbox>
              <box
                flexDirection={innerWidth >= 34 ? "row" : "column"}
                flexShrink={0}
                gap={innerWidth >= 34 ? 1 : 0}
              >
                <DialogAction
                  id="migration-apply"
                  label={total ? `Импортировать · ${total}` : "Импортировать"}
                  onSelect={start}
                  palette={palette}
                  active={focused === "apply"}
                  primary={focused === "apply"}
                  disabled={!active || !total}
                />
                <DialogAction
                  id="migration-skip"
                  label={onboarding ? "Пропустить" : "Закрыть"}
                  onSelect={close}
                  palette={palette}
                  active={focused === "skip"}
                  primary={focused === "skip"}
                  disabled={!active}
                />
              </box>
              {!compact && (
                <text fg={palette.muted} height={1}>
                  Tab / ↑↓ выбор · Space переключить · Enter подтвердить · Esc
                  выйти
                </text>
              )}
            </>
          )}
        </>
      )}
    </OpenTuiDialog>
  );
}
