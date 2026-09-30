import type { ProviderKind } from "../types/domain.js";
export interface TuiSettingsValues {
  provider: ProviderKind;
  profileId?: string;
  model: string;
  baseUrl?: string;
  /**
   * Новый ключ, введённый прямо здесь (на экране виден только маской).
   * Пусто — оставить сохранённый. В конфиг никогда не пишется открытым
   * текстом: cli сохраняет его в зашифрованное хранилище под apiKeyRef.
   */
  apiKey?: string;
}

/** Вариант модели в списке выбора: id + необязательная подсказка. */
export interface ModelOption {
  id: string;
  hint?: string;
}

export type ModelListResult =
  | { ok: true; models: ModelOption[] }
  | { ok: false; error: string };

/** Сколько строк списка моделей видно разом: остальное — счётчиком. */
export const MAX_VISIBLE_MODELS = 8;

/**
 * Текущая модель — первой и помечается ✓, остальные по алфавиту.
 * Чистая функция для тестов и стабильного порядка при каждом открытии.
 */
export function sortModelOptions(
  models: ModelOption[],
  current?: string,
): ModelOption[] {
  const normalized = (current ?? "").trim();
  return [...models].sort((a, b) => {
    const aCurrent = a.id === normalized ? 0 : 1;
    const bCurrent = b.id === normalized ? 0 : 1;
    if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    return a.id.localeCompare(b.id);
  });
}

/** Поиск по списку: подстрока без учёта регистра по id и подсказке. */
export function filterModelOptions(
  models: ModelOption[],
  query: string,
): ModelOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(needle) ||
      (model.hint ?? "").toLowerCase().includes(needle),
  );
}
