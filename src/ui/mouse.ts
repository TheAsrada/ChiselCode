/**
 * Мышь в alt-screen как у Claude Code fullscreen (SGR 1006).
 *
 * Ink 7.1.1 трекинг не включает и SGR не парсит, но целую SGR-последовательность
 * (`ESC[<b;x;yM/m`) его input-parser отдаёт одним событием, а `useInput`
 * — строкой без ведущего ESC (`[<b;x;yM/m`, см. strip в `use-input.js`).
 * Поэтому достаточно включить репортинг escape-последовательностями
 * и разобрать колесо самим в обработчике ввода.
 *
 * Включаем только press+wheel (`1000`), БЕЗ motion (`1002/1003`): иначе
 * терминал спамит событиями движения и убивает нативное выделение даже
 * через Shift. Колесо: кнопки 64 (вверх) / 65 (вниз), модификаторы
 * Shift+4/Alt+8/Ctrl+16 снимаются маской.
 */

export const SGR_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const SGR_DISABLE = "\x1b[?1006l\x1b[?1000l";

/** Скорость колеса по умолчанию: строк на щелчок (как vim-шаг 3 у Claude). */
export const DEFAULT_SCROLL_SPEED = 3;
export const MAX_SCROLL_SPEED = 20;

export type MouseKind = "wheel-up" | "wheel-down" | "other";

export interface MouseAction {
  kind: MouseKind;
  shift: boolean;
}

/**
 * Разбирает SGR-последовательность мыши (уже без ведущего ESC).
 * Возвращает undefined для не-мышиных строк (обычный ввод).
 * Чистая функция для тестов.
 */
export function parseSGRMouse(input: string): MouseAction | undefined {
  const match = /^\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (!match) return undefined;
  const button = Number(match[1]);
  if (!Number.isFinite(button)) return undefined;
  const shift = (button & 4) !== 0;
  // Снимаем модификаторы Shift/Alt/Ctrl (4/8/16), оставляем базу.
  const base = button & ~28;
  if (base === 64) return { kind: "wheel-up", shift };
  if (base === 65) return { kind: "wheel-down", shift };
  return { kind: "other", shift };
}

/**
 * Строк колеса из окружения (`CHISEL_SCROLL_SPEED`, как
 * `CLAUDE_CODE_SCROLL_SPEED`): целые 1..20, иначе дефолт.
 * Чистая функция для тестов.
 */
export function resolveScrollSpeed(env: string | undefined): number {
  const parsed = Math.floor(Number(env));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_SCROLL_SPEED;
  return Math.min(parsed, MAX_SCROLL_SPEED);
}

/**
 * В Windows нативное выделение и вставка важнее захвата кликов; захват
 * включается явно через `CHISEL_MOUSE_CAPTURE=1`. Остальные платформы
 * сохраняют скролл мышью. `CHISEL_NO_MOUSE=1` и
 * `CHISEL_DISABLE_MOUSE=1` всегда отключают захват.
 */
export function shouldEnableMouse(
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
): boolean {
  if (env.CHISEL_NO_MOUSE === "1" || env.CHISEL_DISABLE_MOUSE === "1")
    return false;
  // Windows Terminal and conhost own drag-selection and right-click
  // copy/paste. SGR 1000 consumes those clicks before the host sees them.
  // Keep capture available for users who prefer wheel scrolling in the app.
  return platform !== "win32" || env.CHISEL_MOUSE_CAPTURE === "1";
}
