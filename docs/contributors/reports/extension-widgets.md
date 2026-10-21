# Интерактивные расширения и события агента

[Материалы для участников](../README.md) · [Пользовательское руководство](../../ui-mods.md) · [SDK UI](../../extensions/interactive-ui.md) · [События](../../extensions/agent-events.md)

Текущие исходники **Unreleased**, поверх CLI 0.6.37. Выпуск в рамках этой задачи не запрашивался. Реализация сохраняет API v1 и обычные trust/permissions/owner lifecycles; новые пакеты объявляют необходимые capabilities до импорта.

## Реализовано

- Поля, выбор, локальные callbacks, клавиатура, самостоятельные панели, Markdown/код, bytes-only изображения и цветные интерактивные области.
- Локальные стили и свойства штатного ввода; обязательные input/error owners и защищённые подтверждения сохраняются.
- Цепочки событий сообщений, модели и инструментов; перезапись до проверок, явный синтетический ответ, наблюдатели, отмена и durable replay.
- Сохранение фактического результата перед post-effect hook, честный usage при перенаправлении запроса, одинаковый итог response filter в истории и ленте.
- Обновлён встроенный `extension-creator`; готовый внешний пакет «Студия заметок» устанавливается прежним managed installer и активируется после доверия.

## Настоящие кадры OpenTUI

Сценарий `tests/fixtures/tui-extension-widgets.ts` устанавливает reviewed внешний пакет, запускает production `runOpenTuiAgent` и использует настоящий OpenTUI renderer/controller. JSON — `captureSpans()`, TXT — terminal frame. PNG экспортирует `scripts/render-terminal-captures.py` без перерисовки или изменения содержимого. Тестовый пакет дополняет пример маленьким PNG и кнопкой, чей handler намеренно падает; обычный пример не содержит этой ошибки.

| Сценарий | Кадр | Исходные данные |
| --- | --- | --- |
| Панель формы, код, карта и штатный ввод | [Тёмная тема](../../assets/extension-widgets/obsidian-form-wide.png) | [JSON](../../assets/extension-widgets/obsidian-form-wide.json) |
| Поле с Unicode и сохранённый черновик чата | [Фокус формы](../../assets/extension-widgets/obsidian-form-focused.png) | [TXT](../../assets/extension-widgets/obsidian-form-focused.txt) |
| Markdown и выбранный приоритет | [Просмотр](../../assets/extension-widgets/obsidian-preview.png) | [TXT](../../assets/extension-widgets/obsidian-preview.txt) |
| Настоящее подтверждение записи | [Подтверждение](../../assets/extension-widgets/obsidian-approval.png) | [TXT](../../assets/extension-widgets/obsidian-approval.txt) |
| Перенос панели, 52×30 | [Узкий экран](../../assets/extension-widgets/obsidian-narrow.png) | [JSON](../../assets/extension-widgets/obsidian-narrow.json) |
| Ошибка callback, штатный ввод доступен | [Ошибка](../../assets/extension-widgets/obsidian-callback-error.png) | [TXT](../../assets/extension-widgets/obsidian-callback-error.txt) |
| Светлая тема | [Форма](../../assets/extension-widgets/paper-form-wide.png) | [JSON](../../assets/extension-widgets/paper-form-wide.json) |
| Светлая тема на узком экране | [Узкий экран](../../assets/extension-widgets/paper-narrow.png) | [TXT](../../assets/extension-widgets/paper-narrow.txt) |

## Проверки

Результаты окончательных прогонов и CI добавляются после завершения проверок этого source. Уже выполнен полный внешний UI-сценарий на Linux для Obsidian и Paper: ввод/выбор/вкладки, Markdown/code, native image decode, mouse/key canvas, approval перед реальной записью, перенос панели, сохранение черновика и callback fallback. Взаимодействия не запускают запрос к модели или сети.

Для воспроизведения кадров:

```bash
CHISEL_WIDGET_CAPTURES=docs/assets/extension-widgets bun tests/fixtures/tui-extension-widgets.ts
CHISEL_CAPTURE_THEME=paper CHISEL_WIDGET_CAPTURES=docs/assets/extension-widgets bun tests/fixtures/tui-extension-widgets.ts
python3 scripts/render-terminal-captures.py docs/assets/extension-widgets
```
