import type { ExtensionContext } from "../contracts.js";
import type { UiBinding, UiCoreTarget, UiSnapshot } from "../ui-types.js";

/** Declarative consumers share the same owner-bound read cache. */
export function registerOwnerUi(
  ctx: ExtensionContext,
  kind: "background" | "agents",
  target: UiCoreTarget,
): void {
  let revision = 0;
  const title = kind === "background" ? "Фоновые задачи" : "Агенты";
  const compact = kind === "background" ? "Фон" : "Агенты";
  const source = {
    snapshot(binding: UiBinding): UiSnapshot {
      const value = binding.read.ownerSummary()[kind];
      const count = value.active;
      const awaiting =
        kind === "background" &&
        binding.read.ownerSummary().background.awaitingApproval > 0;
      return {
        revision: ++revision,
        state: count ? "ready" : "empty",
        count,
        label: `${compact} ${count}${value.errors ? " · ошибка" : awaiting ? " · разрешение" : ""}`,
        detail:
          kind === "background"
            ? "Процессы, вывод и результаты"
            : "Ход работы, изменения и результаты помощников",
        tone: value.errors
          ? "error"
          : awaiting
            ? "warning"
            : count
              ? "accent"
              : "muted",
        action: { id: "open" },
      };
    },
    subscribe(binding: UiBinding, changed: () => void) {
      return binding.read.subscribeOwner(changed);
    },
  };
  const actions = [
    { id: "open", label: "Открыть", type: "core" as const, target },
  ];
  ctx.ui.register({
    id: "status",
    slot: "status",
    scope: "conversation",
    title,
    order: kind === "background" ? 10 : 30,
    actions,
    source,
  });
  ctx.ui.register({
    id: "menu",
    slot: "menu_entry",
    scope: "conversation",
    title,
    description:
      kind === "background"
        ? "Процессы, вывод и результаты"
        : "Дерево помощников",
    group: "conversation",
    shortcut: kind === "background" ? "/tasks" : "F7",
    actions,
    source,
  });
}
