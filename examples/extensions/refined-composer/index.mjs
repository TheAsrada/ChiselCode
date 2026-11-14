export default ({ manifest }) => ({
  id: manifest.id,
  version: manifest.version,
  apiVersion: 1,
  entry: manifest.entry,
  activate(ctx) {
    ctx.ui.register({
      id: "composer-wrapper",
      slot: "render",
      surfaces: ["Composer"],
      scope: "conversation",
      title: "Оформление строки ввода",
      order: 45,
      source: {
        snapshot() {
          return {
            revision: 1,
            state: "ready",
            render: {
              mode: "replace",
              content: {
                type: "native",
                props: {
                  title: " Refined Composer ",
                  placeholder: "С чем помочь?",
                  border: true,
                  borderStyle: "rounded",
                  borderColor: "accent",
                  padding: 1,
                  bg: "raised",
                  fg: "text",
                },
              },
            },
          };
        },
      },
    });
    ctx.ui.register({
      id: "prompt-hints-wrapper",
      slot: "render",
      surfaces: ["PromptHints"],
      scope: "conversation",
      title: "Цвет подсказок",
      order: 45,
      source: {
        snapshot() {
          return {
            revision: 1,
            state: "ready",
            render: {
              mode: "replace",
              content: { type: "native", props: { fg: "green" } },
            },
          };
        },
      },
    });
  },
});
