import type { ExtensionFactory, ToolDefinition, JsonObject } from "chiselcode/extension-sdk";

const factory: ExtensionFactory = ({ sdk, manifest }) => ({
  id: manifest.id, version: manifest.version, apiVersion: 1,
  activate(context) {
    let revision = 0;
    const subscribers = new Set<() => void>();
    const changed = () => { revision++; for (const callback of subscribers) callback(); };
    const subscribe = () => (_binding: unknown, callback: () => void) => { subscribers.add(callback); return { dispose: () => { subscribers.delete(callback); } }; };
    context.add({ dispose() { subscribers.clear(); } });
    const read: ToolDefinition<{ path: string }> = sdk.defineTool({
      name: "read_note", description: "Прочитать заметку проекта с сохранением свежей ревизии", effect: "read",
      inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false },
      prepare(invocation, input) { return invocation.plan.readText(input.path); },
      execute(invocation) { return invocation.effects.run(); },
    });
    const write = sdk.defineTool<{ path: string; content: string }>({
      name: "write_note", description: "Записать заметку после проверки свежести и разрешения", effect: "workspace_write", chat: { title: "Заметка", view: "note-card" },
      inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1 }, content: { type: "string", maxLength: 8192 } }, required: ["path", "content"], additionalProperties: false },
      prepare(invocation, input) { return invocation.plan.writeText(input.path, input.content); },
      async execute(invocation) { const result = await invocation.effects.run(); changed(); return result; },
    });
    context.tools.register(read); context.tools.register(write);
    context.commands.register({
      name: "notes-write", description: "Обновить заметку проекта", usage: "/notes-write <JSON path/content>",
      parse(args) { return JSON.parse(args) as { path: string; content: string }; },
      async execute(invocation, input) { await invocation.tools.execute(`ext:${manifest.id}:read_note`, { path: input.path }); return invocation.tools.execute(`ext:${manifest.id}:write_note`, input); },
    });
    context.commands.register({
      name: "notes", description: "Прочитать заметку проекта", usage: "/notes <relative-path>",
      parse(args) { if (!args.trim()) throw new Error("Укажите путь заметки."); return args.trim(); },
      execute(invocation, path) { return invocation.tools.execute(`ext:${manifest.id}:read_note`, { path }); },
    });
    context.commands.register({
      name: "notes-question", description: "Задать отдельный вопрос о заметках", executionPolicy: "side_query",
      parse(args) { return args.trim(); },
      execute(invocation, text) { return invocation.model.request({ text, context: "none", limits: { outputTokens: 64, deadlineMs: 5000 } }); },
    });
    context.contextProviders.register({ id: "notes", collect() { return { text: "Данные расширения заметок: штатное чтение и запись доступны." }; } });
    context.chat.register({ id: "note-card", render(data) { return { cards: [{ id: "note", revision, title: "Заметка обновлена", detail: typeof data === "object" ? "Результат сохранён штатным инструментом" : "Заметка", target: { type: "extension_view", viewId: "notes" }, actions: [{ label: "Открыть", action: "open", target: { type: "extension_view", viewId: "notes" } }] }] }; } });
    const actions = [{ id: "open", label: "Открыть", type: "view" as const, viewId: "notes" }];
    for (const slot of ["status", "context_section", "menu_entry"] as const) context.ui.register({
      id: slot.replace("_", "-"), slot, scope: "workspace", title: "Заметки проекта", group: "extensions", actions,
      source: { snapshot() { return { revision, state: "ready", label: "Заметки", count: revision, detail: "Разрешённое внешнее расширение", action: { id: "open" }, ...(slot === "context_section" ? { rows: [{ id: "root", label: "Проект", value: context.workspaceRoot }] } : {}) }; }, subscribe: subscribe() },
    });
    context.ui.registerView({ id: "notes", title: "Заметки проекта", scope: "workspace", actions: [{ id: "read", label: "Прочитать заметку", type: "tool", tool: "read_note" }, { id: "write", label: "Создать заметку", type: "tool", tool: "write_note" }],
      page(_binding, request) { const offset = Number(request.cursor ?? "0"); if (!Number.isInteger(offset) || offset < 0 || offset > 200) throw new Error("Некорректная страница."); return { revision, state: "ready", summary: "Внешний пакет использует общий renderer ChiselCode", fields: [{ id: "workspace", label: "Проект", value: context.workspaceRoot }], rows: Array.from({ length: Math.min(50, 150 - offset) }, (_, index) => ({ id: `note-${offset + index}`, label: `Заметка ${offset + index + 1}`, detail: "Длинный путь: материалы/проект/обсуждение/заметка.txt", action: { id: "read", args: { path: "note.txt" } as JsonObject } })), actions: [{ id: "write", args: { path: "ui-note.txt", content: "Заметка через внешний UI SDK\n" } }], ...(offset + 50 < 150 ? { nextCursor: String(offset + 50) } : {}) }; }, subscribe: subscribe(),
    });
  },
});
export default factory;
