import type { ExtensionContext } from "../extensions/contracts.js";
import type { UiAction } from "../extensions/ui-types.js";
import type { JsonObject } from "../types/domain.js";
import type { BrowserService } from "./service.js";

const tool = (id: string, label: string, target = id): UiAction => ({
  id,
  label,
  type: "tool",
  tool: target,
});

export function registerBrowserUi(
  ctx: ExtensionContext,
  service: BrowserService,
) {
  ctx.ui.on("address", (binding, event) => {
    if (event.type === "change")
      service.setPresentation(binding.conversationId, { draft: event.value });
  });
  ctx.ui.on("section", (binding, event, args) => {
    if (
      event.type === "press" &&
      (args?.page === "page" ||
        args?.page === "console" ||
        args?.page === "network")
    )
      service.setPresentation(binding.conversationId, { section: args.page });
  });
  ctx.ui.register({
    id: "browser",
    slot: "pane",
    placement: "sidebar",
    initiallyHidden: true,
    scope: "conversation",
    title: "Браузер",
    order: 30,
    actions: [
      tool("open", "Открыть адрес"),
      tool("install", "Установить Chromium"),
      tool("navigate", "Навигация"),
      tool("screenshot", "Сделать снимок"),
      tool("panel", "Закрыть панель"),
      {
        id: "section",
        label: "Диагностика",
        type: "event",
        eventId: "section",
      },
    ],
    source: {
      subscribe: (_binding, changed) => service.subscribe(changed),
      async snapshot(binding) {
        const initial = service.presentation(binding.conversationId);
        if (!initial.visible)
          return { revision: initial.revision, state: "ready", visible: false };
        const view = await service.view(binding.conversationId);
        const { draft, section, visible, revision } = service.presentation(
          binding.conversationId,
        );
        if (!visible) return { revision, state: "ready", visible: false };
        const url =
          draft ??
          (view.page?.url === "about:blank" ? "" : view.page?.url) ??
          "";
        const navigation = (
          label: string,
          action: string,
          rest: JsonObject = {},
        ) => ({
          type: "button" as const,
          key: `${action}-${String(rest.preset ?? rest.tab ?? "current")}`,
          label,
          disabled: view.busy,
          action: { id: "navigate", args: { action, ...rest } },
        });
        const state =
          view.runtime === "missing"
            ? "Chromium требуется установить"
            : view.runtime === "unavailable"
              ? "Доступно на Linux x64"
              : view.runtime === "recovery_required"
                ? "Очистка не подтверждена"
                : view.busy
                  ? "Выполняется действие…"
                  : view.page?.title ||
                    (view.page ? view.page.status : "Вкладок нет");
        return {
          revision: view.revision,
          state: "ready",
          render: {
            mode: "replace",
            content: {
              type: "box",
              direction: "column",
              children: [
                {
                  type: "text",
                  text: state,
                  bold: true,
                  tone: view.error ? "error" : undefined,
                },
                ...(view.error
                  ? [
                      {
                        type: "text" as const,
                        text: view.error,
                        tone: "error" as const,
                      },
                    ]
                  : []),
                {
                  type: "input",
                  key: "address",
                  label: "Адрес",
                  placeholder: "http://127.0.0.1:5173",
                  value: url,
                  maxLength: 2048,
                  onChange: { id: "address" },
                },
                {
                  type: "box",
                  direction: "row",
                  gap: 1,
                  children: [
                    {
                      type: "button",
                      label: "Открыть",
                      disabled: !url || view.busy || view.runtime !== "ready",
                      action: { id: "open", args: { url } },
                    },
                    ...(view.runtime === "missing"
                      ? [
                          {
                            type: "button" as const,
                            label: "Установить Chromium",
                            action: { id: "install" },
                          },
                        ]
                      : []),
                    {
                      type: "button",
                      label: "Скрыть",
                      action: { id: "panel" },
                    },
                  ],
                },
                ...(view.page
                  ? [
                      ...(url === view.page.url
                        ? []
                        : [
                            {
                              type: "text" as const,
                              text: view.page.url.slice(0, 160),
                              tone: "muted" as const,
                            },
                          ]),
                      {
                        type: "box" as const,
                        direction: "row" as const,
                        gap: 1,
                        children: [
                          navigation("Назад", "back"),
                          navigation("Обновить", "reload"),
                          navigation("Закрыть", "close"),
                        ],
                      },
                      ...(view.tabs.length > 1
                        ? [
                            {
                              type: "box" as const,
                              direction: "row" as const,
                              gap: 1,
                              children: view.tabs.map((tab, index) =>
                                navigation(
                                  `${tab.id === view.selected ? "● " : ""}${index + 1}`,
                                  "select",
                                  { tab: tab.id },
                                ),
                              ),
                            },
                          ]
                        : []),
                      {
                        type: "box" as const,
                        direction: "row" as const,
                        gap: 1,
                        children: [
                          navigation("Телефон", "viewport", {
                            preset: "phone",
                          }),
                          navigation("Планшет", "viewport", {
                            preset: "tablet",
                          }),
                          navigation("Десктоп", "viewport", {
                            preset: "desktop",
                          }),
                        ],
                      },
                      {
                        type: "box" as const,
                        direction: "row" as const,
                        gap: 1,
                        children: [
                          {
                            type: "text" as const,
                            text: `${view.page.viewport?.width} × ${view.page.viewport?.height}`,
                          },
                          {
                            type: "button" as const,
                            label: "Снимок",
                            disabled: view.busy,
                            action: { id: "screenshot" },
                          },
                        ],
                      },
                      {
                        type: "box" as const,
                        direction: "row" as const,
                        gap: 1,
                        children: [
                          ["page", "Страница"],
                          ["console", "Console"],
                          ["network", "Сеть"],
                        ].map(([page, label]) => ({
                          type: "button" as const,
                          key: page,
                          label: label ?? "",
                          tone:
                            page === section ? ("accent" as const) : undefined,
                          action: { id: "section", args: { page: page ?? "" } },
                        })),
                      },
                      ...(section === "page"
                        ? [
                            ...(view.preview
                              ? [
                                  {
                                    type: "image" as const,
                                    data: view.preview,
                                    alt: "Снимок Chromium",
                                    fit: "fit" as const,
                                    style: {
                                      width: "100%" as const,
                                      height: 8,
                                    },
                                  },
                                ]
                              : []),
                            {
                              type: "text" as const,
                              text: view.snapshot
                                ? `Горизонтальное переполнение: ${view.snapshot.overflow} px\n${view.snapshot.accessibility.slice(0, 350)}`
                                : "Снимок страницы пока недоступен.",
                              tone: "muted" as const,
                            },
                          ]
                        : [
                            {
                              type: "text" as const,
                              text:
                                (section === "console"
                                  ? view.console
                                  : view.network
                                )
                                  .map((row) =>
                                    [
                                      row.type,
                                      row.method,
                                      row.status,
                                      row.message ?? row.url,
                                    ]
                                      .filter(Boolean)
                                      .join(" "),
                                  )
                                  .join("\n")
                                  .slice(0, 500) || "Событий пока нет.",
                            },
                          ]),
                    ]
                  : [
                      {
                        type: "text" as const,
                        tone: "muted" as const,
                        text: "Укажите разрешённый адрес из browser.origins. Alt+U — фокус панели.",
                      },
                    ]),
              ],
            },
          },
        };
      },
    },
  });
}
