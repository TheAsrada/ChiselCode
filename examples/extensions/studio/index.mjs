// Self-contained SDK consumer. No renderer imports or global listeners.
export default ({ sdk, manifest }) => ({
  id: manifest.id, version: manifest.version, apiVersion: 1, entry: manifest.entry,
  activate(ctx) {
    let revision = 1;
    const states = new Map();
    const listeners = new Set();
    const state = binding => {
      const id = binding.conversationId ?? "workspace";
      if (!states.has(id)) states.set(id, {text: "Проверить архитектуру расширений", priority: "normal", tab: "edit", cell: -1});
      return states.get(id);
    };
    const changed = () => { ++revision; for (const listener of listeners) listener(); };
    ctx.ui.on("note", (binding, event) => {if (event.type === "change" || event.type === "submit") {state(binding).text = event.value; changed();}});
    ctx.ui.on("priority", (binding, event) => {if (event.type === "select") {state(binding).priority = event.value; changed();}});
    ctx.ui.on("tab", (binding, _event, args) => {state(binding).tab = args.tab === "preview" ? "preview" : "edit"; changed();});
    ctx.ui.on("map", (binding, event) => {
      if (event.type === "pointer") state(binding).cell = Math.min(7, Math.floor(event.x / 3));
      if (event.type === "key" && event.name === "right") state(binding).cell = (state(binding).cell + 1) % 8;
      changed();
    });
    ctx.tools.register(sdk.defineTool({
      name: "save_note", description: "Сохранить заметку из панели", effect: "workspace_write",
      inputSchema: {type: "object", properties: {text: {type: "string", maxLength: 1000}}, required: ["text"], additionalProperties: false},
      prepare(invocation, input) {return invocation.plan.writeText("studio-note.md", `${input.text}\n`);},
      execute(invocation) {return invocation.effects.run();}
    }));
    ctx.ui.register({
      id: "studio", slot: "pane", placement: "sidebar", scope: "conversation", title: "Студия заметок",
      actions: [{id: "tab", label: "Вкладка", type: "event", eventId: "tab"}, {id: "save", label: "Сохранить", type: "tool", tool: "save_note"}],
      source: {
        snapshot(binding) {
          const data = state(binding);
          return {revision, state: "ready", render: {mode: "replace", content: {
            type: "box", style: {padding: 1, gap: 1}, children: [
              {type: "text", text: "Рабочая заметка", style: {bold: true, fg: "accent"}},
              {type: "box", direction: "row", gap: 1, children: [
                {type: "button", key: "edit", label: "Правка", action: {id: "tab", args: {tab: "edit"}}},
                {type: "button", key: "preview", label: "Просмотр", action: {id: "tab", args: {tab: "preview"}}}
              ]},
              ...(data.tab === "edit" ? [
                {type: "input", key: "note", label: "Текст заметки", value: data.text, maxLength: 1000, onChange: {id: "note"}, onSubmit: {id: "note"}},
                {type: "select", key: "priority", label: "Приоритет", value: data.priority, options: [{value: "normal", label: "Обычный"}, {value: "high", label: "Высокий"}], onSelect: {id: "priority"}}
              ] : [{type: "markdown", text: `### Заметка\n${data.text}\n\n**Приоритет:** ${data.priority === "high" ? "Высокий" : "Обычный"}`}]),
              {type: "code", text: JSON.stringify({priority: data.priority, selected: data.cell}, null, 2), language: "json"},
              {type: "text", text: "Карта · мышь или →", style: {fg: "muted"}},
              {type: "canvas", key: "map", label: "Карта", onPointer: {id: "map"}, onKey: {id: "map"}, rows: [Array.from({length: 8}, (_, index) => ({text: "   ", bg: data.cell === index ? "accent" : index % 2 ? "green" : "raised"}))]},
              {type: "button", key: "save", label: "Сохранить заметку", hotkey: "alt+s", action: {id: "save", args: {text: data.text}}, tone: "accent"},
              {type: "text", text: "Tab — следующий элемент · Esc — в чат", style: {fg: "muted", dim: true}}
            ]
          }}};
        },
        subscribe(_binding, listener) {listeners.add(listener); return {dispose() {listeners.delete(listener);}};}
      }
    });
    ctx.ui.register({id: "composer", slot: "render", surfaces: ["Composer"], scope: "conversation", title: "Ввод студии", source: {snapshot() {
      return {revision: 1, state: "ready", render: {mode: "replace", content: {type: "native", props: {title: "Задача · Studio", borderStyle: "single", borderColor: "accent", padding: 1, placeholder: "Продолжить работу над проектом…"}}}};
    }}});
    ctx.add({dispose() {listeners.clear(); states.clear();}});
  }
});
