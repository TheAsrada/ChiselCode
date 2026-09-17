import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DownloadedAsset, SelfUpdatePlan } from "../commands/update.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolver,
} from "../security/approval.js";
import {
  buildActiveSkillsPrompt,
  expandSkill,
  invocableSkills,
  loadSkills,
  type Skill,
} from "../skills/skills.js";
import type { ProviderKind } from "../types/domain.js";
import {
  commandHelpText,
  isSlashInput,
  MAX_VISIBLE_SUGGESTIONS,
  matchingCommands,
  parseSlashCommand,
  type SlashCommandName,
  suggestSimilarCommand,
} from "./commands.js";
import {
  addEditorHistory,
  backspaceEditorText,
  createEditorState,
  deleteEditorText,
  insertEditorText,
  isFirstEditorLine,
  isLastEditorLine,
  moveEditorCursor,
  navigateEditorHistory,
} from "./editor.js";
import { MarkdownText, parseBlocks } from "./markdown.js";
import {
  type ModelListResult,
  SettingsPanel,
  type TuiSettingsValues,
} from "./settings.js";
import { SetupApp, type SetupValues } from "./setup.js";
import { SkillsPanel } from "./skills.js";
import { type ToolTone, toolDisplay, toolTone } from "./theme.js";
import { Thinking } from "./thinking.js";

export interface TuiApprovalResolver extends ApprovalResolver {
  bind(setter?: (request: ApprovalRequest | undefined) => void): void;
  resolve(decision: ApprovalDecision): void;
  dispose(): void;
}

export type TranscriptTone =
  | "assistant"
  | "user"
  | "tool"
  | "info"
  | "warn"
  | "error"
  | "success"
  | "brand";

export interface TuiTranscriptLine {
  id: number;
  text: string;
  tone?: TranscriptTone;
}
export interface TuiTranscript {
  append(line: string, tone?: TranscriptTone): void;
  appendToLast(text: string): void;
  clear(): void;
}

/**
 * Адаптивная раскладка как в Claude Code:
 * - шапка закреплена сверху и занимает всю ширину окна;
 * - история занимает всё свободное место и пересчитывается при ресайзе;
 * - поле ввода / подтверждение закреплены снизу на всю ширину и растут вверх.
 * Все оценки высоты считаются от актуального числа колонок, поэтому при
 * разворачивании окна ввод не «съезжает», а текст просто переоборачивается.
 * Кадр клампится к живому размеру окна (clampViewportToTerminal) и рисуется
 * явным width={columns}: даже в переходный кадр ресайза вывод не шире
 * физического окна, иначе терминал переносит строки сам и счётчик строк
 * Ink рассинхронизируется — весь интерфейс «искажает» навсегда.
 * Живой размер проталкивается в process.stdout (syncTerminalSizeToStdout),
 * потому что Yoga-корень Ink читает только stdout.columns/rows и на
 * Windows застревает на 80x24 без этого синхрона (узкий кадр посреди
 * полного экрана).
 */
export const TUI_MIN_COLUMNS = 20;
export const TUI_MIN_ROWS = 10;
export const TUI_HEADER_ROWS = 2;
export const TUI_FALLBACK_COLUMNS = 80;
export const TUI_FALLBACK_ROWS = 24;

export interface TuiViewport {
  columns: number;
  rows: number;
}

/** Нормализует размеры Ink к безопасному диапазону для математики layout. */
export function normalizeViewport(viewport: {
  columns?: number;
  rows?: number;
}): TuiViewport {
  const columns = Math.floor(viewport.columns ?? TUI_FALLBACK_COLUMNS);
  const rows = Math.floor(viewport.rows ?? TUI_FALLBACK_ROWS);
  return {
    columns: Math.max(
      Number.isFinite(columns) && columns > 0 ? columns : TUI_FALLBACK_COLUMNS,
      TUI_MIN_COLUMNS,
    ),
    rows: Math.max(
      Number.isFinite(rows) && rows > 0 ? rows : TUI_FALLBACK_ROWS,
      TUI_MIN_ROWS,
    ),
  };
}

/** Разумные пределы видимого окна: больше — почти наверняка высота
 * буфера conhost, а не экрана (в Bun stdout.rows бывает и 3000). */
const MAX_VISIBLE_COLUMNS = 1000;
const MAX_VISIBLE_ROWS = 400;
/** Как часто перепроверяем размер окна (событие resize в Bun/Windows ненадёжно).
 * Опрос дешёвый: только поля TTY и переменные окружения, без дочерних
 * процессов — интерфейс никогда не блокируется на время опроса.
 * Интервал короткий, чтобы пропущенное событие resize быстро подхватить
 * следующим опросом: кадр при этом всегда клампится к живому размеру
 * (см. clampViewportToTerminal), поэтому промежуточные кадры только уже —
 * уже безопасно, шире — нет. */
const VIEWPORT_POLL_MS = 500;

function saneDimension(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  const floored = Math.floor(num);
  if (floored < min || floored > max) return undefined;
  return floored;
}

/** Все источники размера терминала в одном месте — чистые данные для тестов. */
export interface TerminalSizeSources {
  stdoutColumns?: unknown;
  stdoutRows?: unknown;
  windowColumns?: unknown;
  windowRows?: unknown;
  /** Запасной источник (legacy): видимое окно консоли Windows.
   * Больше не опрашивается в пути рендера — только для совместимости. */
  consoleColumns?: unknown;
  consoleRows?: unknown;
  envColumns?: unknown;
  envRows?: unknown;
  inkColumns?: unknown;
  inkRows?: unknown;
}

/**
 * Сводит источники размера в один. Правила:
 * - getWindowSize → stdout → env → Ink → Console (по приоритету заполнения);
 * - значения вне пределов видимого окна отбрасываются (высота буфера
 *   conhost 3000 — не экран);
 * - источник Console — только запасной вариант на случай, если все
 *   остальные пусты: он никогда не перекрывает живой размер TTY/Ink.
 *   Переоценка размера страшнее недооценки: кадр выше окна уводит
 *   закреплённую шапку за верхний край, а опрос с дочерними процессами
 *   блокирует интерфейс — поэтому никаких спаунов в пути рендера.
 *
 * Почему getWindowSize первым: `stdout.columns/rows` — кэшированное поле,
 * которое на Windows/conhost застревает на 80x24 (событие resize в Bun
 * ненадёжно), а Ink читает именно его и рисует узкий кадр посреди полного
 * экрана. Сисколл `getWindowSize()` опрашивает консоль вживую и отдаёт
 * реальный полноэкранный размер — поэтому он первичен.
 */
export function resolveTerminalSize(
  sources: TerminalSizeSources,
  _options?: { preferConsole?: boolean },
): { columns?: number; rows?: number } {
  const columns =
    saneDimension(
      sources.windowColumns,
      TUI_MIN_COLUMNS,
      MAX_VISIBLE_COLUMNS,
    ) ??
    saneDimension(
      sources.stdoutColumns,
      TUI_MIN_COLUMNS,
      MAX_VISIBLE_COLUMNS,
    ) ??
    saneDimension(sources.envColumns, TUI_MIN_COLUMNS, MAX_VISIBLE_COLUMNS) ??
    saneDimension(sources.inkColumns, TUI_MIN_COLUMNS, MAX_VISIBLE_COLUMNS) ??
    saneDimension(sources.consoleColumns, TUI_MIN_COLUMNS, MAX_VISIBLE_COLUMNS);
  const rows =
    saneDimension(sources.windowRows, TUI_MIN_ROWS, MAX_VISIBLE_ROWS) ??
    saneDimension(sources.stdoutRows, TUI_MIN_ROWS, MAX_VISIBLE_ROWS) ??
    saneDimension(sources.envRows, TUI_MIN_ROWS, MAX_VISIBLE_ROWS) ??
    saneDimension(sources.inkRows, TUI_MIN_ROWS, MAX_VISIBLE_ROWS) ??
    saneDimension(sources.consoleRows, TUI_MIN_ROWS, MAX_VISIBLE_ROWS);
  return { columns, rows };
}

/**
 * Кламп вьюпорта к живому размеру терминала — главный фикс искажения
 * текста при ресайзе.
 *
 * Проблема: состояние вьюпорта (`useLiveViewport`/`useWindowSize`) отстаёт
 * от реального окна на один кадр — событие resize уже пришло в Ink
 * (корневой Yoga-узел уже новой ширины), а пропсы кадра ещё старые.
 * Если окно сузили (120 → 80), а кадр отрисован шириной 120, Ink выводит
 * строки длиннее физического окна: терминал сам переносит их, счётчик
 * строк log-update рассинхронизируется — и дальше каждый кадр стирает
 * не то число строк. Отсюда «весь интерфейс искажает», и артефакты уже
 * не уходят сами.
 *
 * Правило: кадр никогда не шире/выше живого окна. Уже — безопасно
 * (пустая кромка на один кадр), шире — нет (перенос терминалом и вечные
 * артефакты). Поэтому берём минимум, когда оба размера известны;
 * когда живой размер недоступен (pipe/CI) — остаётся вьюпорт.
 */
export function clampViewportToTerminal(
  viewport: TuiViewport,
  terminal: { columns?: unknown; rows?: unknown },
): TuiViewport {
  const liveColumns = saneDimension(
    terminal.columns,
    TUI_MIN_COLUMNS,
    MAX_VISIBLE_COLUMNS,
  );
  const liveRows = saneDimension(terminal.rows, TUI_MIN_ROWS, MAX_VISIBLE_ROWS);
  return {
    columns:
      liveColumns !== undefined
        ? Math.min(viewport.columns, liveColumns)
        : viewport.columns,
    rows:
      liveRows !== undefined
        ? Math.min(viewport.rows, liveRows)
        : viewport.rows,
  };
}

/**
 * Реальный размер терминала: прямой опрос TTY (getWindowSize + stdout)
 * плюс переменные окружения. Только дешёвые синхронные чтения —
 * никаких дочерних процессов: кадр собирается мгновенно, а полноэкранный
 * режим и максимизация подхватываются через событие resize и опрос.
 * Источник Ink подмешивается вызывающим кодом как запасной вариант.
 * Порядок важен: живой сисколл getWindowSize() первее кэшированных
 * `stdout.columns/rows` (см. resolveTerminalSize).
 */
export function readLiveTerminalSize(): {
  columns?: number;
  rows?: number;
} {
  let windowColumns: unknown;
  let windowRows: unknown;
  let stdoutColumns: unknown;
  let stdoutRows: unknown;
  try {
    const stdout = process.stdout as NodeJS.WriteStream & {
      getWindowSize?: () => [number, number];
    };
    stdoutColumns = stdout?.columns;
    stdoutRows = stdout?.rows;
    if (typeof stdout?.getWindowSize === "function") {
      const size = stdout.getWindowSize();
      windowColumns = size?.[0];
      windowRows = size?.[1];
    }
  } catch {
    // Нет TTY — дальше другие источники и fallback 80x24.
  }
  return resolveTerminalSize({
    stdoutColumns,
    stdoutRows,
    windowColumns,
    windowRows,
    envColumns: process.env.COLUMNS,
    envRows: process.env.LINES,
  });
}

export interface TerminalSizeReport {
  stdoutColumns: unknown;
  stdoutRows: unknown;
  windowColumns: unknown;
  windowRows: unknown;
  hasGetWindowSize: boolean;
  envColumns: unknown;
  envRows: unknown;
  liveColumns?: number;
  liveRows?: number;
  isTTY: boolean;
}

/**
 * Сырые источники размера для диагностики (`chisel doctor`).
 * Показывает, врёт ли рантайм: классика conhost — stdout.rows равен высоте
 * БУФЕРА (3000), а не окна; тогда live.rows пуст и TUI едет по высоте.
 */
export function describeTerminalSize(): TerminalSizeReport {
  let stdoutColumns: unknown;
  let stdoutRows: unknown;
  let windowColumns: unknown;
  let windowRows: unknown;
  let hasGetWindowSize = false;
  let isTTY = false;
  try {
    const stdout = process.stdout as unknown as {
      columns?: unknown;
      rows?: unknown;
      isTTY?: unknown;
      getWindowSize?: () => [number, number];
    };
    stdoutColumns = stdout?.columns;
    stdoutRows = stdout?.rows;
    isTTY = stdout?.isTTY === true;
    if (typeof stdout?.getWindowSize === "function") {
      hasGetWindowSize = true;
      try {
        const size = stdout.getWindowSize();
        windowColumns = size?.[0];
        windowRows = size?.[1];
      } catch {
        // Сисколл недоступен — ниже будет помечено отсутствием значений.
      }
    }
  } catch {
    // Нет TTY — все поля останутся undefined.
  }
  const live = readLiveTerminalSize();
  return {
    stdoutColumns,
    stdoutRows,
    windowColumns,
    windowRows,
    hasGetWindowSize,
    envColumns: process.env.COLUMNS,
    envRows: process.env.LINES,
    liveColumns: live.columns,
    liveRows: live.rows,
    isTTY,
  };
}

/** Одна строка для `chisel doctor`: всё про размер терминала сразу. */
export function formatTerminalSizeLine(report: TerminalSizeReport): string {
  const show = (value: unknown): string =>
    value === undefined || value === null || value === "" ? "—" : String(value);
  const live =
    report.liveColumns !== undefined || report.liveRows !== undefined
      ? `${show(report.liveColumns)}x${show(report.liveRows)}`
      : "не определён (fallback 80x24)";
  return (
    `Терминал: live ${live} · ` +
    `stdout ${show(report.stdoutColumns)}x${show(report.stdoutRows)} · ` +
    `getWindowSize ${report.hasGetWindowSize ? `${show(report.windowColumns)}x${show(report.windowRows)}` : "нет метода"} · ` +
    `TTY ${report.isTTY ? "да" : "нет"}`
  );
}

/**
 * Проталкивает живой размер обратно в `process.stdout.columns/rows`.
 *
 * Зачем: Ink вычисляет ширину Yoga-корня только из `stdout.columns/rows`
 * (см. `getWindowSize()` в `node_modules/ink/build/utils.js` — сисколл
 * `getWindowSize()` он не вызывает). На Windows/conhost эти поля застревают
 * на 80x24, и корневой узел остаётся узким: `width="100%"` рисует узкий
 * кадр посреди полного экрана (пустота справа, как на баг-репорте), а
 * `clampViewportToTerminal` по stale-значению не даёт вырасти.
 *
 * После записи эмитим `resize`, чтобы Ink выполнил свой штатный путь
 * сужения (clear экрана + пересчёт layout) даже когда Bun не прислал
 * событие сам: иначе переходный широкий кадр оставляет вечные артефакты,
 * которые уходили только после ввода текста (следующего ре-рендера).
 *
 * ВАЖНО: эмит запрещён в пути React-рендера (TuiApp вызывает с
 * emitResize=false). Подписчик Ink (`resized()`) срабатывает синхронно:
 * эмит посреди рендера даёт ре-entrant рендер Ink внутри рендера React —
 * состояние log-update (счётчик строк) портится и интерфейс уходит
 * в вечный рассинхрон на каждом ресайзе. Эмитить можно только вне рендера:
 * опрос useLiveViewport, синхрон до render() в cli.ts.
 *
 * Чистый эффект: только присвоение полей TTY, без дочерних процессов.
 * Возвращает живой размер для клампа текущего кадра.
 */
export function syncTerminalSizeToStdout(emitResize = true): {
  columns?: number;
  rows?: number;
} {
  const live = readLiveTerminalSize();
  try {
    const stdout = process.stdout as unknown as {
      columns?: unknown;
      rows?: unknown;
      emit?: (event: string) => boolean;
    };
    let changed = false;
    if (
      live.columns !== undefined &&
      stdout.columns !== live.columns &&
      Number.isFinite(live.columns)
    ) {
      stdout.columns = live.columns;
      changed = true;
    }
    if (
      live.rows !== undefined &&
      stdout.rows !== live.rows &&
      Number.isFinite(live.rows)
    ) {
      stdout.rows = live.rows;
      changed = true;
    }
    if (changed && emitResize && typeof stdout.emit === "function") {
      try {
        stdout.emit("resize");
      } catch {
        // Эмит — best effort: Ink и наш опрос подхватят размер и без него.
      }
    }
  } catch {
    // Pipe/CI без TTY: нечего синхронизировать, размер возьмётся из Ink.
  }
  return live;
}

/**
 * Безопасное слияние двух источников размера: кадр никогда не больше
 * меньшего из известных размеров. Переоценка страшнее недооценки: кадр
 * выше/шире физического окна (или шире Yoga-корня Ink) терминал переносит
 * сам — счётчик строк Ink рассинхронизируется, а закреплённая шапка уезжает
 * за верхний край навсегда. Недооценка даёт лишь узкий кадр на один опрос,
 * который следующим resize догоняет полный экран.
 */
export function pickSafeViewportDimension(
  liveValue: number | undefined,
  inkValue: number | undefined,
): number | undefined {
  if (liveValue !== undefined && inkValue !== undefined)
    return Math.min(liveValue, inkValue);
  return liveValue ?? inkValue;
}

/**
 * Отличается ли размер A от размера B. Единая точка сравнения для пути
 * уведомлений о ресайзе: решение «надо ли пинать Ink» принимается по
 * ref-флагу последнего уведомлённого размера, а НЕ по сравнению живого
 * размера с полями `stdout.columns/rows` (см. lastNotifiedRef ниже).
 */
export function isViewportSizeChanged(
  next: { columns?: number; rows?: number },
  prev: { columns?: number; rows?: number },
): boolean {
  return next.columns !== prev.columns || next.rows !== prev.rows;
}

/**
 * Живой вьюпорт: Ink-сигнал + прямой опрос TTY + событие resize
 * + дешёвый опрос раз в VIEWPORT_POLL_MS (в Bun событие resize может
 * не приходить, тогда максимизация окна подхватывается опросом).
 *
 * Кадр берёт МИНИМУМ живого TTY и размера Ink, а не приоритет live:
 * при запуске через ярлык размер консоли «устаканивается» уже после
 * пре-рендер синхрона (cli.ts) — свежий live больше stale-корня Ink,
 * созданного в render(), и широкий кадр выталкивает шапку за верхний
 * край до первого ввода. Минимум держит кадр внутри корня (шапка видна
 * сразу), а эффект ниже догоняет корень форсированным resize без ожидания
 * ввода: Ink перечитывает уже синхронизированный stdout и кадр сам
 * вырастает до полного экрана за пару кадров.
 */
function useLiveViewport(): TuiViewport {
  const inkSize = useWindowSize();
  const [live, setLive] = useState(() => readLiveTerminalSize());
  // Последний размер, о котором мы УЖЕ уведомили Ink через emit('resize').
  // Отдельный флаг, а не сравнение с полями stdout.columns/rows: тихий
  // синхрон в пути рендера (TuiApp, emitResize=false) пишет туда свежий
  // размер без эмита — и старое сравнение «live vs stdout» видело
  // changed=false и глотало уведомление. Итог: событие resize ОС потеряно
  // (conhost/Bun его часто не шлёт) + уведомление съедено тихим синхроном
  // + в idle нет рендеров — корень Yoga Ink и счётчики строк log-update
  // оставались stale НАВСЕГДА, интерфейс «съезжал» при fullscreen/resize
  // и чинился только следующим вводом (первым же setState с пересчётом).
  // Ref-флаг неуязвим к порядку записи: уведомили один раз на каждое
  // distinct-изменение живого размера — и Ink всегда получает свой штатный
  // путь resized() (clear при сужении + пересчёт layout + перерисовка).
  const lastNotifiedRef = useRef(live);
  useEffect(() => {
    let disposed = false;
    const update = (): void => {
      if (disposed) return;
      // Только запись, без эмита внутри: эмит ниже — один на изменение,
      // по ref-флагу. Порядок важен: флаг обновляем ДО эмита, потому что
      // update сам подписан на 'resize' — вложенный вызов должен увидеть,
      // что уведомление уже отправлено, иначе будет рекурсия.
      const next = syncTerminalSizeToStdout(false);
      if (isViewportSizeChanged(next, lastNotifiedRef.current)) {
        lastNotifiedRef.current = next;
        try {
          const stdout = process.stdout as unknown as {
            emit?: (event: string) => boolean;
          };
          stdout.emit?.("resize");
        } catch {
          // Best effort: Ink и следующий ввод догонят размер и без пинка.
        }
      }
      setLive((prev) => {
        if (!isViewportSizeChanged(next, prev)) return prev;
        return next;
      });
    };
    update();
    const stdout = process.stdout as unknown as {
      on?: (event: string, listener: () => void) => void;
      off?: (event: string, listener: () => void) => void;
    };
    if (typeof stdout?.on === "function") stdout.on("resize", update);
    const timer = setInterval(update, VIEWPORT_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      stdout?.off?.("resize", update);
    };
  }, []);
  const liveColumns = live.columns;
  const liveRows = live.rows;
  const inkColumns = saneDimension(
    inkSize.columns,
    TUI_MIN_COLUMNS,
    MAX_VISIBLE_COLUMNS,
  );
  const inkRows = saneDimension(inkSize.rows, TUI_MIN_ROWS, MAX_VISIBLE_ROWS);
  // Догоняющий resize вне пути рендера (в эффекте — безопасно, см.
  // syncTerminalSizeToStdout): если корень Ink отстал от живого TTY,
  // штатный опрос молчит (live стабилен — changed=false, эмита нет),
  // и без пинка Ink так и останется узким навсегда. Эмит дёргает
  // подписчиков Ink (resized + useWindowSize): корень перечитывает stdout
  // и кадр вырастает до полного экрана сам, без ввода текста.
  // Эффект срабатывает один раз на расхождение: после догона размеры
  // равны и эмит прекращается — цикла нет.
  useEffect(() => {
    if (liveColumns === undefined && liveRows === undefined) return;
    const mismatch =
      (liveColumns !== undefined &&
        inkColumns !== undefined &&
        liveColumns !== inkColumns) ||
      (liveRows !== undefined && inkRows !== undefined && liveRows !== inkRows);
    if (!mismatch) return;
    try {
      const stdout = process.stdout as unknown as {
        emit?: (event: string) => boolean;
      };
      stdout.emit?.("resize");
    } catch {
      // Best effort: опрос и следующий ввод догонят размер и без пинка.
    }
  }, [liveColumns, liveRows, inkColumns, inkRows]);
  const columns = pickSafeViewportDimension(liveColumns, inkColumns);
  const rows = pickSafeViewportDimension(liveRows, inkRows);
  return normalizeViewport({ columns, rows });
}

/** Полноширинный разделитель под актуальную ширину окна. */
export function fullWidthSeparator(columns: number): string {
  return "─".repeat(Math.max(Math.floor(columns) || TUI_FALLBACK_COLUMNS, 10));
}

/**
 * Подсказка горячих клавиш под полем ввода. Держим в одну строку на 80
 * колонках, чтобы высота футера была предсказуема при любом размере окна.
 * Tab/стрелки — выбор команды как в Claude Code, Enter — выбрать/отправить.
 */
export const HOTKEYS_HINT =
  "Tab/↑/↓ — команда · Enter — отправить · Esc — закрыть · колесо — журнал";

/** Сколько строк журнала прокручивает один щелчок колеса мыши. */
export const WHEEL_SCROLL_LINES = 3;

export type WheelDirection = "up" | "down";

/** Включение SGR-режима мыши терминала (колесо едет как `\x1b[<…M`). */
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
/** Выключение: иначе после выхода в терминале ломается выделение текста. */
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

/**
 * Выкусывает события колеса из сырого потока stdin (SGR-кодировка
 * `\x1b[<Cb;Cx;CyM/m`, где 64-й бит Cb — колесо, младший — направление).
 * Возвращает направления и остаток: терминал может резать sequence
 * пополам между чанками, рваный хвост ждёт следующий.
 * Чистая функция — покрыта тестами.
 */
const ESC = String.fromCharCode(27);
const WHEEL_PATTERN = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");

export function parseWheelEvents(buffer: string): {
  wheels: WheelDirection[];
  rest: string;
} {
  const wheels: WheelDirection[] = [];
  let lastEnd = 0;
  for (const match of buffer.matchAll(WHEEL_PATTERN)) {
    const code = Number(match[1] ?? 0);
    if (match[4] === "M" && (code & 64) !== 0)
      wheels.push(code & 1 ? "down" : "up");
    lastEnd = (match.index ?? 0) + match[0].length;
  }
  const tail = buffer.slice(lastEnd);
  const escIndex = tail.lastIndexOf(ESC);
  const rest =
    escIndex !== -1 && isMousePrefix(tail.slice(escIndex))
      ? tail.slice(escIndex)
      : "";
  return { wheels, rest };
}

/** Начало mouse-последовательности: ESC, ESC[, ESC[<12;… — ждёт хвост. */
function isMousePrefix(fragment: string): boolean {
  if (!fragment.startsWith(ESC)) return false;
  const rest = fragment.slice(1);
  if (rest === "") return true;
  if (!rest.startsWith("[<")) return false;
  return /^[\d;]*$/.test(rest.slice(2));
}

export function createTuiApprovalResolver(): TuiApprovalResolver {
  let resolvePending: ((decision: ApprovalDecision) => void) | undefined;
  let setRequest: ((request: ApprovalRequest | undefined) => void) | undefined;
  return {
    async requestApproval(request) {
      if (!setRequest) return "unavailable";
      return new Promise((resolve) => {
        resolvePending = resolve;
        setRequest?.(request);
      });
    },
    bind(setter) {
      setRequest = setter;
    },
    resolve(decision) {
      resolvePending?.(decision);
      resolvePending = undefined;
      setRequest?.(undefined);
    },
    dispose() {
      resolvePending?.("unavailable");
      resolvePending = undefined;
      setRequest = undefined;
    },
  } as TuiApprovalResolver;
}

export interface TuiAppProps {
  approvalResolver: TuiApprovalResolver;
  bindTranscript(transcript: TuiTranscript): void;
  onSubmit(prompt: string, display?: string): Promise<void>;
  onStatus(): Promise<string>;
  onSwitchProject(path: string): Promise<string>;
  onCheckUpdate?(): Promise<string>;
  onDoctor?(): Promise<string>;
  /** Начать новый сеанс: следующее сообщение откроет новую сессию. */
  onNewSession?(): Promise<string>;
  /** Список сеансов проекта человекочитаемым текстом. */
  onListSessions?(): Promise<string>;
  /** Возврат к сеансу по номеру из списка или id (+реплей истории в вид). */
  onResumeSession?(ref: string): Promise<string>;
  /** План самообновления: проверка релиза + файл установщика. */
  onPlanUpdate?(): Promise<SelfUpdatePlan>;
  /** Скачивание установщика во временную папку. */
  onDownloadUpdate?(plan: SelfUpdatePlan): Promise<DownloadedAsset>;
  /**
   * Запуск установщика (Windows): после вызова приложение закрывается.
   * silent=true — тихий режим NSIS (/S) без окон: установщик всё сделает
   * сам и перезапустит приложение.
   */
  onLaunchInstaller?(path: string, silent: boolean): Promise<void>;
  onSaveSettings(
    values: TuiSettingsValues,
  ): Promise<"saved" | "setup_required">;
  /** Проверка подключения к отредактированным настройкам из /settings. */
  onCheckConnection(values: TuiSettingsValues): Promise<string>;
  /** Есть ли сохранённый ключ для сервиса (статус в /settings). */
  onKeyStatus?(provider: ProviderKind): Promise<boolean>;
  /**
   * Список моделей провайдера для интерактивного выбора в /model.
   * Необязателен: без него экран модели — ручной ввод, как раньше.
   */
  onListModels?(values: TuiSettingsValues): Promise<ModelListResult>;
  /**
   * Сохранение заново пройденного мастера настройки.
   * Выполняется внутри того же Ink-приложения: TUI не размонтируется,
   * поэтому перезапуск настройки больше не роняет интерфейс.
   */
  onCompleteSetup(values: SetupValues): Promise<void>;
  provider: ProviderKind;
  providerLabel: string;
  model: string;
  baseUrl?: string;
  version?: string;
  /**
   * Корень проекта для скиллов (`.chisel/skills`, `.agents/skills`).
   * Без него — текущий рабочий каталог процесса.
   */
  cwd?: string;
}

export function TuiApp(props: TuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  const viewport = useLiveViewport();
  /** Корень проекта: скиллы берём из его `.chisel/skills`. */
  const projectCwd = props.cwd ?? process.cwd();
  /**
   * Живой размер — синхронный опрос консоли прямо во время рендера
   * (дешёвый, без спаунов). Это раньше, чем состояние
   * `viewport`/`useWindowSize` (оно приходит следующим рендером через
   * интервал или событие resize): ввод символа сразу пересчитывает кадр
   * на актуальную ширину, а не ждёт 500 мс опроса.
   * Заодно проталкиваем размер в `process.stdout`, чтобы Yoga-корень Ink
   * (он читает только `stdout.columns/rows`) уже этот кадр считал layout
   * на правильной ширине — иначе полноэкранный кадр остаётся узким 80.
   * Без эмита resize: эмит посреди рендера даёт ре-entrant рендер Ink
   * (см. syncTerminalSizeToStdout) — resize рассылает только опрос
   * вне рендера. Присвоение полей подписчиков не триггерит и безопасно.
   * Кламп гарантирует: кадр никогда не шире/выше физического окна,
   * иначе терминал переносит длинные строки сам и счётчик строк Ink
   * рассинхронизируется навсегда (искажение всего интерфейса).
   */
  const liveTerminal = syncTerminalSizeToStdout(false);
  const { columns, rows } = clampViewportToTerminal(viewport, liveTerminal);
  const [editor, setEditor] = useState(createEditorState);
  const [request, setRequest] = useState<ApprovalRequest>();
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<"menu" | "model">();
  const [skillsOpen, setSkillsOpen] = useState(false);
  // Мастер настройки поверх чата: тот же Ink-экран, без exit()/render().
  const [restartingSetup, setRestartingSetup] = useState(false);
  const [runtime, setRuntime] = useState(() => ({
    provider: props.provider,
    providerLabel: props.providerLabel,
    model: props.model,
    baseUrl: props.baseUrl,
  }));
  const [transcript, setTranscript] = useState<TuiTranscriptLine[]>(
    intro(props.providerLabel, props.model, props.version),
  );
  // Незавершённый стриминговый ответ живёт отдельно от истории:
  // alternate screen никогда не получает статический вывод в скроллбэк,
  // а незавершённая строка остаётся частью перерисовываемого кадра.
  const [streaming, setStreaming] = useState<TuiTranscriptLine | null>(null);
  const [transcriptOffset, setTranscriptOffset] = useState(0);
  const streamingRef = useRef<TuiTranscriptLine | null>(null);
  const nextTranscriptId = useRef(0);
  const skills = loadSkills(projectCwd);
  // Как /команды вызываются только invocable-скиллы; скрытые
  // (`user-invocable: false`) живут только в каталоге и /skills.
  const slashSkills = invocableSkills(skills);
  const suggestions = isSlashInput(editor.value)
    ? matchingCommands(editor.value, slashSkills)
    : [];
  // Скиллы, задействованные через /skills: их инструкции прикладываются
  // к каждому следующему запросу, пока не отключишь.
  const [activeSkillNames, setActiveSkillNames] = useState<string[]>([]);
  const activeSkills = skills.filter((skill) =>
    activeSkillNames.includes(skill.name),
  );
  /**
   * Выбор команды как в Claude Code: стрелки ↑/↓ двигают подсветку,
   * Tab/Enter принимают подсвеченную. Отдельное состояние вместо
   * Tab-цикла через completeRef: подсветка не зависит от подстановки,
   * история недоступна пока список открыт (как в Claude Code).
   */
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  // Список активен: есть совпадения, ввод однострочный без аргументов
  // (пробел уже гасит список через matchingCommands) и пользователь
  // не закрыл его через Esc. Многострочник (Shift+Enter) гасит выбор.
  const hasCommandSelection =
    suggestions.length > 0 &&
    !suggestionsDismissed &&
    !editor.value.includes("\n");
  const selectedSuggestionIndex = hasCommandSelection
    ? suggestionIndex % suggestions.length
    : 0;
  /** Команды с аргументами получают trailing-пробел при подстановке. */
  const needsTrailingSpace = (name: string): boolean => {
    if (name === "/cwd" || name === "/resume") return true;
    // Скиллы всегда принимают аргументы (дописываются к инструкциям).
    return slashSkills.some((skill) => `/${skill.name}` === name);
  };
  const acceptSelectedSuggestion = (): boolean => {
    const selected = suggestions[selectedSuggestionIndex];
    if (!hasCommandSelection || !selected) return false;
    const filled = needsTrailingSpace(selected.name)
      ? `${selected.name} `
      : selected.name;
    setEditor((state) => ({
      ...state,
      value: filled,
      cursor: filled.length,
    }));
    return true;
  };
  const resetCommandSelection = (): void => {
    setSuggestionIndex(0);
    setSuggestionsDismissed(false);
  };
  // Показываем не больше MAX_VISIBLE_SUGGESTIONS строк: окно сдвигается за
  // выбранной, остаток — счётчиком. Те же строки идут в замер высоты футера.
  const suggestionWindowStart =
    Math.floor(selectedSuggestionIndex / MAX_VISIBLE_SUGGESTIONS) *
    MAX_VISIBLE_SUGGESTIONS;
  const visibleSuggestions = suggestions.slice(
    suggestionWindowStart,
    suggestionWindowStart + MAX_VISIBLE_SUGGESTIONS,
  );
  const hiddenSuggestionsCount =
    suggestions.length - (suggestionWindowStart + visibleSuggestions.length);
  const selectedVisibleIndex = selectedSuggestionIndex - suggestionWindowStart;
  const suggestionRows = visibleSuggestions.map((command, index) =>
    index === selectedVisibleIndex
      ? `❯ ${command.name} — ${command.description}`
      : `  ${command.name}`,
  );
  if (hiddenSuggestionsCount > 0)
    suggestionRows.push(`…и ещё ${hiddenSuggestionsCount}`);

  useEffect(() => {
    props.approvalResolver.bind(setRequest);
    return () => props.approvalResolver.dispose();
  }, [props.approvalResolver]);
  // Длина журнала для колеса мыши: эффект ниже читает её из рефа,
  // чтобы не подписываться на каждое сообщение заново.
  const transcriptLengthRef = useRef(0);
  useEffect(() => {
    // Колесо мыши: включаем SGR mouse-режим терминала и слушаем сырой stdin
    // параллельно с Ink (его подписку не трогаем — клавиатура едет мимо).
    // При размонтировании режим выключаем, иначе в терминале после выхода
    // сломается выделение текста мышью.
    const stdin = process.stdin as unknown as {
      on?: (event: string, listener: (chunk: unknown) => void) => void;
      off?: (event: string, listener: (chunk: unknown) => void) => void;
      isTTY?: boolean;
    };
    const stdout = process.stdout as unknown as {
      write?: (data: string) => void;
      isTTY?: boolean;
    };
    if (stdin?.isTTY !== true || typeof stdout?.write !== "function") return;
    let rest = "";
    const onData = (chunk: unknown): void => {
      const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
      const parsed = parseWheelEvents(rest + text);
      rest = parsed.rest;
      if (parsed.wheels.length === 0) return;
      const max = Math.max(transcriptLengthRef.current - 1, 0);
      for (const direction of parsed.wheels) {
        const delta =
          direction === "up" ? WHEEL_SCROLL_LINES : -WHEEL_SCROLL_LINES;
        setTranscriptOffset((offset) =>
          Math.max(0, Math.min(offset + delta, max)),
        );
      }
      if (rest.length > 256) rest = "";
    };
    stdout.write(MOUSE_ENABLE);
    stdin.on?.("data", onData);
    return () => {
      stdin.off?.("data", onData);
      try {
        stdout.write?.(MOUSE_DISABLE);
      } catch {
        // Выход и так закрывает экран — молча уходим.
      }
    };
  }, []);
  const pushLine = useCallback(
    (text: string, tone: TranscriptTone = "assistant"): void => {
      const flushed = streamingRef.current;
      streamingRef.current = null;
      setStreaming(null);
      const id = nextTranscriptId.current++;
      setTranscript((lines) => [
        ...lines,
        ...(flushed ? [flushed] : []),
        { id, text, tone },
      ]);
      setTranscriptOffset(0);
    },
    [],
  );

  const appendToStreaming = useCallback((text: string): void => {
    const current = streamingRef.current;
    if (current) {
      const next = { ...current, text: current.text + text };
      streamingRef.current = next;
      setStreaming(next);
    } else {
      const line: TuiTranscriptLine = {
        id: nextTranscriptId.current++,
        text,
        tone: "assistant",
      };
      streamingRef.current = line;
      setStreaming(line);
    }
    setTranscriptOffset(0);
  }, []);

  const clearAll = useCallback((): void => {
    streamingRef.current = null;
    setStreaming(null);
    setTranscript([]);
    setTranscriptOffset(0);
  }, []);

  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const flushed = streamingRef.current;
      if (flushed) {
        streamingRef.current = null;
        setStreaming(null);
        setTranscript((lines) => [...lines, flushed]);
        setTranscriptOffset(0);
      }
    }
    wasBusy.current = busy;
  }, [busy]);

  useEffect(() => {
    props.bindTranscript({
      append: (text, tone = "assistant") => pushLine(text, tone),
      appendToLast: (text) => appendToStreaming(text),
      clear: () => clearAll(),
    });
  }, [props.bindTranscript, pushLine, appendToStreaming, clearAll]);

  function append(text: string, tone: TranscriptTone = "assistant"): void {
    pushLine(text, tone);
  }
  function submit(value: string): void {
    const prompt = value.trim();
    if (!prompt) return;
    const command = parseSlashCommand(prompt);
    if (command) {
      void runCommand(command.name, command.args);
      return;
    }
    if (isSlashInput(prompt)) {
      const skill = findSkill(prompt);
      if (skill) {
        runSkill(prompt, skill.skill, skill.args);
        return;
      }
      const similar = suggestSimilarCommand(prompt, slashSkills);
      append(
        similar
          ? `Неизвестная команда: ${prompt}. Возможно, вы имели в виду ${similar}?`
          : `Неизвестная команда: ${prompt}. Введите /help.`,
        "error",
      );
      setEditor((state) => addEditorHistory(state, prompt));
      resetCommandSelection();
      return;
    }
    submitPrompt(prompt);
  }
  /**
   * Отправка текста агенту. display — что показать в журнале вместо самого
   * текста: для скиллов виден короткий `/имя args`, а выполняется
   * развёрнутый шаблон. Задействованные через /skills скиллы прикладываются
   * к каждому запросу маркированным блоком (в журнале — только display).
   */
  function submitPrompt(prompt: string, display?: string): void {
    setEditor((state) => addEditorHistory(state, display ?? prompt));
    resetCommandSelection();
    const full = buildActiveSkillsPrompt(activeSkills, prompt);
    setBusy(true);
    void props
      .onSubmit(full, display)
      .catch((cause) =>
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        ),
      )
      .finally(() => setBusy(false));
  }
  function findSkill(
    prompt: string,
  ): { skill: Skill; args: string } | undefined {
    const space = prompt.search(/\s/);
    const head = space === -1 ? prompt : prompt.slice(0, space);
    if (!head.startsWith("/") || head.length < 2) return undefined;
    const args = space === -1 ? "" : prompt.slice(space).trim();
    const skill = invocableSkills(loadSkills(projectCwd)).find(
      (candidate) => `/${candidate.name}` === head,
    );
    return skill ? { skill, args } : undefined;
  }
  function runSkill(display: string, skill: Skill, args: string): void {
    setEditor(createEditorState());
    resetCommandSelection();
    submitPrompt(expandSkill(skill, args), display);
  }
  async function runCommand(name: SlashCommandName, args = ""): Promise<void> {
    setEditor(createEditorState());
    resetCommandSelection();
    if (name === "/help") {
      append(commandHelpText(loadSkills(projectCwd)), "info");
      return;
    }
    if (name === "/clear") {
      clearAll();
      try {
        append((await props.onNewSession?.()) ?? "Экран очищен.", "info");
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      }
      return;
    }
    if (name === "/new") {
      clearAll();
      try {
        append((await props.onNewSession?.()) ?? "Начат новый сеанс.", "info");
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      }
      return;
    }
    if (name === "/sessions") {
      setBusy(true);
      try {
        append(
          (await props.onListSessions?.()) ?? "Список сеансов недоступен.",
          "info",
        );
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (name === "/resume") {
      setBusy(true);
      try {
        append(
          (await props.onResumeSession?.(args)) ??
            "Возврат к сеансу недоступен.",
          "info",
        );
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (name === "/exit") {
      exit();
      return;
    }
    if (name === "/cwd") {
      setBusy(true);
      try {
        append(await props.onSwitchProject(args), "info");
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (name === "/settings") {
      setSettings("menu");
      return;
    }
    if (name === "/model") {
      setSettings("model");
      return;
    }
    if (name === "/skills") {
      setSkillsOpen(true);
      return;
    }
    if (name === "/update") {
      await runSelfUpdate();
      return;
    }
    if (name === "/doctor") {
      setBusy(true);
      try {
        append(await (props.onDoctor?.() ?? props.onStatus()), "info");
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      append(await props.onStatus(), "info");
    } catch (cause) {
      append(
        `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * `/update`: проверка релиза → подтверждение y/n → скачивание →
   * установка и выход. Без новых пропов падает назад на текстовую проверку.
   */
  async function runSelfUpdate(): Promise<void> {
    if (!props.onPlanUpdate) {
      setBusy(true);
      try {
        append(
          (await props.onCheckUpdate?.()) ??
            "Проверка обновлений недоступна в этом сеансе. Откройте https://github.com/TheAsrada/ChiselCode/releases",
          "info",
        );
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      const plan = await props.onPlanUpdate();
      if (plan.error) {
        append(`⚠ Не удалось проверить обновление: ${plan.error}`, "warn");
        return;
      }
      if (!plan.updateAvailable) {
        append(
          `✓ У вас последняя версия ChiselCode v${plan.current}`,
          "success",
        );
        return;
      }
      const version = plan.latest ?? plan.current;
      if (!plan.installedBinary) {
        append(
          [
            `◈ ChiselCode: доступна новая версия v${version} (у вас v${plan.current})`,
            "Запущено из исходников, поэтому ставлю вручную: скачайте установщик со страницы релиза",
            `${plan.latestUrl ?? "https://github.com/TheAsrada/ChiselCode/releases"}`,
            `или обновите код: git pull`,
          ].join("\n"),
          "info",
        );
        return;
      }
      const decision = await props.approvalResolver.requestApproval({
        tool: "self_update",
        preview: `Установить ChiselCode v${version}? Сейчас v${plan.current}.\nФайл: ${plan.asset}\nНичего кликать не придётся: установщик всё сделает тихо сам и перезапустит приложение.`,
      });
      if (decision !== "approved") {
        append("Обновление отменено.", "info");
        return;
      }
      if (!props.onDownloadUpdate) {
        append("Скачивание недоступно в этом сеансе.", "warn");
        return;
      }
      append(`Скачиваю ${plan.asset}…`, "info");
      const downloaded = await props.onDownloadUpdate(plan);
      append(
        `Скачано ${(downloaded.bytes / 1024 / 1024).toFixed(1)} МБ: ${downloaded.path}`,
        "info",
      );
      if (!plan.autoInstall) {
        append(
          [
            "Автоматическая установка на этой платформе требует прав.",
            "Завершите вручную:",
            `${plan.manualCommand ?? plan.url}`,
          ].join("\n"),
          "info",
        );
        return;
      }
      append("Устанавливаю тихо и перезапускаюсь…", "info");
      await props.onLaunchInstaller?.(downloaded.path, true);
      exit();
    } catch (cause) {
      append(
        `Ошибка обновления: ${cause instanceof Error ? cause.message : String(cause)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  function requestSetupRestart(): void {
    setSettings(undefined);
    setRestartingSetup(true);
  }

  async function completeRestartedSetup(values: SetupValues): Promise<void> {
    await props.onCompleteSetup(values);
    setRuntime({
      provider: values.provider,
      providerLabel: providerName(values.provider),
      model: values.model,
      baseUrl: values.baseUrl,
    });
    setRestartingSetup(false);
    pushLine(
      `✓ Настройка обновлена: ${providerName(values.provider)}, модель ${values.model}.`,
      "success",
    );
  }

  function cancelRestartedSetup(): void {
    setRestartingSetup(false);
  }

  useInput((character, key) => {
    if (request) {
      if (character.toLowerCase() === "y")
        props.approvalResolver.resolve("approved");
      if (character.toLowerCase() === "n" || key.escape)
        props.approvalResolver.resolve("denied");
      return;
    }
    if (settings || skillsOpen || restartingSetup || busy) return;
    // Скролл журнала: колесо мыши — основной способ, построчно —
    // Shift+↑/↓, Home/End — начало/конец, Esc — вернуться вниз к вводу.
    // Ввод закреплён снизу.
    if (key.escape && transcriptOffset > 0) {
      setTranscriptOffset(0);
      return;
    }
    if (key.shift && key.upArrow) {
      setTranscriptOffset((offset) =>
        Math.min(offset + 1, maxTranscriptOffset(transcriptLines)),
      );
      return;
    }
    if (key.shift && key.downArrow) {
      setTranscriptOffset((offset) => Math.max(offset - 1, 0));
      return;
    }
    if (key.home) {
      setTranscriptOffset(maxTranscriptOffset(transcriptLines));
      return;
    }
    if (key.end) {
      setTranscriptOffset(0);
      return;
    }
    if (key.ctrl && character === "c") {
      exit();
      return;
    }
    // Esc закрывает список команд как в Claude Code (скролл уже обработан выше).
    if (key.escape && hasCommandSelection) {
      setSuggestionsDismissed(true);
      return;
    }
    if (key.tab && hasCommandSelection) {
      // Tab принимает подсвеченную команду, навигация — стрелками.
      acceptSelectedSuggestion();
      return;
    }
    if (key.return) {
      if (key.shift) {
        setEditor((state) => insertEditorText(state, "\n"));
        return;
      }
      // Enter на префиксе — принять подсвеченную (как в Claude Code),
      // на точном совпадении — отправить. С аргументами список уже пуст.
      if (hasCommandSelection) {
        const trimmed = editor.value.trim();
        const selected = suggestions[selectedSuggestionIndex];
        if (selected && trimmed !== selected.name) {
          acceptSelectedSuggestion();
          return;
        }
      }
      submit(editor.value);
      return;
    }
    // Стрелки при открытом списке — навигация по командам как в Claude Code,
    // иначе — история запросов. Shift+стрелки уже ушли в скролл выше.
    if (key.upArrow && hasCommandSelection) {
      setSuggestionIndex(
        (previous) => (previous - 1 + suggestions.length) % suggestions.length,
      );
      return;
    }
    if (key.downArrow && hasCommandSelection) {
      setSuggestionIndex((previous) => (previous + 1) % suggestions.length);
      return;
    }
    if (key.upArrow && isFirstEditorLine(editor)) {
      setEditor((state) => navigateEditorHistory(state, -1));
      setSuggestionIndex(0);
      setSuggestionsDismissed(false);
      return;
    }
    if (key.downArrow && isLastEditorLine(editor)) {
      setEditor((state) => navigateEditorHistory(state, 1));
      setSuggestionIndex(0);
      setSuggestionsDismissed(false);
      return;
    }
    if (key.leftArrow) {
      setEditor((state) => moveEditorCursor(state, -1));
      return;
    }
    if (key.rightArrow) {
      setEditor((state) => moveEditorCursor(state, 1));
      return;
    }
    if (key.backspace) {
      setEditor(backspaceEditorText);
      setSuggestionIndex(0);
      setSuggestionsDismissed(false);
      return;
    }
    if (key.delete) {
      setEditor(deleteEditorText);
      setSuggestionIndex(0);
      setSuggestionsDismissed(false);
      return;
    }
    if (!key.ctrl && !key.meta && character) {
      setEditor((state) => insertEditorText(state, character));
      setSuggestionIndex(0);
      setSuggestionsDismissed(false);
    }
  });

  if (restartingSetup)
    return (
      <Box
        flexDirection="column"
        height={rows}
        width={columns}
        overflow="hidden"
      >
        <Header
          providerLabel={runtime.providerLabel}
          model={runtime.model}
          columns={columns}
          version={props.version}
        />
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          overflow="hidden"
          width="100%"
        >
          <SetupApp
            onComplete={completeRestartedSetup}
            onCancel={cancelRestartedSetup}
            exitOnComplete={false}
          />
        </Box>
      </Box>
    );
  if (settings)
    return (
      <Box
        flexDirection="column"
        height={rows}
        width={columns}
        overflow="hidden"
      >
        <Header
          providerLabel={runtime.providerLabel}
          model={runtime.model}
          columns={columns}
          version={props.version}
        />
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          overflow="hidden"
          width="100%"
        >
          <SettingsPanel
            initialValues={{
              provider: runtime.provider,
              model: runtime.model,
              baseUrl: runtime.baseUrl,
            }}
            initialScreen={settings}
            onSave={props.onSaveSettings}
            onClose={() => setSettings(undefined)}
            onCheckConnection={props.onCheckConnection}
            onListModels={props.onListModels}
            onKeyStatus={props.onKeyStatus}
            onSetupRequested={requestSetupRestart}
            onSaved={(values) =>
              setRuntime({
                provider: values.provider,
                providerLabel: providerName(values.provider),
                model: values.model,
                baseUrl: values.baseUrl,
              })
            }
          />
        </Box>
      </Box>
    );
  if (skillsOpen)
    return (
      <Box
        flexDirection="column"
        height={rows}
        width={columns}
        overflow="hidden"
      >
        <Header
          providerLabel={runtime.providerLabel}
          model={runtime.model}
          columns={columns}
          version={props.version}
        />
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          overflow="hidden"
          width="100%"
        >
          <SkillsPanel
            skills={skills}
            activeNames={activeSkillNames}
            onToggle={(skill) => {
              const active = activeSkillNames.includes(skill.name);
              setActiveSkillNames((names) =>
                active
                  ? names.filter((name) => name !== skill.name)
                  : [...names, skill.name],
              );
              append(
                active
                  ? `◈ Скилл /${skill.name} отключён.`
                  : `◈ Скилл /${skill.name} задействован: его инструкции добавятся к следующим запросам.`,
                "info",
              );
            }}
            onClose={() => setSkillsOpen(false)}
          />
        </Box>
      </Box>
    );
  const footer = request ? (
    <Approval request={request} columns={columns} />
  ) : (
    <Editor
      value={editor.value}
      cursor={editor.cursor}
      busy={busy}
      model={runtime.model}
      suggestionRows={suggestionRows}
      selectedRow={selectedVisibleIndex}
      columns={columns}
    />
  );
  const footerRows = estimateFooterHeight({
    request,
    busy,
    editorValue: editor.value,
    columns: columns,
    suggestionsCount: suggestionRows.length,
    suggestionLines: suggestionRows,
    model: runtime.model,
  });
  const transcriptLines = streaming ? [...transcript, streaming] : transcript;
  transcriptLengthRef.current = transcriptLines.length;
  const clampedTranscriptOffset = Math.min(
    transcriptOffset,
    maxTranscriptOffset(transcriptLines),
  );
  const visible = visibleTranscriptWindow(
    transcriptLines,
    rows,
    columns,
    footerRows,
    clampedTranscriptOffset,
    TUI_HEADER_ROWS,
  );

  return (
    <Box flexDirection="column" height={rows} width={columns} overflow="hidden">
      <Header
        providerLabel={runtime.providerLabel}
        model={runtime.model}
        columns={columns}
        version={props.version}
      />
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        width="100%"
      >
        {visible.hiddenAboveCount > 0 ? (
          <Box width="100%" flexShrink={0}>
            <Text dimColor wrap="truncate">
              … ↑ ещё {visible.hiddenAboveCount} записей выше
            </Text>
          </Box>
        ) : null}
        {visible.lines.map((line) => (
          <TranscriptLineView key={line.id} line={line} columns={columns} />
        ))}
        {visible.lines.length === 0 &&
        visible.hiddenAboveCount === 0 &&
        visible.hiddenBelowCount === 0 ? (
          <Box flexDirection="column" width="100%" flexShrink={0}>
            <Text dimColor wrap="wrap">
              <Text bold color="green">
                ❯{" "}
              </Text>
              Введите задачу и нажмите Enter
            </Text>
            <Text dimColor wrap="wrap">
              {"  "}/help — команды · /status — состояние · /sessions — сеансы
            </Text>
          </Box>
        ) : null}
        {visible.hiddenBelowCount > 0 ? (
          <Box width="100%" flexShrink={0}>
            <Text dimColor wrap="truncate">
              … ↓ ещё {visible.hiddenBelowCount} записей ниже
            </Text>
          </Box>
        ) : null}
      </Box>
      <Box flexDirection="column" flexShrink={0} width="100%">
        {footer}
      </Box>
    </Box>
  );
}

/**
 * Закреплённая шапка: ровно две строки (заголовок + разделитель) при любой
 * ширине окна. Первая строка — единый инлайн-Text с truncate-end, поэтому
 * длинный сервис/модель обрезаются в одну строку и никогда не раздувают
 * шапку до трёх строк и не сдвигают смету истории (TUI_HEADER_ROWS).
 */
function Header({
  providerLabel,
  model,
  columns,
  version,
}: {
  providerLabel: string;
  model: string;
  columns: number;
  version?: string;
}): React.JSX.Element {
  const safeColumns = normalizeViewport({ columns }).columns;
  return (
    <Box flexDirection="column" flexShrink={0} width="100%" height={2}>
      <Box width="100%" height={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text bold color="cyan">
            ◈ ChiselCode
          </Text>
          {version ? <Text dimColor> v{version}</Text> : null}
          <Text dimColor> · </Text>
          <Text color="magenta">{providerLabel}</Text>
          <Text dimColor> · </Text>
          <Text color="yellow">{model}</Text>
        </Text>
      </Box>
      <Box width="100%" height={1} overflow="hidden">
        <Text dimColor wrap="truncate">
          {fullWidthSeparator(safeColumns)}
        </Text>
      </Box>
    </Box>
  );
}
function TranscriptLineView({
  line,
  columns,
}: {
  line: TuiTranscriptLine;
  columns: number;
}): React.JSX.Element {
  const tone = line.tone ?? "assistant";
  if (tone === "brand") {
    const [provider, ...modelParts] = line.text.split(" · ");
    return (
      <Box flexDirection="column" marginBottom={1} width="100%" flexShrink={0}>
        <Box width="100%">
          <Text bold color="cyan">
            ◈ ChiselCode
          </Text>
          <Text dimColor> · </Text>
          <Text color="magenta" wrap="truncate-end">
            {provider ?? ""}
          </Text>
          <Text dimColor> · </Text>
          <Text color="yellow" wrap="truncate-end">
            {modelParts.join(" · ")}
          </Text>
        </Box>
        <Text dimColor wrap="truncate">
          {fullWidthSeparator(columns)}
        </Text>
      </Box>
    );
  }
  if (tone === "user") {
    // Одна Text-нода во всю ширину: при ресайзе Ink сам переоборачивает
    // строку и ввод/история не «съезжают» по горизонтали.
    // flexShrink={0}: Yoga никогда не схлопывает строки истории в ноль
    // при неточной смете — переполнение режется снизу, а не в середине.
    const clean = line.text.replace(/^[❯›]\s?/, "");
    return (
      <Box marginTop={1} width="100%" flexShrink={0}>
        <Text bold wrap="wrap">
          <Text bold color="green">
            ❯{" "}
          </Text>
          {clean}
        </Text>
      </Box>
    );
  }
  if (tone === "tool") {
    const summary = line.text.replace(/^\[chisel\]\s?/, "");
    const preview =
      summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
    const tone_ = toolToneFromSummary(summary);
    return (
      <Box width="100%" flexShrink={0}>
        <Text dimColor wrap="wrap">
          <Text color={tone_}>⟡ </Text>
          {preview}
        </Text>
      </Box>
    );
  }
  if (tone === "success")
    return (
      <Box width="100%" flexShrink={0}>
        <Text color="green" wrap="wrap">
          {line.text}
        </Text>
      </Box>
    );
  if (tone === "error")
    return (
      <Box width="100%" flexShrink={0}>
        <Text color="red" wrap="wrap">
          ✗ {line.text}
        </Text>
      </Box>
    );
  if (tone === "warn")
    return (
      <Box width="100%" flexShrink={0}>
        <Text color="yellow" wrap="wrap">
          ⚠ {line.text}
        </Text>
      </Box>
    );
  if (tone === "info")
    return (
      <Box width="100%" flexShrink={0}>
        <Text wrap="wrap">{line.text}</Text>
      </Box>
    );
  return (
    <Box marginTop={1} width="100%" flexShrink={0}>
      <MarkdownText text={line.text} columns={columns} />
    </Box>
  );
}
/** Цвет искры тул-линии по первому слову сводки (там имя инструмента). */
function toolToneFromSummary(summary: string): ToolTone {
  const first = summary.split(/\s/, 1)[0] ?? "";
  return toolTone(first);
}
function providerName(provider: ProviderKind): string {
  if (provider === "anthropic") return "Anthropic (Claude)";
  if (provider === "anthropic-compatible") return "Anthropic-совместимый API";
  if (provider === "openai") return "OpenAI";
  if (provider === "agentrouter") return "AgentRouter";
  return "OpenAI-совместимый API";
}

function approvalPreview(request: ApprovalRequest): string {
  const previewLines = request.preview.split("\n");
  return previewLines.length > 12
    ? `${previewLines.slice(0, 12).join("\n")}\n… (полный текст в скроллбэке не показан)`
    : request.preview;
}

function estimateApprovalHeight(
  request: ApprovalRequest,
  columns: number,
): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  const width = Math.max(safeColumns - 4, 10);
  const meta = toolDisplay(request.tool);
  const header = `? [${meta.icon}] ${meta.label} — нужно подтверждение`;
  const controls = "[y] разрешить · [n] отклонить (Esc — тоже отклонить)";
  // marginTop (1) + рамка (2) + вертикальные отступы preview (2) +
  // заголовок, preview и controls с переносом по внутренней ширине.
  return (
    5 +
    wrappedLines(header, width) +
    wrappedLines(approvalPreview(request), width) +
    wrappedLines(controls, width)
  );
}

export interface FooterHeightInput {
  request?: ApprovalRequest;
  busy: boolean;
  editorValue?: string;
  columns?: number;
  suggestionsCount: number;
  /** Точные строки подсказок (для переноса на узких окнах). */
  suggestionLines?: string[];
  /** Модель для строки спиннера «Думаю…». */
  model?: string;
}

/** Высота нижней панели с учётом подсказок и многострочного черновика. */
export function estimateFooterHeight({
  request,
  busy,
  editorValue = "",
  columns = 80,
  suggestionsCount,
  suggestionLines,
  model = "",
}: FooterHeightInput): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  if (request) return estimateApprovalHeight(request, safeColumns);
  const innerWidth = Math.max(safeColumns - 4, 10);
  // Ввод живёт внутри рамки (2) + paddingX (2) + префикс «❯ » (2).
  // Спиннер: рамка + paddingX, текст «⠋ Думаю 99с · модель» с запасом под секундомер.
  const editorRows = busy
    ? wrappedLines(`⠋ Думаю 99с · ${model}`, innerWidth)
    : wrappedLines(editorValue || " ", Math.max(safeColumns - 6, 10));
  const lines =
    suggestionLines ??
    Array.from({ length: Math.max(suggestionsCount, 0) }, () => " ");
  const suggestionsRows =
    !busy && lines.length > 0
      ? 3 + lines.reduce((sum, l) => sum + wrappedLines(l, innerWidth), 0)
      : 0;
  // Верхний отступ (1) + рамка редактора (2) + строка горячих клавиш.
  return (
    editorRows + 3 + wrappedLines(HOTKEYS_HINT, safeColumns) + suggestionsRows
  );
}

export interface VisibleTranscriptTail {
  lines: TuiTranscriptLine[];
  hiddenCount: number;
}

export interface VisibleTranscriptWindow {
  lines: TuiTranscriptLine[];
  hiddenAboveCount: number;
  hiddenBelowCount: number;
}

export function maxTranscriptOffset(lines: TuiTranscriptLine[]): number {
  return Math.max(lines.length - 1, 0);
}

function selectTranscriptStart(
  lines: TuiTranscriptLine[],
  end: number,
  columns: number,
  budget: number,
): number {
  let used = 0;
  let start = end;
  for (let i = end - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) break;
    const height = estimateLineHeight(line, columns);
    // Даже одна высокая запись остаётся доступной в очень маленьком окне.
    if (used + height > budget && start < end) break;
    used += height;
    start = i;
    if (used >= budget) break;
  }
  return start;
}

/** Выбирает доступное окно истории над закреплённой нижней панелью. */
export function visibleTranscriptWindow(
  lines: TuiTranscriptLine[],
  rows: number,
  columns: number,
  footerRows: number,
  offset = 0,
  topRows = 0,
): VisibleTranscriptWindow {
  const safeRows = Math.max(Math.floor(rows) || TUI_FALLBACK_ROWS, 1);
  const safeColumns = normalizeViewport({ columns }).columns;
  const contentRows = Math.max(safeRows - footerRows - topRows, 0);
  const safeOffset = Math.max(0, Math.min(offset, maxTranscriptOffset(lines)));
  const end = lines.length - safeOffset;
  const belowRows = safeOffset > 0 ? 1 : 0;
  let start = selectTranscriptStart(
    lines,
    end,
    safeColumns,
    Math.max(contentRows - belowRows, 0),
  );
  // Верхний индикатор, как и нижний, занимает строку внутри viewport.
  if (start > 0) {
    start = selectTranscriptStart(
      lines,
      end,
      safeColumns,
      Math.max(contentRows - belowRows - 1, 0),
    );
  }
  return {
    lines: lines.slice(start, end),
    hiddenAboveCount: start,
    hiddenBelowCount: lines.length - end,
  };
}

/** Совместимый помощник: показывает самый новый хвост истории. */
export function visibleTranscriptTail(
  lines: TuiTranscriptLine[],
  rows: number,
  columns: number,
  footerRows: number,
  topRows = 0,
): VisibleTranscriptTail {
  const visible = visibleTranscriptWindow(
    lines,
    rows,
    columns,
    footerRows,
    0,
    topRows,
  );
  return { lines: visible.lines, hiddenCount: visible.hiddenAboveCount };
}

/**
 * Число строк текста с учётом переноса.
 * Второй аргумент — уже доступная ширина (usable width), а не ширина окна.
 * Вызывающий вычитает рамки/отступы/префиксы сам — так оценка совпадает
 * с реальным рендером Ink при любом размере окна.
 */
export function wrappedLines(text: string, usableWidth: number): number {
  const width = Math.max(Math.floor(usableWidth) || 10, 10);
  return text
    .split("\n")
    .reduce(
      (total, line) => total + Math.max(1, Math.ceil(line.length / width)),
      0,
    );
}

/** Оценка высоты строки истории в строках терминала. */
function estimateLineHeight(line: TuiTranscriptLine, columns: number): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  const tone = line.tone ?? "assistant";
  if (tone === "brand") return 3; // две строки + отступ
  if (tone === "user")
    return 1 + wrappedLines(line.text, Math.max(safeColumns - 2, 10)); // отступ + «❯ »
  if (tone === "tool") {
    const summary =
      line.text.length > 200 ? `${line.text.slice(0, 200)}…` : line.text;
    return wrappedLines(summary, Math.max(safeColumns - 2, 10)); // префикс «⟡ »
  }
  // Префиксы «✗ »/«⚠ » занимают клетки первой строки — считаем вместе с текстом,
  // иначе смета занижена и Yoga схлопывает соседние строки истории.
  if (tone === "error") return wrappedLines(`✗ ${line.text}`, safeColumns);
  if (tone === "warn") return wrappedLines(`⚠ ${line.text}`, safeColumns);
  if (tone === "success") return wrappedLines(line.text, safeColumns);
  if (tone === "info") return wrappedLines(line.text, safeColumns);
  // assistant: markdown-раскладка + верхний отступ
  return 1 + estimateMarkdownHeight(line.text, safeColumns);
}

/** Оценка высоты markdown-ответа (заголовки, списки, код в рамках и т.д.). */
function estimateMarkdownHeight(text: string, columns: number): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  const quoteWidth = Math.max(safeColumns - 2, 10);
  const codeWidth = Math.max(safeColumns - 4, 10);
  return parseBlocks(text).reduce((total, block) => {
    if (block.kind === "hr") return total + 1;
    if (block.kind === "heading")
      return total + wrappedLines(block.text, safeColumns);
    if (block.kind === "paragraph")
      return total + wrappedLines(block.text, safeColumns);
    if (block.kind === "quote")
      return (
        total +
        block.text
          .split("\n")
          .reduce(
            (sum, l) => sum + Math.max(1, Math.ceil(l.length / quoteWidth)),
            0,
          )
      );
    if (block.kind === "list")
      return (
        total +
        block.items.reduce(
          (sum, item) =>
            sum + Math.max(1, Math.ceil((item.length + 2) / safeColumns)),
          0,
        )
      );
    // код: рамки (2) + marginY (2) + возможный язык (1) + строки с переносом
    const codeRows = block.code
      .split("\n")
      .reduce(
        (sum, l) => sum + Math.max(1, Math.ceil(l.length / codeWidth)),
        0,
      );
    return total + codeRows + 4 + (block.language ? 1 : 0);
  }, 0);
}
function Approval({
  request,
  columns,
}: {
  request: ApprovalRequest;
  columns: number;
}): React.JSX.Element {
  const meta = toolDisplay(request.tool);
  const preview = approvalPreview(request);
  void columns;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
      width="100%"
      flexShrink={0}
    >
      <Text bold color="yellow" wrap="wrap">
        ? [{meta.icon}] {meta.label} — нужно подтверждение
      </Text>
      <Box marginY={1} width="100%">
        <Text wrap="wrap">{preview}</Text>
      </Box>
      <Text wrap="wrap">
        [
        <Text bold color="green">
          y
        </Text>
        ] разрешить · [
        <Text bold color="red">
          n
        </Text>
        ] отклонить <Text dimColor>(Esc — тоже отклонить)</Text>
      </Text>
    </Box>
  );
}
function Editor({
  value,
  cursor,
  busy,
  model,
  suggestionRows,
  selectedRow,
  columns,
}: {
  value: string;
  cursor: number;
  busy: boolean;
  model: string;
  /** Готовые строки подсказок (подсвеченная уже с префиксом, остальные — имена). */
  suggestionRows: string[];
  /** Индекс подсвеченной строки в suggestionRows. */
  selectedRow: number;
  columns: number;
}): React.JSX.Element {
  void columns;
  return (
    <Box flexDirection="column" marginTop={1} width="100%" flexShrink={0}>
      {suggestionRows.length && !busy ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
          width="100%"
          flexShrink={0}
        >
          {suggestionRows.map((row, index) => (
            <Text key={row} wrap="truncate-end">
              {index === selectedRow ? (
                <Text bold inverse color="green">
                  {row}
                </Text>
              ) : (
                <Text dimColor>{row}</Text>
              )}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box
        borderStyle="round"
        borderColor={busy ? "yellow" : "cyan"}
        paddingX={1}
        width="100%"
        flexShrink={0}
      >
        {busy ? (
          <Thinking model={model} />
        ) : value ? (
          <Box width="100%">
            <Text wrap="wrap">
              <Text bold color="green">
                ❯{" "}
              </Text>
              {renderWithCursor(value, cursor)}
            </Text>
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">
            <Text bold color="green">
              ❯{" "}
            </Text>
            Спросите что-нибудь… ( / — команды )
          </Text>
        )}
      </Box>
      <Text dimColor wrap="wrap">
        {HOTKEYS_HINT}
      </Text>
    </Box>
  );
}

/** Текст ввода с видимым курсором (инверсия символа под курсором). */
function renderWithCursor(value: string, cursor: number): React.ReactNode {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, safeCursor);
  const at = value[safeCursor];
  const after = value.slice(safeCursor + 1);
  return (
    <>
      <Text>{before}</Text>
      {at === undefined ? (
        <Text color="green">█</Text>
      ) : (
        <Text inverse>{at}</Text>
      )}
      <Text>{after}</Text>
    </>
  );
}
function intro(
  _providerLabel: string,
  _model: string,
  _version?: string,
): TuiTranscriptLine[] {
  // Стартовый транскрипт пустой: сервис/модель уже в закреплённой шапке,
  // подсказки — в /help и в строке горячих клавиш. Ничего не пишем при запуске.
  return [];
}
