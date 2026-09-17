import { EventEmitter } from "node:events";

/**
 * Мышь терминала: SGR-режим даёт скролл журнала колесом, но Ink не понимает
 * mouse-последовательности (`\x1b[<Cb;Cx;CyM`) и печатал бы их в поле ввода
 * как обычный текст. Поэтому между настоящим stdin и Ink стоит фильтр:
 * колесо уходит в скролл, клики глотаются молча, клавиатура едет дальше
 * нетронутой. Чистые функции покрыты тестами.
 */

export type WheelDirection = "up" | "down";

/** Сколько строк журнала прокручивает один щелчок колеса мыши. */
export const WHEEL_SCROLL_LINES = 3;

/** Включение SGR-режима мыши терминала (колесо едет как `\x1b[<…M`). */
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
/** Выключение: иначе после выхода в терминале ломается выделение текста. */
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

const ESC = String.fromCharCode(27);
const MOUSE_PATTERN = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");

/** Рваный хвост дольше этого ждёт продолжения, потом уходит как есть. */
const PENDING_FLUSH_MS = 30;
/** Предохранитель: оборванный префикс не копим бесконечно. */
const MAX_PENDING_CHARS = 256;

export interface SplitMouseEvents {
  /** Чистый текст для Ink: полные mouse-последовательности выкушены. */
  text: string;
  /** События колеса по порядку (64-й бит Cb, младший — направление). */
  wheels: WheelDirection[];
  /** Незавершённый префикс в хвосте — ждёт следующий чанк. */
  pending: string;
}

/** Начало mouse-последовательности: ESC, ESC[, ESC[<12;… — ждёт хвост. */
function isMousePrefix(fragment: string): boolean {
  if (!fragment.startsWith(ESC)) return false;
  const rest = fragment.slice(1);
  if (rest === "") return true;
  if (!rest.startsWith("[<")) return false;
  return /^[\d;]*$/.test(rest.slice(2));
}

/**
 * Выкусывает события мыши из сырого потока stdin (SGR-кодировка
 * `\x1b[<Cb;Cx;CyM/m`). Колесо (`M` + 64-й бит) — в `wheels`, клики
 * и отпускания (`m`) глотаются молча. Терминал может резать sequence
 * пополам между чанками: рваный хвост возвращается в `pending`,
 * вызывающий подклеивает его к следующему чанку.
 */
export function splitMouseEvents(buffer: string): SplitMouseEvents {
  const wheels: WheelDirection[] = [];
  let text = "";
  let lastEnd = 0;
  for (const match of buffer.matchAll(MOUSE_PATTERN)) {
    text += buffer.slice(lastEnd, match.index ?? 0);
    const code = Number(match[1] ?? 0);
    if (match[4] === "M" && (code & 64) !== 0)
      wheels.push(code & 1 ? "down" : "up");
    lastEnd = (match.index ?? 0) + match[0].length;
  }
  text += buffer.slice(lastEnd);
  const escIndex = text.lastIndexOf(ESC);
  if (escIndex !== -1 && isMousePrefix(text.slice(escIndex))) {
    return {
      text: text.slice(0, escIndex),
      wheels,
      pending: text.slice(escIndex),
    };
  }
  return { text, wheels, pending: "" };
}

export type WheelListener = (direction: WheelDirection) => void;

const wheelListeners = new Set<WheelListener>();

/**
 * Подписка на колесо мыши (отфильтрованные события). Возвращает отписку.
 * События издаёт фильтр из createMouseFilter; без него просто тихо.
 */
export function subscribeWheel(listener: WheelListener): () => void {
  wheelListeners.add(listener);
  return () => {
    wheelListeners.delete(listener);
  };
}

function emitWheel(direction: WheelDirection): void {
  for (const listener of wheelListeners) listener(direction);
}

/** Минимум настоящего stdin, нужный фильтру (удобно подменять в тестах). */
export interface MouseSourceStdin {
  isTTY?: boolean;
  setEncoding?(...args: unknown[]): unknown;
  on?(event: string, listener: (chunk: unknown) => void): void;
  off?(event: string, listener: (chunk: unknown) => void): void;
  setRawMode?(mode: boolean): void;
  ref?(): void;
  unref?(): void;
}

export interface MouseSourceStdout {
  write?(data: string): unknown;
  isTTY?: boolean;
}

/**
 * Вход Ink: Ink читает его через `readable`/`read()` и дёргает
 * `setRawMode`/`ref`/`unref` — всё пробрасывается в настоящий stdin.
 */
class FilteredStdin extends EventEmitter {
  readonly isTTY = true;
  private readonly real: MouseSourceStdin;
  private readonly queue: string[] = [];

  constructor(real: MouseSourceStdin) {
    super();
    this.real = real;
    this.setMaxListeners(Infinity);
  }

  setEncoding(): void {
    // Чанки всегда строки — кодировка уже учтена подающим.
  }

  setRawMode(mode: boolean): void {
    this.real.setRawMode?.(mode);
  }

  ref(): void {
    this.real.ref?.();
  }

  unref(): void {
    this.real.unref?.();
  }

  read(): string | null {
    const next = this.queue.shift();
    return next ?? null;
  }

  pushText(text: string): void {
    if (!text) return;
    this.queue.push(text);
    this.emit("readable");
  }
}

export interface MouseFilter {
  /** Поток для Ink: `render(дерево, { stdin: filter.stdin })`. */
  stdin: FilteredStdin;
  /** Снять подписку, выключить mouse-режим терминала. */
  dispose(): void;
}

/**
 * Вклинивает фильтр между настоящим stdin и Ink: включает SGR-режим мыши,
 * чистит поток от mouse-последовательностей, колесо отдаёт в onWheel
 * (по умолчанию — подписчикам subscribeWheel). Не-TTY — undefined,
 * вызывающий оставляет Ink на process.stdin, как раньше.
 */
export function createMouseFilter(options: {
  stdin: MouseSourceStdin;
  stdout: MouseSourceStdout;
  onWheel?: (direction: WheelDirection) => void;
}): MouseFilter | undefined {
  const { stdin, stdout, onWheel } = options;
  if (stdin?.isTTY !== true || typeof stdout?.write !== "function")
    return undefined;
  const notify = onWheel ?? emitWheel;
  const filtered = new FilteredStdin(stdin);
  let carry = "";
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flushCarry = (): void => {
    flushTimer = undefined;
    if (!carry) return;
    // Одинокий Esc (клавиша!) или оборванный хвост: дольше ждать нечего,
    // отдаём как есть — Ink разберёт сам.
    const stale = carry;
    carry = "";
    filtered.pushText(stale);
  };
  const armFlush = (): void => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushCarry, PENDING_FLUSH_MS);
    const unref = (flushTimer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(flushTimer);
  };
  const onData = (chunk: unknown): void => {
    const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    const split = splitMouseEvents(carry + text);
    carry = split.pending;
    for (const direction of split.wheels) notify(direction);
    filtered.pushText(split.text);
    if (carry) {
      if (carry.length > MAX_PENDING_CHARS) {
        const stale = carry;
        carry = "";
        filtered.pushText(stale);
      } else armFlush();
    }
  };
  stdin.setEncoding?.("utf8");
  stdout.write(MOUSE_ENABLE);
  stdin.on?.("data", onData);
  return {
    stdin: filtered,
    dispose: () => {
      stdin.off?.("data", onData);
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      try {
        stdout.write?.(MOUSE_DISABLE);
      } catch {
        // Выход и так закрывает экран — молча уходим.
      }
    },
  };
}
