// Self-contained ESM: no React, renderer imports, npm resolution or build step.
export default ({ manifest, sdk }) => ({
  id: manifest.id, version: manifest.version, apiVersion: 1, entry: manifest.entry,
  async activate(ctx) {
    let revision = 1;
    const settings = await sdk.settings.read();
    const actions = [{ id: "details", label: "Открыть сведения", type: "view", viewId: "details" }];
    ctx.ui.registerView({
      id: "details", title: "Мой рабочий стол", scope: "conversation",
      page(binding) {
        return { revision: 1, state: "ready", summary: "Расширение включено без перезапуска ChiselCode.", fields: [{ id: "root", label: "Проект", value: binding.workspaceRoot }] };
      },
    });
    ctx.ui.register({
      id: "banner", slot: "render", surfaces: ["AbovePrompt"], scope: "conversation", title: "Рабочий стол", actions,
      source: {
        snapshot(binding) {
          const owner = binding.read.ownerSummary();
          return { revision, state: "ready", render: { mode: "replace", content: {
            type: "box", direction: "row", gap: 1, border: true, tone: "accent", children: [
              { type: "text", text: String(settings.title), tone: "accent", bold: true },
              { type: "text", text: `Фон: ${owner.background.active} | Помощники: ${owner.agents.active}`, tone: "muted" },
              { type: "button", label: "Сведения", action: { id: "details" } },
            ],
          } } };
        },
        subscribe(binding, changed) { return binding.read.subscribeOwner(() => { revision++; changed(); }); },
      },
    });
    ctx.ui.register({
      id: "logo", slot: "render", surfaces: ["HomeLogo"], scope: "workspace", title: "Логотип",
      source: { snapshot() { return { revision: 1, state: "ready", render: { mode: "replace", content: { type: "text", text: "[i] " + settings.title, tone: "accent", bold: true } } }; } },
    });
    if (settings.compact) ctx.ui.register({
      id: "messages", slot: "render", surfaces: ["AssistantMessage"], scope: "conversation", title: "Компактные ответы",
      source: { snapshot() { return { revision: 1, state: "ready", render: { mode: "replace", content: { type: "box", padding: 1, children: [{ type: "text", text: "Ответ агента", tone: "accent", bold: true }, { type: "value", field: "text", maxLength: 20000 }] } } }; } },
    });
    ctx.ui.register({
      id: "quiet-hints", slot: "render", surfaces: ["PromptHints"], scope: "workspace", title: "Краткая подсказка",
      source: { snapshot() { return { revision: 1, state: "ready", render: { mode: "replace", content: { type: "text", text: "Enter отправить | Alt+U действия расширений", tone: "muted" } } }; } },
    });
  },
});
