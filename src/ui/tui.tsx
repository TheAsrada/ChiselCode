import {
  Box,
  type DOMElement,
  Static,
  Text,
  useApp,
  useBoxMetrics,
  useInput,
  usePaste,
  useWindowSize,
} from "ink";
import type React from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { DownloadedAsset, SelfUpdatePlan } from "../commands/update.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolver,
} from "../security/approval.js";
import type { SessionSummary } from "../sessions/project-store.js";
import {
  buildActiveSkillsPrompt,
  expandSkill,
  invocableSkills,
  loadSkills,
  type Skill,
} from "../skills/skills.js";
import type { FileDiff, ProviderKind, Session } from "../types/domain.js";
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
import { FileDiffView, fileDiffRows } from "./file-diff.js";
import { LOGO_WIDTH, renderLogoRows } from "./logo.js";
import {
  estimateMarkdownRows,
  MarkdownText,
  wrapTextRows,
} from "./markdown.js";
import { parseSGRMouse, resolveScrollSpeed } from "./mouse.js";
import { emptyScrollMetrics, moveScroll, ScrollViewport } from "./scroll.js";
import { SessionPicker } from "./session-picker.js";
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
  truncate,
  USER_BUBBLE_BG,
} from "./theme.js";
import { Thinking } from "./thinking.js";
import { replaySessionIntoTranscript } from "./tool-transcript.js";
import {
  copiedCharactersNotice,
  watchWindowsClipboard,
} from "./windows-clipboard.js";

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
  | "dim"
  | "logo";

export interface TuiTranscriptLine {
  id: number;
  text: string;
  tone?: TranscriptTone;
  header?: "title" | "meta";
  fileDiff?: FileDiff;
}
export interface TuiTranscript {
  append(line: string, tone?: TranscriptTone, fileDiff?: FileDiff): void;
  setToolActivity(text?: string): void;
  appendToLast(text: string): void;
  replace?(
    entries: Array<{
      text: string;
      tone?: TranscriptTone;
      fileDiff?: FileDiff;
    }>,
  ): void;
  clear(): void;
}

/**
 * The welcome block is the first transcript item. Fullscreen uses a measured
 * viewport with row-by-row scrolling and a bounded footer; classic mode uses
 * terminal scrollback. Scrolling up anchors a row until End resumes following.
 */
export const TUI_MIN_COLUMNS = 20;
export const TUI_MIN_ROWS = 10;
/**
 * Отложенный запрос: Enter во время работы агента не теряется,
 * а встаёт в очередь как в Claude Code и уходит следующим.
 */
export interface QueuedPrompt {
  prompt: string;
  display?: string;
}

/**
 * Сколько пустых строк добавить между историей и вводом, чтобы ввод
 * оказался на нижней кромке окна при коротком диалоге.
 * НЕ ИСПОЛЬЗУЕТСЯ в рендере classic-режима Claude Code: Static в Ink —
 * absolute и его высота через Yoga всегда ~0, поэтому filler печатал
 * 20+ пустых строк и уносил шапку в scrollback из вида.
 * Оставлена как чистая функция для совместимости тестов.
 */
export function computeFillRows(
  viewportRows: number,
  staticHeight: number,
  footerHeight: number,
): number {
  const rows = Math.max(
    Math.floor(viewportRows) || TUI_FALLBACK_ROWS,
    TUI_MIN_ROWS,
  );
  const content = Math.max(0, Math.floor(staticHeight) || 0);
  const footer = Math.max(0, Math.floor(footerHeight) || 0);
  return Math.max(0, rows - content - footer);
}

/**
 * Высота ВИДИМОГО окна в строках — только из живого сисколла getWindowSize().
 * `stdout.rows` на conhost равен высоте БУФЕРА (300–3000), а не окна:
 * filler по нему печатал сотни пустых строк и уносил стартовый блок
 * далеко вверх из вида. Без сисколла — undefined, filler выключается.
 */
export function liveWindowRows(): number | undefined {
  try {
    const stdout = process.stdout as unknown as {
      getWindowSize?: () => [number, number];
    };
    if (typeof stdout?.getWindowSize !== "function") return undefined;
    const size = stdout.getWindowSize();
    const rows = Math.floor(size?.[1]);
    if (!Number.isFinite(rows) || rows <= 0) return undefined;
    return rows;
  } catch {
    return undefined;
  }
}

/**
 * Fullscreen alt-screen: внутренний скролл ленты как у Claude Code.
 * `hideNewest` — сколько новейших логических строк скрыто от вида
 * (0 — следим за низом). Скролл вверх ставит follow на паузу:
 * конец среза зафиксирован, вид стоит на месте без счётчиков.
 * Чистые функции для тестов.
 */

/** Верхний предел строк в дереве: лента длиннее — рендерим хвост. */
export const ALT_SCREEN_MAX_RENDER_LINES = 300;

/** Кламп скрытия к длине ленты. */
export function clampHideNewest(hideNewest: number, total: number): number {
  const totalSafe = Math.max(0, Math.floor(total) || 0);
  const hide = Math.floor(hideNewest);
  if (!Number.isFinite(hide) || hide <= 0) return 0;
  return Math.min(hide, totalSafe);
}

/**
 * Высота кадра: на строку МЕНЬШЕ окна. На win32 Ink делает полный clear
 * терминала перед каждым кадром высотой >= высоты окна
 * (shouldClearTerminalForFrame: wasFullscreen || isFullscreen) — иначе
 * каждое нажатие клавиши мигало бы всем экраном. Кадр ниже окна идёт
 * дешёвым инкрементальным стиранием eraseLines, а запись в нижнюю правую
 * клетку (она скроллит буфер conhost, рассинхрон #969) не происходит вовсе.
 * Чистая функция для тестов.
 */
export function frameRows(viewportRows: number): number {
  const rows = Math.floor(viewportRows);
  const safe = Number.isFinite(rows) ? rows : TUI_FALLBACK_ROWS;
  return Math.max(TUI_MIN_ROWS - 1, safe - 1);
}

/**
 * Fullscreen is the default, including Windows shortcut/cmd launches without
 * WT_SESSION. Terminal-brand environment variables do not describe VT support.
 * Classic scrollback is an explicit opt-out only.
 */
export function shouldUseAltScreen(
  env: NodeJS.ProcessEnv,
  _platform: string = process.platform,
): boolean {
  return env.CHISEL_ALT_SCREEN !== "0" && env.CHISEL_NO_ALT_SCREEN !== "1";
}

/**
 * Шаг PgUp/PgDn — пол-экрана как у Claude (не целый).
 * Резерв 10 строк на футер с подсказками и вводом.
 */
export function scrollPageStep(viewportRows: number): number {
  const rows = Math.floor(viewportRows);
  const usable = (Number.isFinite(rows) ? rows : TUI_FALLBACK_ROWS) - 10;
  return Math.max(5, Math.floor(Math.max(10, usable) / 2));
}

/** Сдвиг скрытия с клампом (delta>0 — вверх, <0 — вниз). */
export function applyHideDelta(
  hideNewest: number,
  delta: number,
  total: number,
): number {
  return clampHideNewest(hideNewest + Math.floor(delta || 0), total);
}

/**
 * Сдвиг скрытия на N ВИЗУАЛЬНЫХ строк (плавный скролл вместо прыжков
 * целыми сообщениями: короткие строки мотаются по несколько штук,
 * длинный markdown — по одному). Квантование — до целых логических
 * строк: скрываем/открываем строки целиком, пока их оценка не покроет
 * запрошенные строки. Чистая функция для тестов.
 */
export function hideForVisual(
  lines: TuiTranscriptLine[],
  columns: number,
  hideNewest: number,
  deltaRows: number,
): number {
  const total = lines.length;
  let hide = clampHideNewest(hideNewest, total);
  const delta = Math.floor(deltaRows || 0);
  if (delta > 0) {
    // Вверх: прячем строки с конца видимой области, пока сумма оценок
    // не покроет запрошенные строки. Дальше верха (total) не уходим.
    let need = delta;
    let index = total - hide - 1;
    while (need > 0 && index >= 0) {
      const line = lines[index];
      need -= line ? estimateLineRows(line, columns) : 1;
      index -= 1;
      hide += 1;
    }
    return Math.min(hide, total);
  }
  if (delta < 0) {
    // Вниз: открываем строки сверху скрытой области (ближайшие к виду).
    let need = -delta;
    let index = total - hide;
    while (need > 0 && hide > 0) {
      const line = lines[index];
      need -= line ? estimateLineRows(line, columns) : 1;
      index += 1;
      hide -= 1;
    }
    return Math.max(0, hide);
  }
  return hide;
}

/**
 * Видимое окно ленты: срез `[0, total-hide)`.
 * `hiddenNew` — сколько новых строк скрыто от вида (вид стоит на месте).
 */
export function sliceTranscript<T>(
  lines: T[],
  hideNewest: number,
  cap: number = ALT_SCREEN_MAX_RENDER_LINES,
): { visible: T[]; hiddenNew: number } {
  const total = lines.length;
  const hide = clampHideNewest(hideNewest, total);
  const end = total - hide;
  const capSafe = Math.max(1, Math.floor(cap) || ALT_SCREEN_MAX_RENDER_LINES);
  const start = Math.max(0, end - capSafe);
  return { visible: lines.slice(start, end), hiddenNew: hide };
}

/** Ширина строки в клетках терминала (кириллица/эмодзи — по кодпоинтам). */
export function displayCellWidth(text: string): number {
  return [...text].length;
}

/**
 * Смета высоты логической строки ленты — зеркалит TranscriptLineView:
 * те же отступы (user/assistant marginTop), та же ширина (пузырь −2,
 * gutter ассистента −1), markdown считается по видимому тексту
 * (estimateMarkdownRows). Погрешность — только вверх: недокорм даёт
 * пару пустых строк, перекорм обрезал бы свежие снизу.
 */
export function estimateLineRows(
  line: Pick<TuiTranscriptLine, "text" | "tone" | "fileDiff">,
  columns: number,
): number {
  if (line.fileDiff) return fileDiffRows(line.fileDiff);
  const cols = Math.max(10, Math.floor(columns) || TUI_FALLBACK_COLUMNS);
  const tone = line.tone ?? "assistant";
  // Арт — ровно по строке, truncate-end, без отступов.
  if (tone === "logo") return 1;
  // Ответ ассистента: marginTop + markdown внутри gutter-рамки (−1).
  if (tone === "assistant")
    return 1 + estimateMarkdownRows(line.text, cols - 1);
  // Пузырь пользователя: marginTop + префикс ❯ + paddingX (−2).
  if (tone === "user") {
    const inner = Math.max(10, cols - 2);
    const clean = line.text.replace(/^[❯›]\s?/, "");
    let rows = 1;
    clean.split("\n").forEach((segment, index) => {
      rows += wrapTextRows(index === 0 ? `❯ ${segment}` : segment, inner);
    });
    return Math.max(1, rows);
  }
  // Плоские строки без отступов: сумма переносов по сегментам.
  let rows = 0;
  for (const segment of line.text.split("\n"))
    rows += wrapTextRows(segment, cols);
  return Math.max(1, rows);
}

/**
 * Окно ленты, влезающее в бюджет строк: хвост (`anchor "end"`, следим
 * за низом) или голова (`anchor "start"`, Home — верх). Возвращает срез
 * и сколько логических строк осталось за кадром сверху (`hiddenAbove`).
 * Хотя бы одна строка возвращается всегда, чтобы вид не пустел.
 */
export function fitWindow(
  lines: TuiTranscriptLine[],
  columns: number,
  budgetRows: number,
  anchor: "start" | "end" = "end",
): { visible: TuiTranscriptLine[]; hiddenAbove: number } {
  const budget = Math.max(1, Math.floor(budgetRows) || 1);
  if (lines.length === 0) return { visible: [], hiddenAbove: 0 };
  if (anchor === "start") {
    let used = 0;
    let end = 0;
    while (end < lines.length) {
      const line = lines[end];
      if (!line) break;
      const est = estimateLineRows(line, columns);
      if (used + est > budget) break;
      used += est;
      end += 1;
    }
    if (end === 0) end = 1;
    return { visible: lines.slice(0, end), hiddenAbove: 0 };
  }
  let used = 0;
  let start = lines.length;
  while (start > 0) {
    const line = lines[start - 1];
    if (!line) break;
    const est = estimateLineRows(line, columns);
    if (used + est > budget) break;
    used += est;
    start -= 1;
  }
  if (start === lines.length) start = lines.length - 1;
  return { visible: lines.slice(start), hiddenAbove: start };
}

/** Индексы сообщений пользователя (промптов) в ленте. */
export function promptLineIndices(lines: TuiTranscriptLine[]): number[] {
  const out: number[] = [];
  lines.forEach((line, index) => {
    if ((line.tone ?? "assistant") === "user") out.push(index);
  });
  return out;
}

/** Предыдущий промпт выше позиции (для `{` в транскрипте). */
export function prevPromptIndex(
  lines: TuiTranscriptLine[],
  fromTop: number,
): number {
  let best = 0;
  for (const index of promptLineIndices(lines)) {
    if (index < fromTop) best = index;
    else break;
  }
  return best;
}

/** Следующий промпт ниже позиции (для `}` в транскрипте). */
export function nextPromptIndex(
  lines: TuiTranscriptLine[],
  fromTop: number,
): number {
  for (const index of promptLineIndices(lines)) {
    if (index > fromTop) return index;
  }
  return Math.max(0, lines.length - 1);
}

/** Строки с подстрокой запроса (поиск `/` в транскрипте, без регистра). */
export function searchMatchIndices(
  lines: TuiTranscriptLine[],
  query: string,
): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  lines.forEach((line, index) => {
    if (
      line.text.toLowerCase().includes(q) ||
      line.fileDiff?.patch.toLowerCase().includes(q)
    )
      out.push(index);
  });
  return out;
}

/** Кламп верха пейджера к длине ленты. */
export function clampTop(top: number, total: number): number {
  if (total <= 0) return 0;
  const t = Math.floor(top);
  if (!Number.isFinite(t) || t < 0) return 0;
  return Math.min(t, total - 1);
}

/**
 * Показывать ли пиксельный логотип в стартовом блоке: он печатается один
 * раз и никуда не пересчитывается, поэтому важна только ширина —
 * арт уже ширины окна обрежется truncate-end и поплывёт.
 * Чистая функция для тестов.
 */
export function shouldUseArtWelcome(columns: number): boolean {
  const width = Math.floor(columns);
  if (!Number.isFinite(width)) return false;
  return width >= LOGO_WIDTH;
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
 *   Переоценка размера страшнее недооценки: слишком широкий кадр терминал
 *   переносит сам, а опрос с дочерними процессами блокирует интерфейс —
 *   поэтому никаких спаунов в пути рендера.
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
 * Реальный размер терминала: прямой опрос TTY (getWindowSize + stdout)
 * плюс переменные окружения. Только дешёвые синхронные чтения —
 * никаких дочерних процессов: размер собирается мгновенно, а ресайз
 * подхватывается подпиской Ink на событие resize.
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
 * на 80x24, и корневой узел остаётся узким: вывод рисуется узкой полосой
 * посреди полного экрана (пустота справа, как на баг-репорте).
 *
 * После записи эмитим `resize`, чтобы Ink выполнил свой штатный путь
 * сужения (пересчёт layout) даже когда Bun не прислал событие сам.
 *
 * ВАЖНО: эмит запрещён в пути React-рендера. Подписчик Ink (`resized()`)
 * срабатывает синхронно: эмит посреди рендера даёт ре-entrant рендер Ink
 * внутри рендера React. Эмитить можно только вне рендера:
 * синхрон до render() в cli.ts.
 *
 * Чистый эффект: только присвоение полей TTY, без дочерних процессов.
 * Возвращает живой размер.
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

/** Полноширинный разделитель под актуальную ширину окна. */
export function fullWidthSeparator(columns: number): string {
  return "─".repeat(Math.max(Math.floor(columns) || TUI_FALLBACK_COLUMNS, 10));
}

/**
 * Монохромный стиль стартового блока как у топовых CLI: бренд жирным
 * (адаптивный foreground терминала), модель — обычным начертанием,
 * всё вторичное (путь, версия) — dim. Без анимации и разноцветности.
 */
export interface HeaderTitleInput {
  model: string;
  cwd?: string;
  version?: string;
}

/**
 * Дим-строка мета стартового блока: `model · ~/cwd · vX`.
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

/**
 * Плоский текст слим-заголовка одной строкой (без ANSI, для тестов).
 * Формат: `</> ChiselCode · <model> · <~/cwd> · v<version>`.
 * Пустые части пропускаются, ничего не раздувается.
 */
export function formatHeaderTitle(input: HeaderTitleInput): string {
  const meta = formatHeaderMeta(input);
  return meta ? `</> ChiselCode · ${meta}` : "</> ChiselCode";
}

/** Статичный разделитель под стартовым блоком во всю ширину окна. */
export function headerSeparator(columns: number): string {
  return fullWidthSeparator(columns);
}

/**
 * Подсказка горячих клавиш под полем ввода. Скролл внутренний
 * (PgUp/PgDn, колесо, строка в welcome-хинте), поэтому про скролл
 * тут только транскрипт. Tab/стрелки — выбор команды как в Claude Code,
 * Enter — выбрать/отправить.
 */
export const HOTKEYS_HINT =
  "Tab/↑/↓ — команда · Enter — отправить · Esc — закрыть · Shift+Enter — новая строка · Ctrl+O — транскрипт";

/**
 * Подсказка с жирными клавишами как в Codex (ключи — bold, описания — dim).
 * Одна строка truncate-end как футер Claude: перенос менял бы высоту
 * динамики каждый кадр и давал призраки при стирании.
 */
export function HotkeysHint(): React.JSX.Element {
  const parts = HOTKEYS_HINT.split(" · ");
  return (
    <Text dimColor wrap="truncate-end">
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
  initialSession?: Session;
  approvalResolver: TuiApprovalResolver;
  bindTranscript(transcript: TuiTranscript): void;
  onSubmit(prompt: string, display?: string): Promise<void>;
  onStatus(): Promise<string>;
  onSwitchProject(path: string): Promise<string>;
  onCheckUpdate?(): Promise<string>;
  onDoctor?(): Promise<string>;
  /** Сохранить текущий сеанс и создать новый. */
  onClearSession?(): Promise<void>;
  /** Список сеансов проекта человекочитаемым текстом. */
  onListSessions?(): Promise<string>;
  /** Возврат к сеансу по номеру из списка или id (+реплей истории в вид). */
  onResumeSession?(ref: string): Promise<string>;
  onSessionSummaries?(): Promise<SessionSummary[]>;
  onPreviewSession?(id: string): Promise<Session>;
  onRenameSession?(id: string, title: string): Promise<void>;
  onDeleteSession?(id: string): Promise<void>;
  activeSessionId?(): string | undefined;
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
   * Корень проекта для миграции старых навыков и работы агента.
   */
  cwd?: string;
  /**
   * Явный выбор классического scrollback: лента в Static, высота не
   * фиксируется. По умолчанию — fullscreen с закреплённым вводом.
   */
  classic?: boolean;
}

export interface WelcomeInput {
  columns: number;
  model: string;
  cwd: string;
  version?: string;
}

/**
 * Стартовый блок ленты: арт-логотип + мета + разделитель + хинт.
 * Шапка и есть первое сообщение — нигде не дублируется.
 * Арт-строки идут тоном "logo" с truncate-end, чтобы широкое окно
 * не рвало их wrap-ом в две строки. Отступ сверху, чтобы арт не упирался
 * в край окна. Чистая функция для тестов: id раздаёт вызывающий через nextId.
 */
export function buildWelcomeLines(
  input: WelcomeInput,
  nextId: () => number,
): TuiTranscriptLine[] {
  const lines: TuiTranscriptLine[] = [];
  lines.push({ id: nextId(), text: "", tone: "info" });
  if (shouldUseArtWelcome(input.columns)) {
    for (const artLine of renderLogoRows())
      lines.push({ id: nextId(), text: artLine, tone: "logo" });
  } else {
    lines.push({
      id: nextId(),
      text: formatHeaderTitle({
        model: input.model,
        cwd: input.cwd,
        version: input.version,
      }),
      tone: "info",
      header: "title",
    });
  }
  lines.push({
    id: nextId(),
    text: formatHeaderMeta({
      model: input.model,
      cwd: input.cwd,
      version: input.version,
    }),
    tone: "dim",
    header: "meta",
  });
  lines.push({
    id: nextId(),
    text: fullWidthSeparator(input.columns),
    tone: "dim",
  });
  lines.push({
    id: nextId(),
    text: "Введите задачу и нажмите Enter · /help — команды · PgUp/PgDn — скролл · Ctrl+O — транскрипт",
    tone: "dim",
  });
  return lines;
}
export function TuiApp(props: TuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  /** Корень проекта; навыки загружаются из ChiselCode Home. */
  const projectCwd = props.cwd ?? process.cwd();
  // Ширина/высота ТОЛЬКО из Ink (useWindowSize): Yoga-корень и стирание
  // динамики считают по ним же. Отдельный живой сисколл в рендере давал
  // рассинхрон (наш кадр шире, чем думает Ink) — Ink стирал динамику
  // неверным числом строк и старые боксы оставались призраками.
  // Актуальный размер проталкивается в stdout до render()
  // через syncTerminalSizeToStdout() в cli.ts — этого достаточно.
  const { columns: inkColumns, rows: inkRows } = useWindowSize();
  const viewportSize = normalizeViewport({
    columns: inkColumns,
    rows: inkRows,
  });
  const columns = viewportSize.columns;
  const rows = viewportSize.rows;
  // Classic scrollback is only used when explicitly requested.
  const classic = props.classic ?? false;
  const [editor, setEditor] = useState(createEditorState);
  const [copiedCharacters, setCopiedCharacters] = useState<number>();
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    watchWindowsClipboard((count) => setCopiedCharacters(count))
      .then((dispose) => {
        if (disposed) dispose();
        else stop = dispose;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (copiedCharacters === undefined) return;
    const timer = setTimeout(() => setCopiedCharacters(undefined), 3000);
    return () => clearTimeout(timer);
  }, [copiedCharacters]);
  const [request, setRequest] = useState<ApprovalRequest>();
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<"menu" | "model">();
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSessions, setPickerSessions] = useState<SessionSummary[]>([]);
  // Мастер настройки поверх чата: тот же Ink-экран, без exit()/render().
  const [restartingSetup, setRestartingSetup] = useState(false);
  const [runtime, setRuntime] = useState(() => ({
    provider: props.provider,
    providerLabel: props.providerLabel,
    model: props.model,
    baseUrl: props.baseUrl,
  }));
  const nextTranscriptId = useRef(0);
  // Стартовый блок — первые строки скроллируемой ленты (шапка и есть
  // первое сообщение, дублей нет). Ширина — из Ink-размера первого кадра.
  const [transcript, setTranscript] = useState<TuiTranscriptLine[]>(() =>
    buildWelcomeLines(
      {
        columns,
        model: props.model,
        cwd: projectCwd,
        version: props.version,
      },
      () => nextTranscriptId.current++,
    ),
  );
  useEffect(() => {
    const meta = {
      model: runtime.model,
      cwd: projectCwd,
      version: props.version,
    };
    setTranscript((lines) =>
      lines.map((line) =>
        line.header
          ? {
              ...line,
              text:
                line.header === "title"
                  ? formatHeaderTitle(meta)
                  : formatHeaderMeta(meta),
            }
          : line,
      ),
    );
  }, [runtime.model, projectCwd, props.version]);
  // Незавершённый стриминговый ответ живёт отдельно от истории:
  // по завершении коммитится в ленту одной записью (см. wasBusy ниже).
  const [streaming, setStreaming] = useState<TuiTranscriptLine | null>(null);
  const streamingRef = useRef<TuiTranscriptLine | null>(null);
  const [toolActivity, setActivity] = useState<TuiTranscriptLine>();
  // Очередь follow-up запросов как в Claude Code: Enter во время работы
  // не теряется. Состояние — для показа, ref — для логики в эффектах.
  const [queued, setQueued] = useState<QueuedPrompt[]>([]);
  const queuedRef = useRef<QueuedPrompt[]>([]);
  // Absolute visual row anchors stay put when streaming or appending history.
  const [scrollTop, setScrollTop] = useState<number | null>(null);
  const chatMetrics = useRef(emptyScrollMetrics());
  const pagerMetrics = useRef(emptyScrollMetrics());
  const scrollChat = (delta: number): void => {
    const next = moveScroll(chatMetrics.current, delta);
    chatMetrics.current.top = next ?? chatMetrics.current.maxTop;
    setScrollTop(next);
  };
  const scrollPager = (delta: number): void => {
    const next = moveScroll(pagerMetrics.current, delta);
    pagerMetrics.current.top = next ?? pagerMetrics.current.maxTop;
    setTTop(next);
  };
  const jumpToItem = (index: number): void => {
    setTTop(pagerMetrics.current.itemTops[index] ?? 0);
  };
  // Транскрипт-пейджер Ctrl+O как у Claude: полноэкранный просмотр ленты
  // с поиском, ввод при этом скрыт целиком (черновик сохраняется).
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [tTop, setTTop] = useState<number | null>(null);
  const [tSearching, setTSearching] = useState(false);
  const [tQuery, setTQuery] = useState("");
  const [tMatchIdx, setTMatchIdx] = useState(0);
  // Скорость колеса мыши: CHISEL_SCROLL_SPEED 1..20, дефолт 3.
  const [scrollSpeed] = useState(() =>
    resolveScrollSpeed(process.env.CHISEL_SCROLL_SPEED),
  );
  // Подтверждение важнее просмотра: пришедший approval закрывает пейджер.
  useEffect(() => {
    if (request) setTranscriptOpen(false);
  }, [request]);
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
  // выбранной, остаток — счётчиком.
  const suggestionLimit = Math.max(
    1,
    Math.min(MAX_VISIBLE_SUGGESTIONS, rows - 13),
  );
  const suggestionWindowStart =
    Math.floor(selectedSuggestionIndex / suggestionLimit) * suggestionLimit;
  const visibleSuggestions = suggestions.slice(
    suggestionWindowStart,
    suggestionWindowStart + suggestionLimit,
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
  const pushLine = useCallback(
    (
      text: string,
      tone: TranscriptTone = "assistant",
      fileDiff?: FileDiff,
    ): void => {
      const flushed = streamingRef.current;
      streamingRef.current = null;
      setStreaming(null);
      const id = nextTranscriptId.current++;
      // Absolute row anchors keep the viewport still as history grows.
      setTranscript((lines) => [
        ...lines,
        ...(flushed ? [flushed] : []),
        { id, text, tone, fileDiff },
      ]);
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
    // Коммит накопленного — в pushLine/wasBusy ниже.
  }, []);

  const setToolActivity = useCallback((text?: string): void => {
    if (text) {
      const flushed = streamingRef.current;
      streamingRef.current = null;
      setStreaming(null);
      if (flushed) setTranscript((lines) => [...lines, flushed]);
    }
    setActivity(
      text ? { id: nextTranscriptId.current++, text, tone: "tool" } : undefined,
    );
  }, []);

  const clearAll = useCallback((): void => {
    streamingRef.current = null;
    setStreaming(null);
    // Применяется при замене истории (например, /resume).
    setTranscript([]);
    setActivity(undefined);
    setScrollTop(null);
  }, []);

  const clearToWelcome = useCallback((): void => {
    queuedRef.current = [];
    setQueued([]);
    streamingRef.current = null;
    setStreaming(null);
    setActivity(undefined);
    setTranscript(
      buildWelcomeLines(
        {
          columns,
          model: runtime.model,
          cwd: projectCwd,
          version: props.version,
        },
        () => nextTranscriptId.current++,
      ),
    );
    setScrollTop(null);
  }, [columns, runtime.model, projectCwd, props.version]);

  const replaceAll = useCallback(
    (
      entries: Array<{
        text: string;
        tone?: TranscriptTone;
        fileDiff?: FileDiff;
      }>,
    ): void => {
      streamingRef.current = null;
      setStreaming(null);
      setActivity(undefined);
      setTranscript(
        entries.map((entry) => ({ ...entry, id: nextTranscriptId.current++ })),
      );
      setScrollTop(null);
    },
    [],
  );

  const wasBusy = useRef(false);

  useEffect(() => {
    const bound: TuiTranscript = {
      append: (text, tone = "assistant", fileDiff) =>
        pushLine(text, tone, fileDiff),
      setToolActivity,
      appendToLast: (text) => appendToStreaming(text),
      clear: () => clearAll(),
      replace: replaceAll,
    };
    props.bindTranscript(bound);
    if (props.initialSession)
      replaySessionIntoTranscript(bound, props.initialSession);
  }, [
    props.bindTranscript,
    pushLine,
    appendToStreaming,
    clearAll,
    replaceAll,
    setToolActivity,
    props.initialSession,
  ]);

  function append(text: string, tone: TranscriptTone = "assistant"): void {
    pushLine(text, tone);
  }
  /**
   * Отложить запрос в очередь: ввод во время работы агента не теряется,
   * а уходит следующим (как Enter в Claude Code). В журнале виден сразу.
   */
  function enqueuePrompt(prompt: string, display?: string): void {
    setEditor((state) => addEditorHistory(state, display ?? prompt));
    resetCommandSelection();
    const item: QueuedPrompt = { prompt, display };
    queuedRef.current.push(item);
    setQueued((items) => [...items, item]);
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
        // Скилл во время работы — в очередь, иначе выполнился бы
        // параллельно с активным агентом и потерялся в cli-гарде.
        if (busy) {
          enqueuePrompt(expandSkill(skill.skill, skill.args), prompt);
          return;
        }
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
    // Обычный текст во время работы — в очередь, а не в никуда.
    if (busy) {
      enqueuePrompt(prompt);
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
  // Свежий submitPrompt для эффекта ниже: эффект подписан только на busy
  // (снимок на момент перехода), а отправлять надо актуальным замыканием
  // (свежие скиллы/рантайм). Refs в зависимостях не нужны.
  const submitRef = useRef(submitPrompt);
  submitRef.current = submitPrompt;
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const flushed = streamingRef.current;
      if (flushed) {
        streamingRef.current = null;
        setStreaming(null);
        setTranscript((lines) => [...lines, flushed]);
      }
      // Очередь как в Claude Code: первый отложенный запрос уходит
      // следующим, остальные ждут. setQueued чистит показ,
      // queuedRef — источник правды для логики.
      const next = queuedRef.current.shift();
      if (next) {
        setQueued((items) => items.slice(1));
        submitRef.current(next.prompt, next.display);
      }
    }
    wasBusy.current = busy;
  }, [busy]);
  function findSkill(
    prompt: string,
  ): { skill: Skill; args: string } | undefined {
    const space = prompt.search(/\s/);
    const head = space === -1 ? prompt : prompt.slice(0, space);
    if (!head.startsWith("/") || head.length < 2) return undefined;
    const args = space === -1 ? "" : prompt.slice(space).trim();
    const skill = slashSkills.find(
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
      append(commandHelpText(slashSkills), "info");
      return;
    }
    if (name === "/clear") {
      if (busy) {
        append("Дождитесь завершения ответа и повторите /clear.", "info");
        return;
      }
      try {
        await props.onClearSession?.();
        clearToWelcome();
      } catch (cause) {
        append(
          `Ошибка: ${cause instanceof Error ? cause.message : String(cause)}`,
          "error",
        );
      }
      return;
    }
    if (name === "/sessions") {
      if (props.onSessionSummaries) {
        try {
          setPickerSessions(await props.onSessionSummaries());
          setPickerOpen(true);
        } catch (cause) {
          append(`Ошибка: ${String(cause)}`, "error");
        }
        return;
      }
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
      if (!args.trim() && props.onSessionSummaries) {
        try {
          setPickerSessions(await props.onSessionSummaries());
          setPickerOpen(true);
        } catch (cause) {
          append(`Ошибка: ${String(cause)}`, "error");
        }
        return;
      }
      setBusy(true);
      try {
        const message = await props.onResumeSession?.(args);
        const id = props.activeSessionId?.();
        if (id && props.onPreviewSession) {
          const session = await props.onPreviewSession(id);
          setRuntime((state) => ({
            ...state,
            model: session.model,
            provider: session.provider,
            providerLabel: providerName(session.provider),
          }));
        }
        append(message ?? "Возврат к сеансу недоступен.", "info");
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
      // Даём строке отрисоваться: иначе exit() в том же тике не оставит
      // финального сообщения в ленте, и покажется, что приложение
      // «просто исчезло».
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

  // Bracketed paste keeps multi-line clipboard text atomic: embedded newlines
  // are inserted into the draft instead of submitting the first line.
  usePaste(
    (text) => {
      setEditor((state) =>
        insertEditorText(state, text.replace(/\r\n?/g, "\n")),
      );
      setSuggestionIndex(0);
      setSuggestionsDismissed(false);
    },
    {
      isActive:
        !pickerOpen &&
        !request &&
        !settings &&
        !skillsOpen &&
        !restartingSetup &&
        !transcriptOpen,
    },
  );
  useInput((character, key) => {
    if (pickerOpen) return;
    // Мышь SGR первее всего: колесо скроллит даже в панелях и approval,
    // остальные события (клики/отпускания) глотаются, чтобы не сыпались
    // мусором в ввод. Шаг — в визуальных строках, Shift — рывок
    // на пол-экрана: лента едет плавно, а не кусками сообщений.
    const mouse = parseSGRMouse(character);
    if (mouse) {
      if (request) return; // Approval owns its scroll viewport.
      if (mouse.kind === "wheel-up" || mouse.kind === "wheel-down") {
        const step =
          (mouse.shift ? scrollPageStep(rows) : scrollSpeed) *
          (mouse.kind === "wheel-up" ? -1 : 1);
        if (transcriptOpen) scrollPager(step);
        else if (!classic) scrollChat(step);
      }
      return;
    }
    if (request) {
      // Принимаем и русскую раскладку: «н» — та же физическая клавиша, что y.
      const answer = character.toLowerCase();
      if (answer === "y" || answer === "н")
        props.approvalResolver.resolve("approved");
      if (answer === "n" || answer === "т" || key.escape)
        props.approvalResolver.resolve("denied");
      return;
    }
    // Ctrl+O — транскрипт-пейджер как у Claude (j/k, g/G, {/}, /, n/N).
    if (key.ctrl && (character === "o" || character === "O")) {
      if (!settings && !skillsOpen && !restartingSetup) {
        if (transcriptOpen) {
          setTranscriptOpen(false);
        } else {
          setTSearching(false);
          setTQuery("");
          setTMatchIdx(0);
          setTTop(null);
          setTranscriptOpen(true);
        }
      }
      return;
    }
    if (transcriptOpen) {
      const currentItem = Math.max(
        0,
        pagerMetrics.current.itemTops.reduce(
          (found, row, index) =>
            row <= pagerMetrics.current.top ? index : found,
          0,
        ),
      );
      const matches = tQuery.trim()
        ? searchMatchIndices(transcript, tQuery)
        : [];
      // Режим ввода запроса поиска после `/`.
      if (tSearching) {
        if (key.escape) {
          setTSearching(false);
          setTQuery("");
          setTMatchIdx(0);
          return;
        }
        if (key.return) {
          setTSearching(false);
          setTMatchIdx(0);
          const first = matches[0];
          if (first !== undefined) jumpToItem(first);
          return;
        }
        if (key.backspace) {
          setTQuery((query) => query.slice(0, -1));
          return;
        }
        if (!key.ctrl && !key.meta && character) {
          setTQuery((query) => (query + character).slice(0, 120));
          return;
        }
        return;
      }
      if (character === "q" || character === "й" || key.escape) {
        setTranscriptOpen(false);
        return;
      }
      if (character === "j" || key.downArrow) {
        scrollPager(1);
        return;
      }
      if (character === "k" || key.upArrow) {
        scrollPager(-1);
        return;
      }
      if (key.pageUp) {
        scrollPager(-scrollPageStep(rows));
        return;
      }
      if (key.pageDown) {
        scrollPager(scrollPageStep(rows));
        return;
      }
      if (character === "g" || key.home) {
        setTTop(0);
        return;
      }
      if (character === "G" || key.end) {
        setTTop(null);
        return;
      }
      if (key.ctrl && (character === "u" || character === "U")) {
        scrollPager(-10);
        return;
      }
      if (key.ctrl && (character === "d" || character === "D")) {
        scrollPager(10);
        return;
      }
      if (character === "{") {
        jumpToItem(prevPromptIndex(transcript, currentItem));
        return;
      }
      if (character === "}") {
        jumpToItem(nextPromptIndex(transcript, currentItem));
        return;
      }
      if (character === "/") {
        setTSearching(true);
        setTQuery("");
        setTMatchIdx(0);
        return;
      }
      if ((character === "n" || character === "N") && matches.length > 0) {
        const step = character === "n" ? 1 : -1;
        const next = (tMatchIdx + step + matches.length) % matches.length;
        setTMatchIdx(next);
        const lineIndex = matches[next];
        if (lineIndex !== undefined) jumpToItem(lineIndex);
        return;
      }
      return;
    }
    if (settings || skillsOpen || restartingSetup) return;
    if (!classic && key.pageUp) {
      scrollChat(-scrollPageStep(rows));
      return;
    }
    if (!classic && key.pageDown) {
      scrollChat(scrollPageStep(rows));
      return;
    }
    if (!classic && key.home) {
      setScrollTop(0);
      return;
    }
    if (!classic && key.end) {
      setScrollTop(null);
      return;
    }
    if (!classic && key.ctrl && character.toLowerCase() === "u") {
      scrollChat(-10);
      return;
    }
    if (!classic && key.ctrl && character.toLowerCase() === "d") {
      scrollChat(10);
      return;
    }
    if (key.ctrl && character === "c") {
      exit();
      return;
    }
    // Esc закрывает список команд как в Claude Code.
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
    // иначе — история запросов.
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

  // Панели занимают место футера под лентой (как модалки Claude):
  // лента выше остаётся смонтированной, вместо ввода рисуется панель.
  const panel = restartingSetup ? (
    <SetupApp
      onComplete={completeRestartedSetup}
      onCancel={cancelRestartedSetup}
      exitOnComplete={false}
    />
  ) : settings ? (
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
  ) : skillsOpen ? (
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
  ) : null;
  const footer = request ? (
    <Approval request={request} columns={columns} rows={rows} />
  ) : (
    <>
      {busy ? <Thinking model={runtime.model} /> : null}
      {queued.length > 0 ? (
        <Text dimColor wrap="truncate-end">
          В очереди ({queued.length}):{" "}
          {queued
            .map((item) => truncate(item.display ?? item.prompt, 60))
            .join(" · ")}
        </Text>
      ) : null}
      <Editor
        value={editor.value}
        cursor={editor.cursor}
        copiedCharacters={copiedCharacters}
        maxRows={Math.max(
          1,
          Math.min(
            6,
            frameRows(rows) -
              (suggestionRows.length ? suggestionRows.length + 3 : 0) -
              (busy ? 1 : 0) -
              (queued.length ? 1 : 0) -
              7,
          ),
        )}
        suggestionRows={suggestionRows}
        selectedRow={selectedVisibleIndex}
        columns={columns}
      />
    </>
  );

  if (pickerOpen)
    return (
      <SessionPicker
        sessions={pickerSessions}
        activeId={props.activeSessionId?.()}
        rows={rows}
        onClose={() => setPickerOpen(false)}
        onResume={async (id) => {
          const message = await props.onResumeSession?.(id);
          const session = await props.onPreviewSession?.(id);
          if (session)
            setRuntime((state) => ({
              ...state,
              model: session.model,
              provider: session.provider,
              providerLabel: providerName(session.provider),
            }));
          setPickerOpen(false);
          if (message) append(message, "info");
        }}
        onPreview={async (id) => {
          if (!props.onPreviewSession) throw new Error("Просмотр недоступен");
          return props.onPreviewSession(id);
        }}
        onRename={async (id, title) => {
          if (!props.onRenameSession)
            throw new Error("Переименование недоступно");
          await props.onRenameSession(id, title);
        }}
        onDelete={async (id) => {
          if (!props.onDeleteSession) throw new Error("Удаление недоступно");
          await props.onDeleteSession(id);
        }}
        onRefresh={async () =>
          setPickerSessions((await props.onSessionSummaries?.()) ?? [])
        }
      />
    );

  // Явно выбранная классика: Static дописывается в scrollback, динамическая
  // зона (стриминг + панели/ввод) перерисовывается на месте маленьким куском.
  if (classic && !transcriptOpen) {
    return (
      <Box flexDirection="column" width="100%">
        <Static items={transcript}>
          {(line) => (
            <TranscriptLineView key={line.id} line={line} columns={columns} />
          )}
        </Static>
        <Box flexDirection="column" width="100%">
          {streaming ? (
            <TranscriptLineView line={streaming} columns={columns} />
          ) : null}
          {toolActivity ? (
            <TranscriptLineView line={toolActivity} columns={columns} />
          ) : null}
          {panel ?? footer}
        </Box>
      </Box>
    );
  }

  const feed = [
    ...transcript,
    ...(streaming ? [streaming] : []),
    ...(toolActivity ? [toolActivity] : []),
  ];
  const items = feed.map((line) => ({
    id: line.id,
    content: <MemoTranscriptLineView line={line} columns={columns} />,
  }));
  if (transcriptOpen) {
    const matches = tQuery.trim() ? searchMatchIndices(transcript, tQuery) : [];
    const overlayFrame = frameRows(rows);
    return (
      <Box flexDirection="column" width={columns} height={overlayFrame}>
        <Box width="100%" flexShrink={0}>
          <Text bold wrap="truncate-end">
            Транскрипт · {transcript.length} строк · Ctrl+O/q — назад
          </Text>
        </Box>
        <ScrollViewport items={items} top={tTop} metrics={pagerMetrics} />
        <Box flexDirection="column" width="100%" flexShrink={0}>
          {tSearching ? (
            <Text wrap="truncate-end">/{tQuery}█</Text>
          ) : tQuery.trim() ? (
            <Text dimColor wrap="truncate-end">
              /{tQuery} · {matches.length} совп. · n/N — далее
            </Text>
          ) : null}
          {copiedCharacters === undefined ? (
            <Text dimColor wrap="truncate-end">
              {"j/k — строки · g/G — верх/низ · {/} — промпты · / — поиск"}
            </Text>
          ) : (
            <Text color="green" wrap="truncate-end">
              {copiedCharactersNotice(copiedCharacters)}
            </Text>
          )}
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={columns} height={frameRows(rows)}>
      <ScrollViewport items={items} top={scrollTop} metrics={chatMetrics} />
      <Box
        flexDirection="column"
        width="100%"
        flexShrink={0}
        maxHeight={frameRows(rows) - 1}
        overflow="hidden"
      >
        {panel ?? footer}
      </Box>
    </Box>
  );
}

/**
 * Путь покороче для стартового блока: домашняя папка —
 * как ~/…, как в Codex. Чистая функция для тестов.
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
 * Одна строка ленты. Экспортирована для тестов точности сметы:
 * estimateLineRows обязана совпадать с реальной высотой рендера.
 */
export function TranscriptLineView({
  line,
  columns,
}: {
  line: TuiTranscriptLine;
  columns: number;
}): React.JSX.Element {
  if (line.fileDiff)
    return <FileDiffView fileDiff={line.fileDiff} columns={columns} />;
  const tone = line.tone ?? "assistant";
  if (tone === "logo") {
    // Арт шапки: truncate-end, иначе wrap рвал строку 76 клеток
    // в две и «шапка плыла». Как в Claude — лого печатается 1:1.
    return (
      <Box width="100%" flexShrink={0}>
        <Text wrap="truncate-end">{line.text}</Text>
      </Box>
    );
  }
  if (tone === "dim") {
    // Вторичные строки стартового блока и разделители: тихо, dim.
    return (
      <Box width="100%" flexShrink={0}>
        <Text dimColor wrap="wrap">
          {line.text}
        </Text>
      </Box>
    );
  }
  if (tone === "user") {
    // Залитый блок как в Codex: префикс ❯ жирным зелёным, текст обычным.
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
    // детали dim.
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
  // Ответ ассистента: левая акцентная черта как в OpenCode.
  // flexShrink={0}: переполнение режется снизу.
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
const MemoTranscriptLineView = memo(TranscriptLineView);

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

export function Approval({
  request,
  columns,
  rows,
}: {
  request: ApprovalRequest;
  columns: number;
  rows: number;
}): React.JSX.Element {
  const [top, setTop] = useState<number | null>(0);
  const metrics = useRef(emptyScrollMetrics());
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new approval must start at the first diff row.
  useEffect(() => {
    setTop(0);
  }, [request]);
  useInput((character, key) => {
    const mouse = parseSGRMouse(character);
    let delta = 0;
    if (key.upArrow || mouse?.kind === "wheel-up") delta = -3;
    if (key.downArrow || mouse?.kind === "wheel-down") delta = 3;
    if (key.pageUp) delta = -Math.max(1, metrics.current.height - 1);
    if (key.pageDown) delta = Math.max(1, metrics.current.height - 1);
    if (delta) setTop(moveScroll(metrics.current, delta));
    if (key.home) setTop(0);
    if (key.end) setTop(null);
  });
  const meta = toolDisplay(request.tool);
  const width = Math.max(1, columns - 4);
  // Non-file approvals also use a bounded, scrollable preview.
  const rawLines = request.fileDiff ? [] : request.preview.split("\n");
  const preview = rawLines
    .slice(0, 200)
    .map((line) => truncate(line, 1000))
    .join("\n");
  const color = process.env.NO_COLOR === undefined;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color ? "yellow" : undefined}
      paddingX={1}
      width="100%"
      height={Math.max(7, Math.min(28, rows - 2))}
      flexShrink={0}
    >
      <Text bold={color} wrap="truncate-end">
        ? {meta.label} — нужно подтверждение
      </Text>
      <ScrollViewport
        metrics={metrics}
        top={top}
        items={[
          {
            id: 0,
            content: request.fileDiff ? (
              <FileDiffView fileDiff={request.fileDiff} columns={width} />
            ) : (
              <Box flexDirection="column" width={width} flexShrink={0}>
                <Text>{preview}</Text>
                {rawLines.length > 200 ? (
                  <Text>… {rawLines.length - 200} more preview lines</Text>
                ) : null}
              </Box>
            ),
          },
        ]}
      />
      <Text dimColor={color} wrap="truncate-end">
        ↑/↓ · PgUp/PgDn · Home/End — просмотр
      </Text>
      <Text wrap="truncate-end">
        {width < 36 ? "[y] Да · [n] Нет" : "[y] разрешить · [n/Esc] отклонить"}
      </Text>
    </Box>
  );
}
function Editor({
  value,
  cursor,
  copiedCharacters,
  suggestionRows,
  selectedRow,
  columns,
  maxRows,
}: {
  value: string;
  cursor: number;
  copiedCharacters?: number;
  /** Готовые строки подсказок (подсвеченная уже с префиксом, остальные — имена). */
  suggestionRows: string[];
  /** Индекс подсвеченной строки в suggestionRows. */
  selectedRow: number;
  columns: number;
  maxRows: number;
}): React.JSX.Element {
  void columns;
  return (
    <Box flexDirection="column" marginTop={1} width="100%" flexShrink={0}>
      {suggestionRows.length ? (
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
        borderColor="cyan"
        paddingX={1}
        width="100%"
        flexShrink={0}
      >
        {value ? (
          <EditorText value={value} cursor={cursor} maxRows={maxRows} />
        ) : (
          <Text dimColor wrap="truncate-end">
            <Text bold color="green">
              ❯{" "}
            </Text>
            Спросите что-нибудь… ( / — команды )
          </Text>
        )}
      </Box>
      {copiedCharacters === undefined ? (
        <HotkeysHint />
      ) : (
        <Text color="green" wrap="truncate-end">
          {copiedCharactersNotice(copiedCharacters)}
        </Text>
      )}
    </Box>
  );
}

/** Measure both the full draft and cursor prefix, keeping the cursor in view. */
function EditorText({
  value,
  cursor,
  maxRows,
}: {
  value: string;
  cursor: number;
  maxRows: number;
}): React.JSX.Element {
  const body = useRef<DOMElement>(null);
  const prefix = useRef<DOMElement>(null);
  const bodySize = useBoxMetrics(body);
  const prefixSize = useBoxMetrics(prefix);
  const height = Math.max(1, Math.min(maxRows, bodySize.height));
  const offset = Math.max(
    0,
    Math.min(bodySize.height - height, prefixSize.height - height),
  );
  return (
    <Box width="100%" height={height} overflow="hidden">
      <Box
        ref={body}
        position="absolute"
        top={-offset}
        width="100%"
        flexShrink={0}
      >
        <Text wrap="wrap">
          <Text bold color="green">
            ❯{" "}
          </Text>
          {renderWithCursor(value, cursor)}
        </Text>
      </Box>
      <Box position="absolute" width="100%" height={0} overflow="hidden">
        <Box ref={prefix} width="100%" flexShrink={0} alignSelf="flex-start">
          <Text wrap="wrap">{`❯ ${value.slice(0, cursor)}█`}</Text>
        </Box>
      </Box>
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
