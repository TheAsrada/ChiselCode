import { createHash } from "node:crypto";
import type { LspService, LspUiStatus } from "../../lsp/service.js";
import type { ExtensionContext } from "../contracts.js";
import type { UiRow, UiSnapshot } from "../ui-types.js";

function state(value: LspUiStatus): UiSnapshot["state"] {
  return value.state === "error" || value.state === "unavailable"
    ? "error"
    : value.staleDocuments || value.requiresRestart
      ? "stale"
      : !value.checkedDocuments
        ? "empty"
        : "ready";
}
function label(value: LspUiStatus): string {
  const mode = {
    auto: "Auto",
    custom: "Custom",
    off: "Off",
    unknown: "неизвестно",
  }[value.mode];
  return `LSP ${mode} · ${value.state === "error" ? "ошибка" : value.staleDocuments ? "устарел" : !value.checkedDocuments ? "нет проверок" : value.diagnosticCount ? `${value.diagnosticCount} замечаний` : value.observedDocuments ? "наблюдается" : "проверено"}`;
}
function diagnostics(value: LspUiStatus): UiRow[] {
  const duplicates = new Map<string, number>();
  return value.diagnostics.map((item) => {
    const hash = createHash("sha256")
      .update(JSON.stringify([item.path, item.range, item.message, item.code]))
      .digest("hex")
      .slice(0, 20);
    const index = duplicates.get(hash) ?? 0;
    duplicates.set(hash, index + 1);
    return {
      id: `diagnostic-${hash}-${index}`,
      label:
        `${item.path}:${item.range.start.line + 1}:${item.range.start.character + 1}`.slice(
          0,
          120,
        ),
      value: item.message,
      detail:
        `${item.path}\nСтрока ${item.range.start.line + 1}, колонка ${item.range.start.character + 1} (UTF-16)\n${item.message}`.slice(
          0,
          2000,
        ),
      tone:
        item.severity === 1
          ? "error"
          : item.severity === 2
            ? "warning"
            : "muted",
    };
  });
}
export function registerLspUi(
  ctx: ExtensionContext,
  service: LspService,
): void {
  const actions = [
    {
      id: "open",
      label: "Открыть подробности",
      type: "view" as const,
      viewId: "analysis",
    },
  ];
  const source = {
    snapshot(): UiSnapshot {
      const value = service.uiStatus();
      return {
        revision: value.revision,
        state: state(value),
        label: label(value),
        count: value.diagnosticCount,
        tone:
          state(value) === "error"
            ? "error"
            : state(value) === "stale"
              ? "warning"
              : "muted",
        detail: value.requiresRestart
          ? "Нужен явный перезапуск"
          : value.staleDocuments
            ? "Данные устарели; дождитесь штатной проверки"
            : !value.checkedDocuments
              ? "Файлы ещё не проверены"
              : value.observedDocuments
                ? "Наблюдаемые диагностики не доказывают актуальное отсутствие ошибок"
                : `Проверено файлов: ${value.checkedDocuments}`,
        rows: diagnostics(value).slice(0, 8),
        action: { id: "open" },
      };
    },
    subscribe(_binding: unknown, changed: () => void) {
      return service.subscribeUi(changed);
    },
  };
  for (const slot of ["status", "context_section", "menu_entry"] as const)
    ctx.ui.register({
      id: slot,
      slot,
      scope: "workspace",
      title: "Анализ кода",
      group: "project",
      order: 20,
      actions,
      source,
    });
  ctx.ui.registerView({
    id: "analysis",
    scope: "workspace",
    title: "Анализ кода",
    actions: [
      {
        id: "restart",
        label: "Перезапустить LSP",
        type: "tool",
        tool: "restart",
      },
    ],
    page(_binding, request) {
      const value = service.uiStatus();
      const all = diagnostics(value).filter(
        (row) =>
          !request.search ||
          `${row.label} ${row.value}`
            .toLocaleLowerCase()
            .includes(request.search.toLocaleLowerCase()),
      );
      const cursor = Math.max(
        0,
        Math.min(all.length, Number(request.cursor) || 0),
      );
      return {
        revision: value.revision,
        state: state(value),
        summary: source.snapshot().detail,
        fields: [
          { id: "mode", label: "Режим", value: label(value) },
          {
            id: "backend",
            label: "Backend",
            value: {
              unknown: "Неизвестно",
              disabled: "Выключен",
              untrusted: "Нужно доверие к настройке",
              unavailable: "Недоступен",
              stopped: "Не запущен",
              starting: "Запускается",
              ready: "Работает",
              restarting: "Перезапускается",
              error: "Ошибка",
              disposed: "Закрыт",
            }[value.state],
          },
          { id: "root", label: "Проект", value: value.workspaceRoot },
          {
            id: "documents",
            label: "Файлы",
            value: `${value.trackedDocuments} отслеживается · ${value.checkedDocuments} проверено · ${value.staleDocuments} устарело`,
          },
          {
            id: "generation",
            label: "Поколение",
            value: `${value.generation}`,
          },
        ],
        rows: all.slice(cursor, cursor + 64),
        ...(cursor + 64 < all.length
          ? { nextCursor: String(cursor + 64) }
          : {}),
        actions:
          value.mode === "off" ||
          value.state === "unavailable" ||
          value.state === "disposed"
            ? []
            : [{ id: "restart", args: {} }],
      };
    },
    subscribe: source.subscribe,
  });
  // Configuration cache warm-up is activation work; it never prepares an analysis backend.
  void service.refreshConfiguration().catch(() => {});
}
