# Быстрые и полные проверки

[Материалы для участников](README.md) · [Разработка](../development.md)

Изменения выполняются прямо в main с сохранением посторонних изменений, без новых веток, development worktrees и PR. Выбирайте проверки по изменённому поведению; число запусков само по себе не определяет качество.

## Обычные изменения

Для документации запустите `bun run docs:check`. Отдельный [Docs CI](../../.github/workflows/docs.yml) выполняет проверку и её unit tests при изменении Markdown, изображений или самого скрипта. Установка npm-зависимостей, сеть, серверы и native renderer этому job не нужны. Проверяются локальные ссылки, якоря, изображения и путь к каждой Markdown-странице от корневого README. Внешние URL и фактический смысл инструкций требуют отдельной проверки.

```bash
bun run test:fast
bun run typecheck
bun run lint
bun run build
```

`bun run test` и `npm test` используют тот же быстрый профиль. Его явный список находится в [scripts/test-fast.ts](../../scripts/test-fast.ts): permissions/SSRF, конфигурация, каталог LSP, provider contracts, compaction/tool pairs, extension lifecycle и UI state без renderer. Здесь нет запуска серверов, дочерних приложений, настоящего Git или GUI. Допустимы короткие проверки с изолированными временными файлами. Не добавляйте в профиль сетевые скачивания и ожидания процессов.

[Quick CI](../../.github/workflows/quick.yml) выполняет этот профиль, typecheck, lint, JS/SDK build и проверку запуска CLI на Linux при изменении кода в main/PR. Изменения только Markdown и docs/assets его не запускают; проверяйте текст, ссылки и примеры отдельно. Новый push отменяет устаревший run. Даже при миллисекундных тестах подготовка runner, зависимости, lint и build занимают дополнительное время.

При изменении поведения дополнительно выполните подходящий узкий тест. Например, `bun test tests/unit/background-process.test.ts` проверяет настоящий process ownership, а `bun test tests/integration/subagents-runtime.test.ts` — дочерний runtime. Не подменяйте их успешным быстрым профилем и не повторяйте весь набор после каждой небольшой правки.

Для Windows updater доступен ручной workflow `Windows update regression`: полные `self-update`, `update-controller`, `opentui-update` и `bun tests/fixtures/windows-update.ts` с настоящим NSIS. Сценарий проверяет замену EXE после выхода OpenTUI, отдельную консоль, блокировку файла и восстановление причины ошибки. Он также входит в Windows job обязательного Native validation; Linux/macOS этот Windows-сценарий не исполняют.

`subagents-context.ts` ожидает большой сценарий до 40 с внутри общего test deadline 45 с. Один вызов production `control.wait` ограничен 30 с и может вернуть ещё работающего помощника: fixture продолжает опрос до terminal state или остатка собственного deadline. Это не отмена помощника и не ограничение времени его работы. Сценарий сохраняет 104 настоящих чтения, 27 генераций, model compaction и проверки полного artifact. `subagents-runtime.ts` записывает terminal state, exit code, cleanup и хвост вывода фоновых команд для диагностики Windows.

## Полный прогон

```bash
bun scripts/prepare-lsp-tests.ts
bun run test:full
```

`bun test` без фильтров также запускает весь набор. [Native validation](../../.github/workflows/ci.yml) запускается вручную перед выпуском или при изменении native runtime. Обязательны четыре jobs:

| Job | Покрытие |
| --- | --- |
| `Full source (ubuntu-latest)` | Все unit/integration tests один раз, typecheck/lint, deterministic evals, отдельные source UI-fixtures настроек расширений и external SDK; настоящие OpenTUI captures и JUnit в artifacts. |
| `Native smoke (<os>)` на Linux/macOS/Windows | Installed CLI: запуск, manifest tool, download и external SDK. Compiled CLI: download, TS/Python LSP, subagents, worktree, background tasks, external loader и package management. Native OpenTUI загрузка и рендеринг. |
| Дополнительно внутри macOS/Windows smoke | Реальные paths, atomic storage, locks, shell, background ownership, child storage/policy и LSP transport; эти source tests уже входят в Linux full run. |

Все jobs независимы. Полный source-набор больше не повторяется на каждой ОС. Сложные business cases и OpenTUI просмотр помощников/worktrees остаются в полном source-наборе; поставки проверяют запуск и интеграцию без копирования всего сценария для каждого формата.

Для диагностики одной ОС `gh workflow run ci.yml --ref main -f platform=windows-latest` выполняет её полный native job без повторения Linux source и других ОС. Доступны также `ubuntu-latest` и `macos-latest`. Перед релизом используйте значение по умолчанию `all`: точечный run с пропущенным source не удовлетворяет проверке обязательных jobs.

### Выбор основной ОС и границы покрытия

Linux выбран базовой средой ради скорости и расхода ресурсов CI. Общий набор выполняется один раз, а проверки поставки и выбранные платформенные сценарии распределены между тремя ОС. Это организационный выбор; фактическую длительность каждого прогона измеряйте отдельно, учитывая runner, cache и очередь.

Полный результат Linux относится к Linux. Smoke на Windows/macOS проверяют перечисленные выше сценарии и могут пропустить ошибку за их пределами. Поэтому такая схема даёт более узкое покрытие платформ, чем полный набор на трёх ОС.

При изменении путей, shell, процессов/cleanup, файловых блокировок, native TUI или запуска LSP выполните затронутые тестовые файлы целиком на соответствующей ОС. При исправлении воспроизведённой Windows-ошибки проверка должна пройти на Windows; для macOS действует тот же порядок. Например, изменение остановки Windows-процессов проверяется на Windows командами `bun test tests/unit/background-process.test.ts tests/unit/shell-runtime.test.ts`. Для узкого исправления достаточно соответствующих файлов: весь набор на остальных ОС повторять не требуется. В отчёте отдельно укажите результат Linux, выполненные native smoke и дополнительные проверки конкретной ОС. Если нужная ОС недоступна, явно отметьте непроверенный сценарий.

Кэшируется только npm download cache по ОС и lockfile. Пользовательские данные, credentials, сессии и node_modules не кешируются. Production deadlines и защитные leases не сокращаются ради теста.

Для встроенных разделов MCP/навыков source-сценарий `settings-tools-runtime.test.ts` входит в полный набор Linux и в затронутые UI-файлы Windows/macOS. Compiled smoke отдельно проверяет загрузку нативного UI, bundled skills, настоящий MCP handshake и возврат черновика; полный сценарий форм, фокуса, ошибок и размеров в compiled не дублируется.

Интерактивные расширения проверяет `extension-widgets-runtime.test.ts` в полном source-наборе: внешний reviewed пакет, поля/выбор, Markdown/code/image/canvas, обычное подтверждение перед записью, перенос панели и ошибка callback. Compiled smoke с `CHISEL_WIDGET_SMOKE=1` проверяет загрузку новых компонентов и media в поставке; запись, ошибки и resize в нём не повторяются. На Windows/macOS отдельно выполняется полный файл `opentui-extension-interaction.test.tsx` с фокусом и переключением бесед. Installed/compiled external SDK smoke проверяет новые declarations и цепочки model/tool hooks, включая coding-помощника.

## LSP и расширенные проверки поставки

Полный [LSP catalog](../../.github/workflows/lsp-catalog.yml) запускается вручную при изменении backends, каталога или provisioning. В input `languages` можно указать только затронутые fixture names, например `python lua`. По умолчанию проверяются все перечисленные backends на трёх ОС; опция `sourcekit` дополнительно проверяет SourceKit на macOS. Ruby SDK устанавливается только при выборе `ruby`. Обычная правка и каждый несвязанный релиз не требуют скачивания и запуска всего каталога. Native smoke сохраняет настоящие TS/Python diagnostics, tool execution и persistence.

При изменении OpenTUI bundling/SDK отдельно запустите `bun tests/fixtures/command-packaging.ts` на затронутых ОС. Он сохраняет installed/compiled UI assertions для commands, LSP, side queries, worktrees, subagents, background tasks, UI contributions и themes. При изменении публичного engine protocol используйте `bun tests/fixtures/desktop-server.ts` с compiled engine. Эти расширенные harness не входят в каждый обычный CI или несвязанный релиз. Это проверки публичной границы ядра, без работы над приложением Desktop.

## Что убрано и что сохранено

- Нет повторных Windows runtime-fixtures перед теми же source tests и нет полного source-набора в Release.
- В installed/compiled smoke больше не повторяются все девять CLI-fixtures и все UI-сценарии в обоих форматах. Для каждого формата остаются запуск и настоящая runtime-интеграция; общий runtime полностью проверяется в source.
- Crash-тесты пакетов действительно завершают отдельный процесс. После его выхода давность только его изолированного lock задаётся через `utimes`: две проверки atomic commit boundary больше не ждут по 30 секунд. Само stale recovery не подменяется; production lock не меняется.
- Проверки Plan/readonly, SSRF/redirects, 429/deadline, cancellation/cleanup, atomic writes/conflicts, CAS/trust, migrations, compaction и истории остаются в исходных test files. Полные файлы и расширенные fixtures доступны отдельно; быстрый профиль не объявляется полным покрытием.

## Выпуск

Перед созданием тега запустите `gh workflow run ci.yml --ref main` и дождитесь четырёх успешных jobs на точном release source. Зелёный Quick CI другого или того же source не заменяет Native validation.

В [Release workflow](../../.github/workflows/release.yml) `scripts/verify-release-ci.ts` получает SHA checkout тега и проверяет GitHub Actions API с правом `actions: read`. Принимается последний ручной run `ci.yml` из main на этом SHA. Отсутствие run, другой source/branch/workflow, pending/failure/skipped, неоднозначные jobs или ошибка API блокируют выпуск. Частичный rerun допускает сохранённые успешные jobs того же source через `filter=latest`.

Release сверяет версию с тегом, собирает четыре установщика и CLI/SDK archive, проверяет запуск/версию новых native binaries, наличие SDK declarations и точный набор пяти assets. Полный source-набор повторно не выполняется. macOS x64 на arm64 runner проверяется сборкой, запуск на Intel этим не подтверждён. Публикация дополнительно проверяется по metadata, размерам, SHA-256 и подходящему smoke опубликованного payload.

## Ошибки и измерение

Сохраняйте логи и устанавливайте причину сбоя. Один повтор неуспешного job при временном отказе допустим с честной записью attempt и исходной причины; повторяющийся отказ требует исправления. Не скрывайте assertions через skip/retry и не повышайте таймауты ради зелёного статуса. UI должен ждать фактическую готовность ввода с конечным deadline и восстановлением фокуса.

Native LSP catalog probe повторяет только начальную подготовку при retryable HTTP 502/503/504: cleanup, одна секунда, одна новая попытка. Assertions, activation, protocol, unsafe targets, cancellation и 429 не получают этот retry. Постоянный отказ остаётся ошибкой. Обычные core policy/integrity и Retry-After не обходятся.

Измеряйте тесты, setup, jobs, очередь и суммарные runner minutes отдельно. Результат конкретного source и непроверенные платформы фиксируйте в [отчётах](README.md), без обещания миллисекунд для настоящего GUI/сервера.
