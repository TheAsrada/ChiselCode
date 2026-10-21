# Выпуск CLI 0.6.38

[Материалы участников](../README.md) · [Установка](../../installation.md) · [Интерактивные расширения](../../extensions/interactive-ui.md) · [События агента](../../extensions/agent-events.md)

[CLI 0.6.38](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.38) опубликован 21 октября 2026 года. SDK v1 дополнен формами, локальными обработчиками, самостоятельными панелями, media, оформлением и цепочками событий агента. Обновлены встроенный `extension-creator` и пример «Студия заметок». [Реализация и настоящие кадры OpenTUI](extension-widgets.md) относятся к предшествующей задаче; в подготовке выпуска UI приложения не менялся.

## Допуск к выпуску

Release source — `55054ebb5bf76a243371d6d20bf2c478936cc0d0`. Подготовка и коммиты выполнены прямо в `main`. [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/39629586017) и все четыре обязательных jobs [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/39629588832) успешны на этом SHA. Использовался Bun 1.4.2.

| Проверка | Фактический результат | Длительность job |
| --- | --- | ---: |
| Full source, Ubuntu | 1331 pass, 3 skip, 0 fail; 11902 assertions, 169 файлов, тесты 331,17 с; typecheck/lint, 14 eval и source UI успешны | 387 с |
| Native Ubuntu | Installed/compiled CLI, внешний SDK, LSP, помощники, Settings/MCP/skills и новые widgets | 108 с |
| Native macOS | 314 pass, 3 skip, 0 fail; 2447 assertions, 41 файл, тесты 109,99 с; installed/compiled smoke | 337 с |
| Native Windows | 316 pass, 1 skip, 0 fail; 2457 assertions, 41 файл, тесты 196,41 с; настоящий NSIS updater, installed/compiled smoke | 624 с |

В выбранном CI не было rerun. От создания workflow до последнего завершённого job прошло 643 с, включая очередь macOS; это время ожидания, не сумма runner minutes. На Windows большой context-сценарий завершился за 28,67 с, делегирование с фоновыми командами — за 35,22 с.

Локально на Linux/Bun 1.4.3 прошли быстрый профиль (428 pass, 0 fail, 3199 assertions, 43 файла, 2,11 с), typecheck, lint и CLI/SDK build; CLI показал `0.6.38`. Lint завершился без ошибок, с предупреждениями. После изменения fixture целиком проверен `subagents-runtime.test.ts`: 4 pass, 0 fail, 10 assertions, 21,59 с; повторно прошли typecheck, точечный lint и diff check.

### Первый прогон и исправление fixture

[Первый Native CI](https://github.com/TheAsrada/ChiselCode/actions/runs/39628466247) на коммите подготовки версии `9df459466a94679d8981e2650a4ed790f6d930ea` завершился с ошибкой Windows. Full source Linux: 1331 pass, 3 skip, 0 fail, 11897 assertions, 169 файлов, 317,53 с. Native Linux/macOS успешны. Windows: 314 pass, 1 skip, 2 fail, 2453 assertions, 41 файл, 202,07 с.

`subagents-context.ts` передал `control.wait` 40000 мс, но production API ограничивает один опрос 30000 мс. После 30001 мс вернулся `running`, 21 генерация и 80 чтений. В `55054eb` fixture продолжает опрос до terminal state или прежнего общего бюджета 40 с внутри внешнего test deadline 45 с. Сохранены 104 настоящих чтения, 27 генераций, model compaction, usage и полный artifact. Production API, deadlines и assertions не менялись.

Второй отказ относился к `subagents-runtime.ts`: одна фоновая команда получила `cancelled`, код 0 и подтверждённый cleanup, хотя вывод содержал обе ожидаемые строки. Причина такого завершения не установлена; добавлена диагностика terminal state, exit code, cleanup и хвоста вывода. Первый неуспешный job не перезапускался. Новый `platform=all` CI выполнен на изменённом source; повторения отказа фоновой команды в нём не было.

Production `verify-release-ci.ts` подтвердил четыре успешных обязательных jobs точного source до создания annotated tag `v0.6.38`. Тег отправлен на этот SHA; опубликованные теги и assets не заменяются.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/39631336487) завершил все шесть jobs успешно. Он повторно подтвердил Native CI точного source, собрал и опубликовал четыре установщика и npm-архив CLI/SDK. GitHub API подтвердил latest `v0.6.38`, не draft/prerelease, и annotated tag с source `55054ebb5bf76a243371d6d20bf2c478936cc0d0`.

От создания Release workflow до завершения последнего job прошло 678 с, включая очередь macOS; сама сборка macOS заняла 33 с.

Все пять опубликованных файлов скачаны. Размеры и SHA-256 совпали с GitHub API; сигнатуры EXE/PKG/DEB/tgz проверены.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-Setup-0.6.38-linux-amd64.deb` | 37012104 | `37258a93673eb656756f50bdc3f299fcb78bb906450868e33d7d0b6613fda747` |
| `ChiselCode-Setup-0.6.38-macos-arm64.pkg` | 33373523 | `f19a91c9f51153c14dcfb0bd5326717197bfd5b943b2f0c7f34b19951e106fc5` |
| `ChiselCode-Setup-0.6.38-macos-x64.pkg` | 35962417 | `1bcabb5be218b8fd858226c1a2acd4046344893676df84566a2886fb9e45cf1a` |
| `ChiselCode-Setup-0.6.38.exe` | 38742641 | `02ca634db3be6c09b356aa4843e0055d814d31d06105d06c774b51bc72948294` |
| `chiselcode-0.6.38.tgz` | 5881518 | `5b48e0201aff07d5dde63bbe7e8685326a230b13a1415baa06deebdfdf9b8e77` |

Извлечённый опубликованный DEB и CLI, установленный из опубликованного npm-архива в изолированный prefix, показали `0.6.38`. DEB прошёл настоящий сценарий локального HTTP-provider: gateway SSE → tool → model → persisted checkpoint. Полный source-набор повторно для каждого публичного формата не запускался.

Опубликованный npm-пакет прошёл external SDK smoke: отдельный TypeScript consumer публичных declarations, точное доверие пакету, чтение/запись/Plan, model/tool hooks и coding-помощник, отказ изменённым bytes, raw exit и восстановление. Публичный SDK импортируется отдельно: `API_VERSION=1`, все шесть `SDK_CAPABILITIES`, declarations UI/events/capabilities присутствуют. Три встроенных навыка в DEB/npm побайтово совпали с release tag source.

`update --json` опубликованного Linux-бинарника получил latest `0.6.38`, `updateAvailable: false` и все пять файлов с SHA-256. npm-архив опубликован в GitHub Release. Установка под Node 24.19.0 завершилась с предупреждением engine зависимости OpenTUI о Node ≥26.4; CLI и smoke выполнялись под Bun 1.4.3.

Release проверил запуск Windows x64, Linux x64 и macOS ARM64. macOS x64 собран; запуск на Intel не проверялся. Установщики Windows/macOS не подписаны. GUI полного мастера установки и физические терминалы вручную не проверялись; Windows updater проверялся настоящим NSIS и консольными процессами в CI. Desktop в этот выпуск не входит.

Установка, справка SDK/UI, горячие клавиши и навигация обновлены после публикации. Исторический отчёт реализации сохранён с уточнением последующего выпуска и ошибки ожидания. В 15 изменённых Markdown проверены 264 локальные ссылки, anchors и пути изображений, ошибок нет; новый отчёт доступен из оглавлений. Результаты публикации фиксируются отдельным коммитом документации в `main`; release source, tag и assets не меняются.
