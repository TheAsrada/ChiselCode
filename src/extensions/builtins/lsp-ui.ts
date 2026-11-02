import { createHash } from "node:crypto";
import type { LspService, LspUiStatus } from "../../lsp/service.js";
import type { ExtensionContext } from "../contracts.js";
import { lspUiTarget } from "../ui-core.js";
import type { UiRow, UiSnapshot } from "../ui-types.js";

function state(value: LspUiStatus): UiSnapshot["state"] {
  if (value.state === "disabled") return "empty";
  if (value.state === "starting" || value.state === "restarting")
    return "loading";
  return value.state === "unavailable" || value.state === "disposed"
    ? "unavailable"
    : value.state === "error"
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
  if (value.state === "starting") return `LSP ${mode} · запускается`;
  if (value.state === "restarting") return `LSP ${mode} · перезапускается`;
  if (value.state === "stopped" && !value.checkedDocuments)
    return `LSP ${mode} · ждёт запроса`;
  return `LSP ${mode} · ${value.state === "disabled" ? "выключен" : value.state === "unavailable" ? "недоступен" : value.state === "disposed" ? "закрыт" : value.state === "untrusted" ? "нужно доверие" : value.state === "error" ? "ошибка" : value.staleDocuments ? "устарел" : !value.checkedDocuments ? "нет проверок" : value.diagnosticCount ? `${value.diagnosticCount} замечаний` : value.observedDocuments ? "наблюдается" : "проверено"}`;
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
      label: "Анализ кода · LSP",
      type: "core" as const,
      target: lspUiTarget,
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
        tone: ["error", "unavailable"].includes(state(value))
          ? "error"
          : state(value) === "stale"
            ? "warning"
            : "muted",
        detail:
          value.state === "disabled"
            ? "Анализ кода выключен в настройках"
            : value.state === "starting" || value.state === "restarting"
              ? "Сервер запускается; дождитесь завершения initialize"
              : state(value) === "unavailable"
                ? "Анализ недоступен; откройте сведения и проверьте настройку"
                : state(value) === "error"
                  ? "Ошибка анализа; откройте сведения для явного восстановления"
                  : value.state === "untrusted"
                    ? "Нужно доверие к настройке анализа кода"
                    : value.requiresRestart
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
      title: "Анализ кода · LSP",
      group: "project",
      order: 20,
      actions,
      source,
    });
  // Configuration cache warm-up is activation work; it never prepares an analysis backend.
  void service.refreshConfiguration().catch(() => {});
}
