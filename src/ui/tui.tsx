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
import { LOGO_TERM_ROWS, LOGO_WIDTH, renderLogoRows } from "./logo.js";
import { MarkdownText, parseBlocks, plainInlineText } from "./markdown.js";
import {
  SHIFT_SCROLL_ROWS,
  subscribeWheel,
  WHEEL_BATCH_MS,
  type WheelDirection,
  wheelScrollRows,
} from "./mouse.js";
import {
  type ModelListResult,
  SettingsPanel,
  type TuiSettingsValues,
} from "./settings.js";
import { SetupApp, type SetupValues } from "./setup.js";
import { SkillsPanel } from "./skills.js";
import {
  ASSISTANT_GUTTER,
  type ToolTone,
  toolDisplay,
  toolTone,
  USER_BUBBLE_BG,
} from "./theme.js";
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
/** Высота слим-шапки: строка заголовка + разделитель. */
export const TUI_HEADER_ROWS = 2;
/**
 * Высота арт-шапки: пиксельный логотип + дим-строка мета + разделитель.
 * Логотип монохромный (half-блоки), без анимации — кадр не перерисовывается.
 */
export const ART_HEADER_ROWS = LOGO_TERM_ROWS + 2;
/**
 * Минимальная высота окна для арт-шапки: ниже — слим-вариант, чтобы
 * контенту и футеру оставалось место (арт 6 + футер ~5 + контент).
 */
export const ART_MIN_ROWS = 16;

/**
 * Показывать ли пиксельный логотип в шапке (как multi-size логотипы
 * у Gemini CLI: big на широких, слим-строка на узких/низких).
 * Чистая функция для тестов и сметы layout.
 */
export function shouldUseArtHeader(columns: number, rows: number): boolean {
  const width = Math.floor(columns);
  const height = Math.floor(rows);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return width >= LOGO_WIDTH && height >= ART_MIN_ROWS;
}
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
 * Стильная статичная шапка как у топовых CLI (OpenCode/Codex/Claude Code):
 * монохром, без анимации и разноцветности.
 * - Первая строка: бренд жирным (адаптивный foreground терминала),
 *   модель — обычным начертанием, всё вторичное (путь, версия) — dim.
 * - Вторая строка: тонкий статичный разделитель во всю ширину окна.
 * Никаких useAnimation-тиков: шапка не перерисовывает полноэкранный кадр
 * на Windows/conhost и не мерцает. Высота строго 2 строки (TUI_HEADER_ROWS).
 */
export interface HeaderTitleInput {
  model: string;
  cwd?: string;
  version?: string;
}

/**
 * Плоский текст шапки одной строкой (без ANSI, для тестов и снепшотов).
 * Формат: `</> ChiselCode · <model> · <~/cwd> · v<version>`.
 * Пустые части пропускаются, ничего не раздувается.
 */
/**
 * Дим-строка мета под логотипом арт-шапки: `model · ~/cwd · vX`.
 * Пустые части пропускаются, ничего не раздувается.
 */
export function formatHeaderMeta(input: HeaderTitleInput): string {
  const parts: string[] = [];
  const model = input.model.trim();
  if (model) parts.push(model);
  const cwd = input.cwd?.trim();
  if (cwd) parts.push(shortenHome(cwd));
  if (input.version?.trim()) parts.push(`v${input.version.trim()}`);
  return parts.join(" · ");
}

export function formatHeaderTitle(input: HeaderTitleInput): string {
  const meta = formatHeaderMeta(input);
  return meta ? `</> ChiselCode · ${meta}` : "</> ChiselCode";
}

/** Статичный разделитель шапки во всю ширину окна (монохром, без импульса). */
export function headerSeparator(columns: number): string {
  return fullWidthSeparator(columns);
}

/**
 * Подсказка горячих клавиш под полем ввода. Держим в одну строку на 80
 * колонках, чтобы высота футера была предсказуема при любом размере окна.
 * Tab/стрелки — выбор команды как в Claude Code, Enter — выбрать/отправить.
 */
export const HOTKEYS_HINT =
  "Tab/↑/↓ — команда · Enter — отправить · Esc — закрыть · колесо — журнал";

/** Та же строка, когда журнал прокручен вверх: Esc ведёт вниз, а не закрывает. */
export const HOTKEYS_HINT_SCROLLED =
  "Tab/↑/↓ — команда · Enter — отправить · Esc — вниз · колесо — журнал";

/** Подсказка горячих клавиш: при прокрученном журнале Esc — это «назад вниз». */
export function hotkeysHint(scrolledUp: boolean): string {
  return scrolledUp ? HOTKEYS_HINT_SCROLLED : HOTKEYS_HINT;
}

/**
 * Подсказка с жирными клавишами как в Codex (ключи — bold, описания — dim).
 * Тот же текст, что hotkeysHint(), вложенные Text идут инлайном как везде
 * в журнале — перенос совпадает со сметой hotkeyHintRows.
 */
export function HotkeysHint({
  scrolledUp = false,
}: {
  scrolledUp?: boolean;
}): React.JSX.Element {
  const parts = hotkeysHint(scrolledUp).split(" · ");
  return (
    <Text dimColor wrap="wrap">
      {parts.map((part, index) => {
        const dash = part.indexOf(" — ");
        const key = dash === -1 ? part : part.slice(0, dash);
        const desc = dash === -1 ? "" : part.slice(dash);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: список фиксированный
          <Text key={index} dimColor>
            {index > 0 ? " · " : ""}
            <Text bold>{key}</Text>
            {desc}
          </Text>
        );
      })}
    </Text>
  );
}

/** Шаг Shift+↑/↓ и доля колеса для скролла — из mouse.ts, в одних руках. */
export { SHIFT_SCROLL_ROWS, WHEEL_BATCH_MS, wheelScrollRows } from "./mouse.js";

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
  /**
   * Есть ли файл установщика уже в релизе. Релиз создаётся пустым,
   * установщики доливаются минутами позже — без проверки качали бы 404.
   * Необязателен: без него проверка пропускается.
   */
  onCheckAssetUpdate?(plan: { url: string; asset: string }): Promise<boolean>;
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
  /**
   * Высота шапки responsive (как multi-size логотипы у Gemini CLI):
   * пиксельный арт на широких и высоких окнах, слим-строка иначе.
   * Смета истории/футера ниже считается от той же высоты, что рисует
   * Header, поэтому рассинхрона нет на любом размере окна.
   */
  const useArtHeader = shouldUseArtHeader(columns, rows);
  const headerRows = useArtHeader ? ART_HEADER_ROWS : TUI_HEADER_ROWS;
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
  // Живые габариты скролла для подписки колеса: эффект ниже подписан один
  // раз, а актуальные columns/contentRows/max читает из рефа при событии.
  const scrollDimsRef = useRef({ columns: 80, contentRows: 0, maxScroll: 0 });
  // Батчинг колеса: один физический флик шлёт десяток SGR-событий, и каждое
  // без батчинга — отдельная полноэкранная перерисовка (на Windows с полной
  // очисткой: мерцание и «тупняк»). Копим дельту и сбрасываем одним setState.
  const wheelAccumRef = useRef(0);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const wheelLastDirRef = useRef<WheelDirection | null>(null);
  useEffect(() => {
    // Колесо мыши: события уже вычищены из stdin фильтром (mouse.ts) до Ink,
    // сюда приходит только направление. Таймер и подписка чистятся здесь же.
    const flush = (): void => {
      wheelTimerRef.current = undefined;
      const delta = wheelAccumRef.current;
      wheelAccumRef.current = 0;
      wheelLastDirRef.current = null;
      if (delta === 0) return;
      const max = scrollDimsRef.current.maxScroll;
      setTranscriptOffset((offset) =>
        Math.max(0, Math.min(offset + delta, max)),
      );
    };
    const arm = (): void => {
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = setTimeout(flush, WHEEL_BATCH_MS);
    };
    const unsubscribe = subscribeWheel((direction) => {
      const { contentRows, maxScroll } = scrollDimsRef.current;
      const step = wheelScrollRows(contentRows);
      const signed = direction === "up" ? step : -step;
      // Смена направления — сначала отдать накопленное: иначе разворот
      // флика чувствуется с задержкой.
      if (wheelLastDirRef.current && wheelLastDirRef.current !== direction) {
        if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
        wheelTimerRef.current = undefined;
        const pending = wheelAccumRef.current;
        wheelAccumRef.current = 0;
        wheelLastDirRef.current = null;
        if (pending !== 0)
          setTranscriptOffset((offset) =>
            Math.max(0, Math.min(offset + pending, maxScroll)),
          );
      }
      wheelLastDirRef.current = direction;
      // Один сброс — не дальше экрана: огромный флик не швыряет в начало.
      const cap = Math.max(contentRows, 1);
      wheelAccumRef.current = Math.max(
        -cap,
        Math.min(cap, wheelAccumRef.current + signed),
      );
      arm();
    });
    return () => {
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = undefined;
      unsubscribe();
    };
  }, []);
  const pushLine = useCallback(
    (text: string, tone: TranscriptTone = "assistant"): void => {
      const flushed = streamingRef.current;
      streamingRef.current = null;
      setStreaming(null);
      const id = nextTranscriptId.current++;
      const added: TuiTranscriptLine[] = [
        ...(flushed ? [flushed] : []),
        { id, text, tone },
      ];
      // Sticky-bottom: читающего историю вверх не дёргаем вниз — окно стоит
      // на месте (offset растёт на высоту новых строк), прибитый ко дну
      // остаётся прибитым. Раньше любой append делал setTranscriptOffset(0),
      // а appendToLast дёргал на каждый токен стриминга.
      const dims = scrollDimsRef.current;
      const addedRows = added.reduce(
        (sum, line) => sum + expandLineRows(line, dims.columns).length,
        0,
      );
      setTranscriptOffset((offset) =>
        offset === 0
          ? 0
          : Math.min(offset + addedRows, dims.maxScroll + addedRows),
      );
      setTranscript((lines) => [...lines, ...added]);
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
    // Без сброса прокрутки: чанки идут на каждый токен, сброс швырял бы
    // читающего вниз десятки раз за ответ. Коммит — в pushLine/wasBusy.
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
        // Тот же sticky-bottom, что в pushLine: ушедшего вверх не дёргаем.
        const dims = scrollDimsRef.current;
        const addedRows = expandLineRows(flushed, dims.columns).length;
        setTranscriptOffset((offset) =>
          offset === 0
            ? 0
            : Math.min(offset + addedRows, dims.maxScroll + addedRows),
        );
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
  const selfUpdateRunning = useRef(false);
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
    // Повторный /update во время активного — вежливый отказ вместо второго
    // флоу: резолвер подтверждений один на всех, двойной запрос вешает первый.
    if (selfUpdateRunning.current) {
      append("Обновление уже выполняется, дождитесь завершения.", "warn");
      return;
    }
    selfUpdateRunning.current = true;
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
      // Релиз выходит пустым: установщик для платформы может ещё собираться.
      // Проверяем наличие файла, иначе ловили бы голый 404.
      if (props.onCheckAssetUpdate) {
        let assetReady = true;
        try {
          assetReady = await props.onCheckAssetUpdate(plan);
        } catch {
          assetReady = true;
        }
        if (!assetReady) {
          append(
            [
              `⚠ Файл ${plan.asset} пока не опубликован в релизе v${version} — установщики собираются несколько минут после выхода версии.`,
              "Попробуйте чуть позже или скачайте вручную:",
              `${plan.latestUrl ?? "https://github.com/TheAsrada/ChiselCode/releases"}`,
            ].join("\n"),
            "warn",
          );
          return;
        }
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
      // Даём кадру отрисоваться: иначе exit() в том же тике стирает
      // alternate screen, и кажется, что приложение «просто исчезло».
      await new Promise((resolve) => setTimeout(resolve, 800));
      exit();
    } catch (cause) {
      append(
        `Ошибка обновления: ${cause instanceof Error ? cause.message : String(cause)}`,
        "error",
      );
    } finally {
      selfUpdateRunning.current = false;
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
      // Принимаем и русскую раскладку: «н» — та же физическая клавиша, что y.
      const answer = character.toLowerCase();
      if (answer === "y" || answer === "н")
        props.approvalResolver.resolve("approved");
      if (answer === "n" || answer === "т" || key.escape)
        props.approvalResolver.resolve("denied");
      return;
    }
    if (settings || skillsOpen || restartingSetup) return;
    // Скролл журнала в СТРОКАХ терминала (как браузер): колесо — четверть
    // видимой высоты, Shift+↑/↓ — ровно строка, Home/End — края,
    // Esc — вернуться вниз к вводу. Ввод закреплён снизу.
    // Скролл и выход работают даже пока агент думает.
    if (key.escape && transcriptOffset > 0) {
      setTranscriptOffset(0);
      return;
    }
    if (key.shift && key.upArrow) {
      const max = scrollDimsRef.current.maxScroll;
      setTranscriptOffset((offset) =>
        Math.min(offset + SHIFT_SCROLL_ROWS, max),
      );
      return;
    }
    if (key.shift && key.downArrow) {
      setTranscriptOffset((offset) => Math.max(offset - SHIFT_SCROLL_ROWS, 0));
      return;
    }
    if (key.home) {
      setTranscriptOffset(scrollDimsRef.current.maxScroll);
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
    if (busy) return;
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
          model={runtime.model}
          columns={columns}
          version={props.version}
          cwd={projectCwd}
          art={useArtHeader}
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
          model={runtime.model}
          columns={columns}
          version={props.version}
          cwd={projectCwd}
          art={useArtHeader}
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
          model={runtime.model}
          columns={columns}
          version={props.version}
          cwd={projectCwd}
          art={useArtHeader}
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
  const transcriptLines = streaming ? [...transcript, streaming] : transcript;
  // Смета футера не зависит от скролла (хинт резервируется по худшему
  // варианту), поэтому контент/максимум считаются прямо здесь — до useInput
  // в коде ниже они не нужны: обработчики читают свежий scrollDimsRef.
  const footerProbeRows = estimateFooterHeight({
    request,
    busy,
    editorValue: editor.value,
    editorCursor: editor.cursor,
    columns: columns,
    suggestionsCount: suggestionRows.length,
    suggestionLines: suggestionRows,
    model: runtime.model,
    scrolledUp: false,
  });
  const probeContentRows = Math.max(rows - footerProbeRows - headerRows, 0);
  const probeMaxScroll = maxTranscriptScrollRows(
    transcriptLines,
    columns,
    probeContentRows,
  );
  scrollDimsRef.current = {
    columns,
    contentRows: probeContentRows,
    maxScroll: probeMaxScroll,
  };
  const clampedTranscriptOffset = Math.min(transcriptOffset, probeMaxScroll);
  // Журнал прокручен вверх: подсказка показывает «Esc — вниз».
  const scrolledUp = clampedTranscriptOffset > 0;
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
      scrolledUp={scrolledUp}
    />
  );
  const footerRows = footerProbeRows;
  const visible = visibleTranscriptWindow(
    transcriptLines,
    rows,
    columns,
    footerRows,
    clampedTranscriptOffset,
    headerRows,
  );

  return (
    <Box flexDirection="column" height={rows} width={columns} overflow="hidden">
      <Header
        model={runtime.model}
        columns={columns}
        version={props.version}
        cwd={projectCwd}
        art={useArtHeader}
      />
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        width="100%"
      >
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
            <Text dimColor wrap="wrap">
              {"  "}Shift+Enter — новая строка · Tab — подстановка команды ·
              колесо — журнал
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
 * Путь покороче для шапки: домашняя папка — как ~/…, как в Codex.
 * Чистая функция для тестов.
 */
export function shortenHome(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  const winHome = home.replace(/\//g, "\\");
  if (winHome && (path === winHome || path.startsWith(`${winHome}\\`))) {
    return `~${path.slice(winHome.length)}`;
  }
  return path;
}

/**
 * Закреплённая шапка: при любой ширине окна занимает ровно headerRows строк
 * (арт — ART_HEADER_ROWS, слим — TUI_HEADER_ROWS). Все строки — инлайн-Text
 * с truncate-end, поэтому длинная модель/путь обрезаются и никогда не раздувают
 * шапку и не сдвигают смету истории.
 * Стиль как у топовых CLI: статичный монохром без анимации и разноцветности.
 * - art: пиксельный логотип `</> ChiselCode` (half-блоки, 4 строки) +
 *   дим-строка `модель · ~/путь · vверсия` + тонкий dim-разделитель;
 * - слим: одна строка `</> ChiselCode · модель · ~/путь · vверсия`
 *   (бренд жирным, модель обычным, вторичное dim) + разделитель.
 */
function Header({
  model,
  columns,
  version,
  cwd,
  art,
}: {
  model: string;
  columns: number;
  version?: string;
  cwd?: string;
  art: boolean;
}): React.JSX.Element {
  const safeColumns = normalizeViewport({ columns }).columns;
  const shortCwd = cwd ? shortenHome(cwd) : undefined;
  const modelText = model.trim();
  const tailParts: string[] = [];
  if (shortCwd?.trim()) tailParts.push(shortCwd.trim());
  if (version?.trim()) tailParts.push(`v${version.trim()}`);
  const tailText = tailParts.join(" · ");
  const metaText = [modelText, tailText].filter(Boolean).join(" · ");
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width="100%"
      height={art ? ART_HEADER_ROWS : TUI_HEADER_ROWS}
    >
      {art ? (
        <Box flexDirection="column" width="100%" flexShrink={0}>
          {renderLogoRows().map((line) => (
            <Box key={line} width="100%" height={1} overflow="hidden">
              <Text wrap="truncate-end">{line}</Text>
            </Box>
          ))}
          <Box width="100%" height={1} overflow="hidden">
            <Text dimColor wrap="truncate-end">
              {metaText}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box width="100%" height={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text bold>{"</> ChiselCode"}</Text>
            {modelText ? (
              <>
                <Text dimColor> · </Text>
                <Text>{modelText}</Text>
              </>
            ) : null}
            {tailText ? <Text dimColor> · {tailText}</Text> : null}
          </Text>
        </Box>
      )}
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
    // Залитый блок как в Codex: префикс ❯ жирным зелёным, текст обычным.
    // paddingX сужает контент на 2 клетки — смета зеркалит
    // (expandLineRows считает user по safeColumns - 2).
    const clean = line.text.replace(/^[❯›]\s?/, "");
    return (
      <Box
        marginTop={1}
        paddingX={1}
        width="100%"
        flexShrink={0}
        backgroundColor={USER_BUBBLE_BG}
      >
        <Text wrap="wrap">
          <Text bold color="green">
            ❯{" "}
          </Text>
          {clean}
        </Text>
      </Box>
    );
  }
  if (tone === "tool") {
    // Gutter вызова: «◆ глагол детали» — глагол жирным в цвете операции,
    // детали dim. Тот же текст, что в смете, — перенос совпадает.
    const summary = line.text.replace(/^\[chisel\]\s?/, "");
    const preview =
      summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
    const tone_ = toolToneFromSummary(summary);
    const space = preview.search(/\s/);
    const verb = space === -1 ? preview : preview.slice(0, space);
    const rest = space === -1 ? "" : preview.slice(space);
    return (
      <Box width="100%" flexShrink={0}>
        <Text dimColor wrap="wrap">
          <Text color={tone_}>◆ </Text>
          <Text bold color={tone_}>
            {verb}
          </Text>
          {rest}
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
  if (tone === "error") {
    // cli.ts шлёт текст уже с «✗ » — срезаем, чтобы не двоилось «✗ ✗ ».
    const clean = line.text.replace(/^✗\s?/, "");
    return (
      <Box width="100%" flexShrink={0}>
        <Text color="red" wrap="wrap">
          ✗ {clean}
        </Text>
      </Box>
    );
  }
  if (tone === "warn") {
    // Аналогично: «⚠ …» из cli.ts не должен двоиться.
    const clean = line.text.replace(/^⚠\s?/, "");
    return (
      <Box width="100%" flexShrink={0}>
        <Text color="yellow" wrap="wrap">
          ⚠ {clean}
        </Text>
      </Box>
    );
  }
  if (tone === "info")
    return (
      <Box width="100%" flexShrink={0}>
        <Text wrap="wrap">{line.text}</Text>
      </Box>
    );
  // Ответ ассистента: левая акцентная черта как в OpenCode, markdown
  // внутри на клетку уже — смета зеркалит (expandLineRows считает
  // assistant по safeColumns - 1). flexShrink={0}: переполнение режется
  // снизу, Yoga не схлопывает строки истории в ноль.
  return (
    <Box marginTop={1} width="100%" flexShrink={0}>
      <Box
        width="100%"
        flexShrink={0}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        borderLeft
        borderColor={ASSISTANT_GUTTER}
      >
        <MarkdownText text={line.text} columns={columns} />
      </Box>
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
  // Перенос — по словам, как в рендере (wrapUnitRows), а не ceil(len/width).
  return (
    5 +
    wrapUnitRows(header, width).length +
    wrapUnitRows(approvalPreview(request), width).length +
    wrapUnitRows(controls, width).length
  );
}

export interface FooterHeightInput {
  request?: ApprovalRequest;
  busy: boolean;
  editorValue?: string;
  /** Позиция курсора: «█» в конце дописывает клетку (см. editorContentRows). */
  editorCursor?: number;
  columns?: number;
  suggestionsCount: number;
  /** Точные строки подсказок (для переноса на узких окнах). */
  suggestionLines?: string[];
  /** Модель для строки спиннера «Думаю…». */
  model?: string;
  /**
   * Журнал прокручен вверх: в подсказке Esc — это «назад вниз».
   * На высоту не влияет: хинт всегда резервируется по худшему варианту,
   * чтобы скролл не менял футер. Поле оставлено для совместимости.
   */
  scrolledUp?: boolean;
}

/** Высота нижней панели с учётом подсказок и многострочного черновика. */
export function estimateFooterHeight({
  request,
  busy,
  editorValue = "",
  editorCursor,
  columns = 80,
  suggestionsCount,
  suggestionLines,
  model = "",
  scrolledUp = false,
}: FooterHeightInput): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  if (request) return estimateApprovalHeight(request, safeColumns);
  // scrolledUp на высоту не влияет (хинт резервируется по худшему варианту).
  void scrolledUp;
  const innerWidth = Math.max(safeColumns - 4, 10);
  // Ввод живёт внутри рамки (2) + paddingX (2). Спиннер меряем верхней
  // оценкой секундомера («88м 88с»): занижение страшнее завышения —
  // занижение режет свежие строки, завышение лишь прячет одну строку.
  // Курсор «█» в конце дописывает клетку: на границе ширины это целая строка.
  const editorRows = busy
    ? wrapUnitRows(`${SPINNER_MEASURE_TEXT}${model}`, innerWidth).length
    : editorContentRows(
        editorValue,
        editorCursor ?? editorValue.length,
        innerWidth,
      );
  const lines =
    suggestionLines ??
    Array.from({ length: Math.max(suggestionsCount, 0) }, () => " ");
  // Подсказки — всегда truncate-end, т.е. ровно строка на пункт:
  // считать переносом через wrappedLines было завышением на узких окнах.
  const suggestionsRows = !busy && lines.length > 0 ? 3 + lines.length : 0;
  // Верхний отступ (1) + рамка редактора (2) + строка горячих клавиш.
  // Хинт резервируем по худшему из двух вариантов («закрыть»/«вниз»),
  // чтобы скролл не менял высоту футера и окно не мигало на границе.
  return editorRows + 3 + hotkeyHintRows(safeColumns) + suggestionsRows;
}

/** Строки подсказки горячих клавиш: максимум из обоих состояний скролла. */
export function hotkeyHintRows(columns: number): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  return Math.max(
    wrapUnitRows(HOTKEYS_HINT, safeColumns).length,
    wrapUnitRows(HOTKEYS_HINT_SCROLLED, safeColumns).length,
  );
}

/**
 * Высота текста ввода: первая логическая строка живёт с префиксом «❯ »
 * (2 клетки только первой визуальной строки), остальные — на всю ширину.
 * Пустой ввод — плейсхолдер в одну строку (truncate-end).
 */
export function editorContentRows(
  value: string,
  cursor: number,
  innerWidth: number,
): number {
  const width = Math.max(Math.floor(innerWidth) || 10, 10);
  if (!value) return 1;
  const safeCursor = Math.max(0, Math.min(Math.floor(cursor), value.length));
  // Курсор в конце — видимый «█»: дописываем клетку до переноса.
  const effective = safeCursor >= value.length ? `${value}█` : value;
  const logical = effective.split("\n");
  let rows = 0;
  logical.forEach((line, index) => {
    rows +=
      index === 0
        ? wrapPrefixedRows(line, "❯ ", width).length
        : wrapTextRows(line, width).length;
  });
  return Math.max(rows, 1);
}

/**
 * Текст спиннера «Думаю…» для сметы: верхняя оценка длины секундомера.
 * Реальный formatDuration растёт от «0.4с» до «Nм NNс» — меряем максимумом,
 * чтобы длинная работа не занизила футер и не отрезала свежие строки.
 */
export const SPINNER_MEASURE_TEXT = "◐ Думаю 88м 88с · ";

export interface VisibleTranscriptTail {
  lines: TuiTranscriptLine[];
  hiddenCount: number;
}

export interface VisibleTranscriptWindow {
  lines: TuiTranscriptLine[];
  /** Строк скрыто сверху (единица — строки терминала, а не записи). */
  hiddenAboveCount: number;
  /** Строк скрыто снизу — всегда равно offset после клампа. */
  hiddenBelowCount: number;
}

/** Суммарная высота журнала в строках терминала. */
export function totalTranscriptRows(
  lines: TuiTranscriptLine[],
  columns: number,
): number {
  const safeColumns = normalizeViewport({ columns }).columns;
  return lines.reduce(
    (sum, line) => sum + expandLineRows(line, safeColumns).length,
    0,
  );
}

/**
 * Сколько строк можно спрятать снизу: всё, что не влезает в контент.
 * Ноль — журнал влезает целиком, скроллить нечего.
 */
export function maxTranscriptScrollRows(
  lines: TuiTranscriptLine[],
  columns: number,
  contentRows: number,
): number {
  return Math.max(
    totalTranscriptRows(lines, columns) - Math.max(contentRows, 0),
    0,
  );
}

/**
 * Копия записи с обрезанным верхом/низом для границ окна. Показываем
 * срез [skipTop, skipTop + keepRows) визуальных строк. id сохраняется
 * (React не ремаунтит строку), а тон сбрасывается в info: срез рендерится
 * plain-переносом, и тогда его высота ТОЧНО равна длине среза — смета
 * снова не может разъехаться с рендером. Целая запись возвращается как есть.
 */
export function sliceTranscriptLine(
  line: TuiTranscriptLine,
  skipTopRows: number,
  keepRows: number,
  columns: number,
): TuiTranscriptLine | null {
  const rows = expandLineRows(line, columns);
  if (keepRows >= rows.length && skipTopRows <= 0) return line;
  if (keepRows <= 0) return null;
  const slice = rows.slice(
    Math.max(skipTopRows, 0),
    Math.max(skipTopRows, 0) + Math.max(keepRows, 0),
  );
  if (slice.length === 0) return null;
  return { ...line, text: slice.join("\n"), tone: "info" };
}

/**
 * Выбирает окно истории над закреплённой нижней панелью — в СТРОКАХ
 * терминала, как браузер, а не в записях. offset — сколько строк спрятано
 * снизу (0 — прибит ко дну). Граничные записи режутся сверху/снизу срезом
 * (sliceTranscriptLine), поэтому читается даже середина ответа выше экрана —
 * раньше высокие записи проскакивали целиком и их середина была невидима.
 */
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
  const heights = lines.map((line) => expandLineRows(line, safeColumns).length);
  const total = heights.reduce((sum, height) => sum + height, 0);
  const maxScroll = Math.max(total - contentRows, 0);
  const safeScroll = Math.max(0, Math.min(Math.floor(offset) || 0, maxScroll));
  // Окно — строки [total - safeScroll - contentRows, total - safeScroll).
  const windowEnd = total - safeScroll;
  const windowStart = Math.max(windowEnd - contentRows, 0);
  const visible: TuiTranscriptLine[] = [];
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const height = heights[index] ?? 0;
    if (!line || height <= 0) continue;
    const lineStart = cursor;
    const lineEnd = cursor + height;
    cursor = lineEnd;
    if (lineEnd <= windowStart || lineStart >= windowEnd) continue;
    const skipTop = Math.max(windowStart - lineStart, 0);
    const skipBottom = Math.max(lineEnd - windowEnd, 0);
    if (skipTop === 0 && skipBottom === 0) {
      visible.push(line);
      continue;
    }
    const cut = sliceTranscriptLine(
      line,
      skipTop,
      height - skipTop - skipBottom,
      safeColumns,
    );
    if (cut) visible.push(cut);
  }
  return {
    lines: visible,
    hiddenAboveCount: windowStart,
    hiddenBelowCount: safeScroll,
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
 * Ширина символа в клетках терминала: CJK/эмодзи — 2, остальное — 1.
 * Глифы интерфейса (◈ ◆ ❯ ● ─ █ ▌ • ✗ ⚠) — всегда 1: так их считают
 * и Ink (string-width), и conhost. Неизвестное — 1, а не 0.
 */
export function charCellWidth(char: string): 1 | 2 {
  const code = char.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x231a && code <= 0x231b) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97c) ||
    (code >= 0xac00 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Видимая ширина строки в клетках (суррогатные пары — один символ). */
export function textCellWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charCellWidth(char);
  return width;
}

/**
 * Жадный перенос слов как в Yoga/Ink: слова копятся в строку, пока влезают
 * вместе с пробелами, а слово длиннее строки рвётся по клеткам.
 * Первая визуальная строка может быть уже остальных (firstBudget) — туда
 * уходит инлайновый префикс («❯ », «◆ »), который занимает клетки только
 * в первой строке, а не в каждой.
 */
export function wrapRowsWithFirstBudget(
  text: string,
  firstBudget: number,
  width: number,
): string[] {
  const safeWidth = Math.max(Math.floor(width) || 10, 10);
  const safeFirst = Math.max(
    Math.min(Math.floor(firstBudget) || safeWidth, safeWidth),
    1,
  );
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  let budget = safeFirst;
  const push = (): void => {
    rows.push(current);
    current = "";
    currentWidth = 0;
    budget = safeWidth;
  };
  const feedChars = (word: string): void => {
    for (const char of word) {
      const charWidth = charCellWidth(char);
      if (currentWidth + charWidth > budget && current !== "") push();
      current += char;
      currentWidth += charWidth;
    }
  };
  for (const word of text.split(" ")) {
    const wordWidth = textCellWidth(word);
    if (current === "") {
      if (wordWidth <= budget) {
        current = word;
        currentWidth = wordWidth;
      } else feedChars(word);
      continue;
    }
    if (currentWidth + 1 + wordWidth <= budget) {
      current += ` ${word}`;
      currentWidth += 1 + wordWidth;
      continue;
    }
    push();
    if (wordWidth <= budget) {
      current = word;
      currentWidth = wordWidth;
    } else feedChars(word);
  }
  push();
  return rows;
}

/** Перенос одной логической строки (пустая — одна визуальная строка). */
export function wrapTextRows(text: string, width: number): string[] {
  const safeWidth = Math.max(Math.floor(width) || 10, 10);
  return wrapRowsWithFirstBudget(text, safeWidth, safeWidth);
}

/**
 * Перенос текста с инлайновым префиксом («❯ », «◆ », «▌ », «• »):
 * префикс занимает клетки только первой визуальной строки и входит
 * в неё буквально — продолжения идут на всю ширину. Строки получаются
 * ровно такими, как в рендере: срезы окна можно перерисовывать как есть.
 */
export function wrapPrefixedRows(
  text: string,
  prefix: string,
  width: number,
): string[] {
  const safeWidth = Math.max(Math.floor(width) || 10, 10);
  const rows = wrapRowsWithFirstBudget(
    text,
    safeWidth - textCellWidth(prefix),
    safeWidth,
  );
  const first = rows[0] ?? "";
  return [`${prefix}${first}`, ...rows.slice(1)];
}

/** Визуальные строки многострочного текста: каждая логическая — ≥1 строка. */
export function wrapUnitRows(text: string, width: number): string[] {
  const safeWidth = Math.max(Math.floor(width) || 10, 10);
  return text.split("\n").flatMap((line) => wrapTextRows(line, safeWidth));
}

/**
 * Число строк текста с учётом переноса — word-wrap по словам и клеткам,
 * как реально переносит Ink. Старая формула ceil(len/width) занижала на
 * текстах с пробелами (перенос по словам раньше) и на CJK/эмодзи (2 клетки).
 * Второй аргумент — уже доступная ширина (usable width).
 */
export function wrappedLines(text: string, usableWidth: number): number {
  const width = Math.max(Math.floor(usableWidth) || 10, 10);
  return wrapUnitRows(text, width).length;
}

/**
 * Развёртка markdown-ответа в визуальные строки — зеркало MarkdownText.
 * Считаем по видимому тексту (plainInlineText): разметка `**`, ссылки
 * `[t](url)`→`t (url)` — ровно то, что занимает клетки в рендере.
 */
export function expandMarkdownRows(text: string, columns: number): string[] {
  // Ширина приходит уже sane от вызывающего (view отдаёт контенту
  // columns минус gutter/border) — только floor, без min-20 клампа,
  // иначе узкие окна считались бы шире рендера.
  const safeColumns = Math.max(Math.floor(columns) || 10, 10);
  const codeWidth = Math.max(safeColumns - 4, 10);
  const rows: string[] = [];
  for (const block of parseBlocks(text)) {
    if (block.kind === "hr") {
      rows.push("─".repeat(safeColumns));
      continue;
    }
    if (block.kind === "heading" || block.kind === "paragraph") {
      rows.push(...wrapUnitRows(plainInlineText(block.text), safeColumns));
      continue;
    }
    if (block.kind === "quote") {
      // Префикс «▌ » уже в строке: продолжение без префикса считается
      // с полной шириной внутри wrapUnitRows построчно — но первая строка
      // несёт префикс, поэтому режем через wrapPrefixedRows построчно.
      for (const line of block.text.split("\n"))
        rows.push(
          ...wrapPrefixedRows(plainInlineText(line), "▌ ", safeColumns),
        );
      continue;
    }
    if (block.kind === "list") {
      block.items.forEach((item, itemIndex) => {
        const prefix = block.ordered ? `${itemIndex + 1}. ` : "• ";
        rows.push(
          ...wrapPrefixedRows(plainInlineText(item), prefix, safeColumns),
        );
      });
      continue;
    }
    // код: верхний отступ + рамка + язык + строки + рамка + нижний отступ
    // (borderStyle round 2 + marginY 2, внутренняя ширина columns - 4).
    rows.push("");
    rows.push(`╭${"─".repeat(Math.max(safeColumns - 2, 1))}╮`);
    if (block.language) rows.push(...wrapUnitRows(block.language, codeWidth));
    for (const line of block.code.split("\n"))
      rows.push(...wrapTextRows(line, codeWidth));
    rows.push(`╰${"─".repeat(Math.max(safeColumns - 2, 1))}╯`);
    rows.push("");
  }
  return rows;
}

/**
 * Разворачивает запись журнала в визуальные строки — ровно то, что рисует
 * TranscriptLineView, включая пустые строки отступов. Единственный источник
 * правды для сметы: estimateLineHeight — это длина развёртки, поэтому смета
 * не может разъехаться с рендером.
 * Зеркала рендера:
 * - префиксы «❯ »/«◆ »/«✗ »/«⚠ » — инлайн, занимают клетки только первой
 *   визуальной строки (wrapPrefixedRows), а не сужают каждую строку;
 * - cli.ts шлёт тексты уже с префиксами («❯ …», «✗ …», «⚠ …»,
 *   «[chisel] …») — view их срезает и ставит свои, развёртка делает то же;
 * - markdown — по видимому тексту без разметки (plainInlineText).
 */
export function expandLineRows(
  line: TuiTranscriptLine,
  columns: number,
): string[] {
  const safeColumns = normalizeViewport({ columns }).columns;
  const tone = line.tone ?? "assistant";
  if (tone === "brand") return [line.text, fullWidthSeparator(safeColumns), ""];
  if (tone === "user") {
    const clean = line.text.replace(/^[❯›]\s?/, "");
    // Залитый блок с paddingX=1: контент на 2 клетки уже окна.
    return [
      "",
      ...wrapPrefixedRows(clean, "❯ ", Math.max(safeColumns - 2, 10)),
    ];
  }
  if (tone === "tool") {
    const summary = line.text.replace(/^\[chisel\]\s?/, "");
    const preview =
      summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
    return wrapPrefixedRows(preview, "◆ ", safeColumns);
  }
  if (tone === "error") {
    const clean = line.text.replace(/^✗\s?/, "");
    return wrapPrefixedRows(clean, "✗ ", safeColumns);
  }
  if (tone === "warn") {
    const clean = line.text.replace(/^⚠\s?/, "");
    return wrapPrefixedRows(clean, "⚠ ", safeColumns);
  }
  if (tone === "success" || tone === "info")
    return wrapUnitRows(line.text, safeColumns);
  // assistant: левая черта забирает клетку + верхний отступ.
  return ["", ...expandMarkdownRows(line.text, Math.max(safeColumns - 1, 10))];
}

/** Высота записи журнала: длина её развёртки — всегда равна рендеру. */
export function estimateLineHeight(
  line: TuiTranscriptLine,
  columns: number,
): number {
  return expandLineRows(line, columns).length;
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
  scrolledUp = false,
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
  /** Журнал прокручен вверх: в подсказке Esc — это «назад вниз». */
  scrolledUp?: boolean;
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
      <HotkeysHint scrolledUp={scrolledUp} />
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
