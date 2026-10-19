# Поиск Web без внутренних квот: реализация и проверки

[Материалы для участников](../README.md) · [Справка Web](../../web.md) · [Архитектурное решение](../../architecture/web-search.md)

Дата: 2026-10-19. Изменение текущих исходников после 0.6.35; отдельный релиз в этом задании не публикуется. До изменения исходный `main` — `7eafd07`.

## Подтверждённые причины

В provider учитывались вызовы инструментов, а отдельный process limiter учитывал каждый HTTP exchange в той же задаче. Предел 24 HTTP-запроса включал MCP handshake, discovery и redirects. Дополнительно действовали 120 запросов в минуту, интервал 250 мс и отдельная очередь параллельности. Они удалены вместе с картами счётчиков; у помощников квоты также не восстанавливаются из captured config.

На настоящих публичных endpoints Exa и Parallel запрос `server/discover` возвращал HTTP 400, после чего SDK успешно выполнял `initialize`. Фиксированные hosted search endpoints теперь используют legacy negotiation через SDK сразу. Передача endpoint, search tool, TLS и сетевые проверки остаются прежними; пользовательские MCP-серверы не затронуты.

Auto ранее повторно начинал каждый поиск с отказавшего основного сервиса. Теперь последний успешный backend получает приоритет в lifetime provider. При его отказе снова доступны остальные разрешённые сервисы; deny пересчитывается перед вызовом. Нет фонового replay или бесконечного retry.

## Настройки и данные

Поля `maxRequestsPerTurn` и `maxConcurrent` в старых user/project config читаются совместимо и удаляются при сохранении. Настройки не переписываются при простом чтении. Проверка реального config store подтверждает сохранение secret reference Brave, явных Ask/Deny, списка доменов, timeout и постороннего глобального поля. Остальные неизвестные поля Web отклоняются.

Сохранены общий read scheduler, permissions, SSRF/DNS, TLS, отмена socket и cleanup, размеры ответа/DOM, artifacts и replay источников. Внешние HTTP 429 остаются реальными отказами сервиса; Auto использует другой разрешённый backend, когда он доступен. Условия бесплатного доступа определяются Exa/Parallel; безлимитный внешний сервис не обещается.

## Настоящий публичный поиск

Linux, Bun 1.4.3, сетевое окружение с пользовательским proxy и обычной проверкой CA. Нет API-ключа поиска, регистрации или собственного поискового сервера. Временные Home и project изолированы от пользовательских данных. Запуск `--json web test --search 'TypeScript handbook narrowing official documentation'` использовал обычный ToolExecutor и стандартный Auto.

| Поставка | Фактический сервис | Routing | Время одного запроса |
| --- | --- | --- | --- |
| Исходный CLI | Parallel | Exa → Parallel | 12867 мс |
| Bundle `dist/cli.js` | Exa | Exa | 12913 мс |
| Локальный tarball, установленный через npm | Exa | Exa | 11889 мс |
| Compiled CLI | Parallel | Exa → Parallel | 13157 мс |

Во всех четырёх случаях получен непустой результат с официальным `https://www.typescriptlang.org/docs/handbook/2/narrowing.html`, exit 0, без `--allow` и изменения Web config. Время зависит от внешнего сервиса и сети; эти наблюдения не являются гарантией задержки или измерением ускорения.

Отдельная проверка обоих настоящих MCP endpoints вернула по два результата: `initialize` 200, notification 202, `tools/list` и `tools/call` 200. Спекулятивного `server/discover` больше нет. До изменения те же endpoints успешно искали после лишнего 400. Источники устройства сервисов: [Exa MCP](https://exa.ai/docs/reference/exa-mcp), [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp).

## Локальные проверки

- 171 pass, 0 fail в 13 файлах Web: Auto, Exa, Parallel, CLI, Fetch/Download, HTTP, settings/security, extraction/compaction и OpenTUI Web. Включены настоящий MCP fixture, повторный выбор рабочего сервиса, его отказ и восстановление другого, актуальный deny и отмена.
- 145 реальных Fetch через один executor в одном ходе без cache успешно прошли за пределы прежних 24 за ход и 120 в минуту. Сохранённые квоты `1` не остановили выполнение; сервер подтвердил 145 обращений. Три одновременно ожидающих запроса прошли через read scheduler при старом `maxConcurrent: 1`.
- `bun run test:fast`: 360 pass, 0 fail; `tool-guidance`: 4 pass; `subagents-runtime`: 4 pass. Быстрый профиль не расширялся сетевыми fixtures.
- `bun run typecheck`, `bun run lint`, `bun run build`, сборка compiled CLI и установка tarball прошли. Lint завершился без ошибок с существующими предупреждениями репозитория.

## CI итогового source

Source: `1731c8af9d75fe26844fbd9f27ff618f185b7c10`.

- [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/39202572568) завершился успешно.
- [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/39202573903): полный Linux source — 1255 pass, 3 skip, 0 fail, 1258 тестов в 164 файлах, 315,35 с. Typecheck, lint, eval и source UI fixtures прошли. Native smoke Linux и macOS прошли, включая installed/compiled; платформенный набор macOS — 310 pass, 3 skip, 0 fail.
- Первый Windows job: 311 pass, 1 skip, один timeout и связанная ошибка завершённого процесса. Неизменённый тест `production parent delegates two coding tasks through real Git, protocol driver, executor and stores` был остановлен на 45 секундах во время повторного apply. В предыдущем успешном Windows run этого теста было 24,98 с; функционального assertion failure до остановки не было. Выполнен один повтор только Windows job на том же source по правилам AGENTS.md; тест, его assertions и timeout не менялись. Итог повторного job фиксируется после завершения.

Проверены относительные ссылки и anchors восьми изменённых Markdown: 139 целей. Публичные live-запросы выше проверены на Linux; это не live-проверка внешних сервисов на Windows/macOS. UI не менялся, новых кадров OpenTUI нет.
