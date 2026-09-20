import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
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
import { LOGO_WIDTH, renderLogoRows } from "./logo.js";
import { MarkdownText } from "./markdown.js";
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
  | "dim";

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
 * Раскладка как в classic-режиме Claude Code: обычный scrollback-буфер
 * терминала вместо alternate screen.
 * - Стартовый блок (логотип + модель/путь/версия + подсказки) печатается
 *   один раз и уплывает вверх вместе с диалогом — закреплённой шапки нет;
 * - завершённые сообщения уходят в <Static> (нативный скролл терминала,
 *   выделение и копирование мышью работают сами);
 * - незавершённый стриминг, подтверждение и поле ввода живут в динамической
 *   зоне снизу. Никакой сметы высоты и кастомного скролла: переносом строк
 *   занимается сам Ink/Yoga.
 * Живой размер проталкивается в process.stdout (syncTerminalSizeToStdout),
 * потому что Yoga-корень Ink читает только stdout.columns/rows и на
 * Windows застревает на 80x24 без этого синхрона.
 */
export const TUI_MIN_COLUMNS = 20;
export const TUI_MIN_ROWS = 10;
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
 * Подсказка горячих клавиш под полем ввода. Скролл нативный терминальный
 * (колесо/Shift+PgUp самого терминала), поэтому про колесо тут ни слова.
 * Tab/стрелки — выбор команды как в Claude Code, Enter — выбрать/отправить.
 */
export const HOTKEYS_HINT =
  "Tab/↑/↓ — команда · Enter — отправить · Esc — закрыть · Shift+Enter — новая строка";

/**
 * Подсказка с жирными клавишами как в Codex (ключи — bold, описания — dim).
 */
export function HotkeysHint(): React.JSX.Element {
  const parts = HOTKEYS_HINT.split(" · ");
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

export interface WelcomeInput {
  columns: number;
  model: string;
  cwd: string;
  version?: string;
}

/**
 * Стартовый блок как в classic-режиме Claude Code: печатается один раз
 * и уплывает вверх вместе с диалогом — закреплённой шапки нет.
 * Отступ сверху, чтобы блочный арт не упирался в край окна.
 * Чистая функция для тестов: id раздаёт вызывающий через nextId.
 */
export function buildWelcomeLines(
  input: WelcomeInput,
  nextId: () => number,
): TuiTranscriptLine[] {
  const lines: TuiTranscriptLine[] = [];
  lines.push({ id: nextId(), text: "", tone: "info" });
  if (shouldUseArtWelcome(input.columns)) {
    for (const artLine of renderLogoRows())
      lines.push({ id: nextId(), text: artLine, tone: "info" });
  } else {
    lines.push({
      id: nextId(),
      text: formatHeaderTitle({
        model: input.model,
        cwd: input.cwd,
        version: input.version,
      }),
      tone: "info",
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
  });
  lines.push({
    id: nextId(),
    text: fullWidthSeparator(input.columns),
    tone: "dim",
  });
  lines.push({
    id: nextId(),
    text: "Введите задачу и нажмите Enter · /help — команды · /status — состояние",
    tone: "dim",
  });
  return lines;
}
export function TuiApp(props: TuiAppProps): React.JSX.Element {
  const { exit } = useApp();
  /** Корень проекта: скиллы берём из его `.chisel/skills`. */
  const projectCwd = props.cwd ?? process.cwd();
  const { columns: inkColumns } = useWindowSize();
  const columns = normalizeViewport({ columns: inkColumns }).columns;
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
  const nextTranscriptId = useRef(0);
  // Стартовые значения берём из пропсов один раз: дальше модель/путь
  // меняются через runtime и видны в статус-строке над вводом.
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
  // Незавершённый стриминговый ответ живёт отдельно от истории:
  // по завершении коммитится в Static одной записью (см. wasBusy ниже).
  const [streaming, setStreaming] = useState<TuiTranscriptLine | null>(null);
  const streamingRef = useRef<TuiTranscriptLine | null>(null);
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
  const pushLine = useCallback(
    (text: string, tone: TranscriptTone = "assistant"): void => {
      const flushed = streamingRef.current;
      streamingRef.current = null;
      setStreaming(null);
      const id = nextTranscriptId.current++;
      // Скролл нативный терминальный: новые строки просто дописываются
      // в <Static>, терминал сам прокручивает вывод. Никаких offset.
      setTranscript((lines) => [
        ...lines,
        ...(flushed ? [flushed] : []),
        { id, text, tone },
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

  const clearAll = useCallback((): void => {
    streamingRef.current = null;
    setStreaming(null);
    // Как /clear в classic-режиме Claude Code: новый разговор, а не чистка
    // экрана — уже напечатанное остаётся в скроллбэке терминала выше.
    setTranscript([]);
  }, []);

  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const flushed = streamingRef.current;
      if (flushed) {
        streamingRef.current = null;
        setStreaming(null);
        setTranscript((lines) => [...lines, flushed]);
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
      // Даём строке отрисоваться: иначе exit() в том же тике не оставит
      // в scrollback финального сообщения, и покажется, что приложение
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
    // Скролл — нативный терминальный (колесо/Shift+PgUp самого терминала),
    // история лежит в scrollback: отдельных клавиш скролла нет.
    // Выход работает даже пока агент думает.
    if (key.ctrl && character === "c") {
      exit();
      return;
    }
    if (busy) return;
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

  // Панели занимают динамическую зону под историей (как в classic-режиме
  // Claude Code): <Static>-история всегда смонтирована и никогда
  // не перепечатывается, вместо ввода рисуется панель.
  // Никакой фиксированной высоты кадра больше нет.
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
    <Approval request={request} columns={columns} />
  ) : (
    <>
      <Text dimColor wrap="truncate-end">
        {runtime.model} · {shortenHome(projectCwd)}
      </Text>
      <Editor
        value={editor.value}
        cursor={editor.cursor}
        busy={busy}
        model={runtime.model}
        suggestionRows={suggestionRows}
        selectedRow={selectedVisibleIndex}
        columns={columns}
      />
    </>
  );

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
        {panel ?? footer}
      </Box>
    </Box>
  );
}

/**
 * Путь покороче для стартового блока и статус-строки: домашняя папка —
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

function TranscriptLineView({
  line,
  columns,
}: {
  line: TuiTranscriptLine;
  columns: number;
}): React.JSX.Element {
  const tone = line.tone ?? "assistant";
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
      <HotkeysHint />
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
