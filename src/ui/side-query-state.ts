import type { ModelRequestStatus } from "../models/contracts.js";

export const sideStatus: Record<ModelRequestStatus, string> = {
  accepted: "Подготовка",
  preparing: "Подготовка",
  receiving: "Отвечает",
  completed: "Готово",
  failed: "Ошибка",
  cancelled: "Остановлено",
  timed_out: "Время истекло",
  truncated: "Ответ обрезан",
  interrupted: "Прервано после перезапуска",
};
