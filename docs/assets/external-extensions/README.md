# Native кадры внешнего SDK

[Отчёт](../../contributors/reports/external-extension-loader.md) · [SDK](../../extensions/README.md)

Сняты из ordinary production `runOpenTuiAgent` через `tests/fixtures/tui-external-extensions.ts`, без injected definition. Самостоятельный `.mjs` подготовлен после сборки harness, проверен и одобрен через настоящий user registry. Есть healthy package и recoverable activation failure.

Восемь каталогов: Obsidian/Graphite/Ember/Paper × Unicode/ASCII. Каждый содержит 11 кадров в TXT (`captureCharFrame`), JSON (`captureSpans`) и PNG (экспорт реальных spans через `scripts/render-terminal-captures.py`). Всего 88 кадров / 264 файлов. Details сняты при 160×50, 120×40, 80×24, 40×12 и 24×8. Остальные кадры показывают status/error, context, menu, permission approval, unavailable source на 24×8 и возврат draft.

Примеры: [details 80×24](ember-unicode/external-details-80x24.png), [details 24×8](paper-unicode/external-details-24x8.png), [approval](obsidian-ascii/external-approval-120x40.png), [меню](graphite-unicode/external-menu-160x50.png).

Минимальные размеры проверены на доступность списка, причины unavailable и «Назад». Ошибка page source создаётся в настоящем внешнем `.mjs`; readonly cache retry восстанавливает список без модели. Ручная проверка PNG охватывает все пять размеров, четыре темы, ASCII/Unicode, error и approval. Кадры не доказывают отсутствие arbitrary effects доверенного JavaScript; runtime assertions отдельно проверяют no model request при просмотре, обычную запись/checkpoint и восстановление черновика.
