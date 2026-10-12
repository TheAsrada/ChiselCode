import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  type ChiselExtension,
  defineTool,
  type UiBinding,
  type UiSnapshot,
} from "../../src/extensions/index.js";

/** Independent linked consumer. Only the supported linked exports are imported. */
export function uiExtension(id = "fixture.interface") {
  let revision = 1;
  let writes = 0;
  let reads = 0;
  let unavailable = false;
  const subscribers = new Set<() => void>();
  const actions = [
    { id: "open", label: "Открыть", type: "view" as const, viewId: "report" },
  ];
  const source = {
    snapshot(binding: UiBinding): UiSnapshot {
      ++reads;
      if (unavailable)
        throw new Error("token=must-never-appear\x1b]52;c;payload\x07");
      return {
        revision,
        state: "ready",
        label: "Обзор 240",
        count: 240,
        detail: binding.sessionId
          ? "Данные текущего разговора"
          : "Беседа ещё не сохранена",
        rows: [
          {
            id: "one",
            label: "Независимое расширение",
            value: "Готово к просмотру",
          },
        ],
        action: { id: "open" },
      };
    },
    subscribe(_binding: UiBinding, changed: () => void) {
      subscribers.add(changed);
      return {
        dispose: () => {
          subscribers.delete(changed);
        },
      };
    },
  };
  const extension: ChiselExtension = {
    id,
    activate(ctx) {
      for (const slot of ["status", "context_section", "menu_entry"] as const)
        ctx.ui.register({
          id: slot,
          slot,
          scope: "conversation",
          title: "Обзор расширения",
          description: "Выбор строки и собственное действие",
          actions,
          source,
        });
      ctx.ui.registerView({
        id: "report",
        title: "Обзор расширения",
        scope: "conversation",
        actions: [
          { id: "write", label: "Сохранить выбор", type: "tool", tool: "save" },
        ],
        page(_binding, request) {
          const rows = Array.from({ length: 240 }, (_, index) => ({
            id: `row-${index}`,
            label: `Проверка ${index + 1} · src/очень-длинный-путь/界面/обновление-интерфейса.ts`,
            value: "Проверено",
            detail: `Подробности проверки ${index + 1}`,
            action: { id: "write", args: { value: `Проверка ${index + 1}` } },
          }));
          const filtered = rows.filter(
            (row) => !request.search || row.label.includes(request.search),
          );
          const offset = Math.max(0, Number(request.cursor) || 0);
          return {
            revision,
            state: "ready",
            summary: "Данные расширения. Просмотр не запускает модель.",
            rows: filtered.slice(offset, offset + 64),
            ...(offset + 64 < filtered.length
              ? { nextCursor: String(offset + 64) }
              : {}),
          };
        },
        subscribe: source.subscribe,
      });
      ctx.tools.register(
        defineTool(
          {
            name: "save",
            description: "Сохранить выбранную проверку",
            effect: "workspace_write",
            permission: "write",
            parallelSafe: false,
          },
          z.object({ value: z.string().max(100) }).strict(),
          async (context, input) => ({
            data: {
              path: await context.workspace.resolve("ui-result.txt"),
              value: input.value,
            },
            resources: [await context.workspace.resolve("ui-result.txt")],
            preview: `Сохранить выбор: ${input.value}`,
          }),
          async (_context, plan) => {
            await writeFile(plan.data.path, plan.data.value);
            ++writes;
            return { output: "Выбор сохранён" };
          },
        ),
      );
    },
  };
  return {
    extension,
    reads: () => reads,
    writes: () => writes,
    subscribers: () => subscribers.size,
    update(fail = false) {
      unavailable = fail;
      ++revision;
      for (const changed of subscribers) changed();
    },
  };
}
