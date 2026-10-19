# Главная без служебных кнопок

[Реализация и проверки](../../contributors/reports/clean-navigation.md) · [Панель сеанса](../../design/sidebar.md)

Это кадры настоящего OpenTUI 0.5.12. PNG экспортированы из `captureSpans` скриптом `scripts/render-terminal-captures.py`; одноимённые JSON сохраняют native spans, TXT — `captureCharFrame` с исходным заполнением строк.

| Сценарий | Obsidian | Paper |
| --- | --- | --- |
| Главная без технических кнопок | [PNG](obsidian-home.png) | [PNG](paper-home.png) |
| Автоматическая панель чата | [PNG](obsidian-chat.png) | [PNG](paper-chat.png) |
| Состояния сервисов по F9 | [PNG](obsidian-services.png) | [PNG](paper-services.png) |
| Узкий чат, 80×24 | [PNG](obsidian-narrow.png) | [PNG](paper-narrow.png) |

Главная и F9 сняты через обычный `runOpenTuiAgent` в `tests/fixtures/tui-ui-contributions.ts` с реестром встроенных возможностей. Кадры чата и узкого окна сняты native renderer в `tests/unit/opentui-sidebar.test.tsx`; тест переключает настоящие `TuiWorkspace`/`TuiController`, проверяет фокус и черновик. Это fixture-данные; внешняя модель для снимков не вызывалась.
