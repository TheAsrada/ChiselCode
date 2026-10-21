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

Код приложения: [`4f54c6d`](https://github.com/TheAsrada/ChiselCode/commit/4f54c6dfcdbde682f44dbec05c0aea1f9fa3f64f). Последующий [`6dcb1c4`](https://github.com/TheAsrada/ChiselCode/commit/6dcb1c4d433f64253e567fbb3e05ee6db5c7ff4a) изменяет только fixture, выбор платформы CI и документацию, не runtime/UI. Локальная среда — Linux x64, Bun 1.4.3; CI использует Bun 1.4.2.

Локально прошли быстрый профиль (428 tests), typecheck, lint и CLI/SDK build. Lint завершился без ошибок, с предупреждениями. Отдельно проверены middleware, model port, отмена observer и post-effect hook, durable replay, capabilities/редакция ключей, фокус и разделение повторяющихся полей. После исправления identity редактора полностью прошли три затронутых файла Settings/forms/side-query: 10 tests, 88 assertions.

Installed и compiled external SDK smoke на Linux проверили отдельный TypeScript consumer публичных declarations, точное доверие пакету, чтение/запись/Plan, model/tool hooks и coding-помощника, отказ изменённым bytes и восстановление после raw exit. Compiled UI smoke проверил реальную загрузку нового внешнего пакета, Input/Select, Markdown/code/image/canvas и cleanup. Полный внешний UI-сценарий выполнен для Obsidian и Paper: approval перед реальной записью, перенос панели, сохранение черновика и callback fallback. Взаимодействия не запускают запрос к модели или сети.

| CI | Source и результат |
| --- | --- |
| [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/39537558185) | Успешно: fast tests, typecheck, lint, build, запуск CLI. |
| [Quick CI после изменения fixture](https://github.com/TheAsrada/ChiselCode/actions/runs/39538912853) | `6dcb1c4`: успешно. |
| [Full source — Linux](https://github.com/TheAsrada/ChiselCode/actions/runs/39537560942) | 1331 pass, 3 skip, 0 fail; 11897 assertions, 169 файлов, 326,40 с. Все 14 eval-сценариев и отдельные source UI-fixtures успешно завершены. |
| Native smoke — Linux | Успешно: installed/compiled SDK и runtime, native OpenTUI, creator, Settings и новые widgets. |
| Native smoke — macOS arm64 | Успешно: платформенные файлы, installed/compiled runtime и UI. |
| [Native smoke — Windows x64](https://github.com/TheAsrada/ChiselCode/actions/runs/39538915609) | `6dcb1c4`: 316 pass, 1 skip, 0 fail, 2457 assertions, 41 файл, 194,00 с. Настоящий NSIS updater, installed/compiled SDK/runtime и все UI smoke успешны; весь job занял 601 с. |

Обе Windows попытки на `4f54c6d` не дождались большого readonly-субагента за 30 секунд: `control.wait` вернул `running` без ошибки child. Один повтор на том же source воспроизвёл отказ, после чего повторы остановлены. Сценарий выполняет 104 чтения, 27 генераций, настоящее сжатие и многочисленные atomic checkpoints большой родительской истории. На предшествующем source тот же неизменённый тест прошёл за 25,59 с — рядом с границей 30 с.

В `6dcb1c4` ожидание fixture ограничено 40 с внутри прежнего внешнего deadline 45 с; success по-прежнему требует завершения, точных counts, реальных чтений, compaction, usage и полного artifact. Добавлены измеренное время и диагностика прогресса при сбое. Production deadlines, ограничения и проверки storage/cleanup не менялись. Локально сценарий завершился за 6,34 с ожидания. Для повторной проверки Windows выбран новый точечный native run; успешные Linux/macOS jobs и полный source не повторялись ради изменения одного fixture. Этот точечный run не заменяет обязательный `platform=all` перед будущим релизом.

На Windows в итоговом прогоне весь этот тест завершился за 23,01 с. Это измерение вместе с предыдущими 25,59 с и двумя незавершёнными ожиданиями по 30 с показывает разброс длительности; утверждение о конкретной системной причине задержек runner не делается.

Первый завершённый [Native run на `0abca1d`](https://github.com/TheAsrada/ChiselCode/actions/runs/39536932757) нашёл регрессию: обёртка native textarea меняла его reconciliation path при компактном layout. Это ломало assertions возврата к тому же редактору в Settings и side query. Исправлено сохранение формы children; assertions на identity, текст и курсор не ослаблены. Тест повторяющихся полей теперь ожидает готовый layout и hit map перед отправкой мыши. Более ранние native runs остановлены при доработках; Quick на `6e12fe3` выявил отсутствующий обязательный usage в тестовом terminal event, исправленный следующим коммитом.

Проверены относительные ссылки и anchors в 16 изменённых Markdown (212 локальных ссылок), существование capture JSON/TXT/PNG и навигация к новым руководствам. Проверки поставки не являются полным набором на каждой ОС; отдельный macOS Intel runtime, сборка полного комплекта релизных установщиков и публикация в этой задаче не проверялись. Desktop в эту работу не входит.

Для воспроизведения кадров:

```bash
CHISEL_WIDGET_CAPTURES=docs/assets/extension-widgets bun tests/fixtures/tui-extension-widgets.ts
CHISEL_CAPTURE_THEME=paper CHISEL_WIDGET_CAPTURES=docs/assets/extension-widgets bun tests/fixtures/tui-extension-widgets.ts
python3 scripts/render-terminal-captures.py docs/assets/extension-widgets
```
