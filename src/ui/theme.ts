/**
 * Премиальная визуальная система ChiselCode.
 *
 * Чистые строковые помощники без зависимости от Ink: используются и в TUI,
 * и в one-shot режиме, и в `chisel doctor/update`. Все функции возвращают
 * обычный текст без ANSI — раскраской занимается вызывающий слой.
 */

export const BRAND_MARK = "◈";
export const USER_ARROW = "❯";
export const TOOL_SPARK = "◆";
export const OK_MARK = "✓";
export const FAIL_MARK = "✗";
export const WARN_MARK = "⚠";
export const INFO_MARK = "ℹ";
export const DOT = "·";
export const ELLIPSIS = "…";

/**
 * Дизайн-система журнала (подсмотрено у Codex/OpenCode):
 * - сообщение юзера — залитый блок с префиксом ❯ (blend белого 0.12
 *   на тёмном фоне терминала);
 * - ответ ассистента — левая акцентная черта, markdown внутри на клетку уже;
 * - вызов инструмента — gutter «◆ глагол детали», глагол жирным в цвете.
 * Цвета — именами Ink, чтобы читались и в 16-цветных терминалах.
 */
export const USER_BUBBLE_BG = "#1f1f1f";
export const ASSISTANT_GUTTER = "gray";

export interface ToolDisplay {
  icon: string;
  label: string;
}

/** Человекочитаемые подписи инструментов. Метки совпадают с панелью подтверждения TUI. */
export const TOOL_DISPLAY: Record<string, ToolDisplay> = {
  read_file: { icon: "◉", label: "Чтение файла" },
  list_dir: { icon: "≡", label: "Список файлов" },
  glob: { icon: "✧", label: "Поиск файлов" },
  grep: { icon: "⌕", label: "Поиск по коду" },
  write_file: { icon: "+", label: "Запись файла" },
  edit_file: { icon: "~", label: "Редактирование файла" },
  delete_file: { icon: "×", label: "Удаление файла" },
  run_shell: { icon: "$", label: "Команда shell" },
  git_diff: { icon: "≠", label: "Git diff" },
  git_commit: { icon: "#", label: "Git commit" },
  self_update: { icon: "⇪", label: "Обновление ChiselCode" },
};

export function toolDisplay(tool: string): ToolDisplay {
  return TOOL_DISPLAY[tool] ?? { icon: "?", label: tool };
}

export type ToolTone = "cyan" | "yellow" | "magenta" | "blue" | "green";

/**
 * Цвет искры вызова инструмента в журнале — как группируют операции
 * топовые CLI: чтение/поиск — спокойный cyan, изменения файлов — заметный
 * yellow, shell — magenta, git — blue, остальное — green.
 */
export function toolTone(name: string): ToolTone {
  if (name === "run_shell" || name.startsWith("$")) return "magenta";
  if (
    name === "write_file" ||
    name === "edit_file" ||
    name === "delete_file" ||
    name === "self_update"
  )
    return "yellow";
  if (name === "git_diff" || name === "git_commit" || name.startsWith("git"))
    return "blue";
  if (
    name === "read_file" ||
    name === "list_dir" ||
    name === "glob" ||
    name === "grep"
  )
    return "cyan";
  return "green";
}

function singleLine(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return truncate(text.replace(/\s+/g, " ").trim(), maxLength);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return ELLIPSIS;
  return `${text.slice(0, maxLength - 1)}${ELLIPSIS}`;
}

/**
 * Человекочитаемая однострочная сводка вызова инструмента для журнала TUI
 * и one-shot режима. Всегда одна строка без переносов.
 */
export function formatToolSummary(
  tool: string,
  input: Record<string, unknown>,
): string {
  const path = typeof input.path === "string" ? input.path : undefined;
  switch (tool) {
    case "read_file": {
      if (!path) return "read_file";
      const offset =
        typeof input.offset === "number" ? input.offset : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const range =
        offset !== undefined || limit !== undefined
          ? ` (строки ${(offset ?? 0) + 1}–${(offset ?? 0) + (limit ?? 1000)})`
          : "";
      return `read_file ${path}${range}`;
    }
    case "list_dir": {
      const recursive = input.recursive === true ? " — рекурсивно" : "";
      return `list_dir ${path ?? "."}${recursive}`;
    }
    case "glob": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      return `glob «${truncate(pattern, 80)}»${path ? ` в ${path}` : ""}`;
    }
    case "grep": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const glob = typeof input.glob === "string" ? ` ${input.glob}` : "";
      return `grep «${truncate(pattern, 80)}»${path && path !== "." ? ` в ${path}` : ""}${glob}`;
    }
    case "write_file": {
      const lines =
        typeof input.content === "string"
          ? input.content.split("\n").length
          : 0;
      return `write_file ${path ?? "(новый файл)"} · +${lines} строк`;
    }
    case "edit_file": {
      const oldStr = typeof input.old_str === "string" ? input.old_str : "";
      return `edit_file ${path ?? ""} · замена «${singleLine(oldStr, 80)}»`.trim();
    }
    case "delete_file":
      return `delete_file ${path ?? ""}`.trim();
    case "run_shell": {
      const command = typeof input.command === "string" ? input.command : "";
      const cwd =
        typeof input.cwd === "string" && input.cwd !== "."
          ? ` (в ${input.cwd})`
          : "";
      return `$ ${singleLine(command, 120)}${cwd}`;
    }
    case "git_diff":
      return path ? `git diff -- ${path}` : "git diff";
    case "git_commit": {
      const message = typeof input.message === "string" ? input.message : "";
      return `git commit -m «${singleLine(message, 100)}»`;
    }
    default:
      return `${tool} ${singleLine(input, 160)}`.trim();
  }
}

/** Длительность в человекочитаемом виде: 0.4с, 12с, 1м 05с. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    if (ms < 1000) return `${Math.max(1, Math.round(ms / 100)) / 10}с`;
    return `${seconds}с`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}м ${String(rest).padStart(2, "0")}с`;
}

/** Число с разделителем тысяч: 1234 → "1 234". */
export function formatTokens(count: number): string {
  return Math.round(count)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Стоимость в долларах без лишних нулей: 0.01230 → "$0.0123". */
export function formatCost(cost: number): string {
  if (!(cost > 0)) return "$0";
  const text = cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}`;
}

export interface StatusDashboardInput {
  providerLabel: string;
  model: string;
  cwd: string;
  keyReady: boolean;
  sessionId?: string;
  sessionTitle?: string;
  totalTokens?: number;
  totalCost?: number;
}

/** Панель `/status`: аккуратный дашборд с выровненными значениями. */
export function formatStatusDashboard(input: StatusDashboardInput): string {
  const row = (label: string, value: string): string =>
    `${label.padEnd(9, " ")} ${value}`;
  const lines = [
    `${BRAND_MARK} ChiselCode — состояние`,
    row("Сервис:", input.providerLabel),
    row("Модель:", input.model),
    row("Проект:", input.cwd),
    row(
      "API-ключ:",
      input.keyReady ? "✓ настроен" : `✗ не настроен ${DOT} chisel setup`,
    ),
    row(
      "Сессия:",
      input.sessionId
        ? `${input.sessionTitle ? `«${input.sessionTitle}» ${DOT} ` : ""}${input.sessionId}`
        : "новая — откроется следующим запросом",
    ),
  ];
  if (input.totalTokens !== undefined && input.totalTokens > 0) {
    const cost =
      input.totalCost !== undefined
        ? ` ${DOT} ${formatCost(input.totalCost)}`
        : "";
    lines.push(
      row("Контекст:", `${formatTokens(input.totalTokens)} токенов${cost}`),
    );
  }
  lines.push(
    "",
    `/model ${DOT} сменить модель    /cwd <путь> ${DOT} сменить проект    /sessions ${DOT} список сеансов`,
  );
  return lines.join("\n");
}

/** Стартовых приветственных строк больше нет: шапка показывает сервис/модель, подсказки — в /help. */
export function welcomeLines(
  _providerLabel: string,
  _model: string,
  _version: string,
): string[] {
  return [];
}

export interface DoneSummaryInput {
  elapsedMs: number;
  totalTokens: number;
  totalCost: number;
  sessionId: string;
}

/** Итоговая строка после каждого ответа — как у топовых агентов. */
export function formatDoneSummary(input: DoneSummaryInput): string {
  return (
    `${OK_MARK} Готово за ${formatDuration(input.elapsedMs)} ${DOT} ` +
    `${formatTokens(input.totalTokens)} токенов ${DOT} ` +
    `${formatCost(input.totalCost)} ${DOT} сессия ${input.sessionId.slice(0, 8)}`
  );
}

/* ── ANSI для не-Ink вывода (one-shot, doctor, update) ── */

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;

export type PaintColor = keyof typeof ANSI;

/** Поддерживает ли поток цвета (уважает NO_COLOR и pipe). */
export function supportsColor(stream?: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR === "1") return true;
  return Boolean(stream?.isTTY);
}

export function paint(
  text: string,
  color: PaintColor,
  enabled: boolean,
): string {
  if (!enabled) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}
