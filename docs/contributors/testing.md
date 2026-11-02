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

Для меню LSP сначала выполните `bun scripts/prepare-lsp-tests.ts`, затем `bun test tests/unit/lsp-config.test.ts tests/unit/lsp-service.test.ts tests/unit/lsp-transport.test.ts tests/integration/lsp-runtime.test.ts tests/integration/lsp-multilingual.test.ts tests/integration/lsp-tui.test.ts tests/integration/ui-tools-runtime.test.ts`. Это настоящие серверы и renderer, поэтому файлы не добавляются в fast. `CHISEL_TEST_LSP_CAPTURES=<каталог>` сохраняет текст и native spans для `python scripts/render-terminal-captures.py <каталог>`. Подробные assertions и границы — в [проверках возможностей](feature-checks.md#проверки-lsp-и-settings). Изменения только меню не требуют полного внешнего каталога; изменения подготовки backend проверяются отдельно через `LSP catalog`.

Для `/compact` используйте `bun test tests/integration/manual-compact.test.ts`: настоящий OpenTUI и локальный HTTP-провайдер проверяют восстановление checkpoint, обычное сообщение перед сжатием, повторную команду и продолжение. API возвращает DeepSeek V4.1 Flash/1017 без лимитов; fixture проверяет fallback каталога в runtime и панели. `CHISEL_COMPACT_CAPTURES=<каталог>` сохраняет текст и `captureSpans` JSON успешного сжатия для `scripts/render-terminal-captures.py`. Unit-проверки `context-limits.test.ts`, `context-sidebar.test.tsx` и `auto-compaction.test.ts` покрывают лимиты, неизвестное окно, отмену, protocol units и неизменность полной истории.

Для установки навыков используйте `bun test tests/unit/skill-source.test.ts tests/integration/skill-install-runtime.test.ts`. Второй файл поднимает локальный сервер и поэтому не входит в fast; он также добавлен в platform subset. `bun tests/fixtures/skill-install-cli.ts bun dist/cli.js` и вариант с compiled binary проверяют поставку через обычные HTTPS и настроенный proxy, без изменения production transport и пользовательской библиотеки. В CI эти smoke входят в существующие installed/compiled steps. Тот же fixture воспроизводит нулевой `revision` из модельного вызова, проверяет отказ до сети и исправление аргументов через SDK; после этого устанавливает стандартную упаковку при наличии plugin-копии. Отдельные source cases сохраняют проверки HTTP 422, `Retry-After`, ограниченного чтения JSON ошибки, конфликтов и отмены.

Для Windows updater доступен ручной workflow `Windows update regression`: полные `self-update`, `update-controller`, `opentui-update` и `bun tests/fixtures/windows-update.ts` с настоящим NSIS. Сценарий проверяет замену EXE после выхода OpenTUI, отдельную консоль, блокировку файла и восстановление причины ошибки. `bun tests/fixtures/windows-launcher.ts` создаёт настоящие `.lnk` в изолированной папке, сверяет TargetPath/Arguments/WorkingDirectory и исполняет их, а также общий finish-page handler. Оба fixture входят в Windows job Native validation; Linux/macOS эти Windows-сценарии не исполняют.

Допуск проекта проверяют `project-admission.test.ts` и `runtime-environment.test.ts` в fast; защищённые черновики — `terminal-drafts.test.ts` вне fast. `bun test tests/integration/project-startup.test.ts` запускает настоящее приложение OpenTUI с локальным HTTP-провайдером: главная без scope, кнопка `/cwd` в нижней строке, отмена выбора с сохранением черновика, readonly архив, отказ служебного root, выбор папки без Git и отдельная отправка сохранённого текста. Эти файлы также входят в platform subset Windows/macOS. Installed manifest smoke проверяет структурированный отказ `--launcher --json` до inference. Compiled `project-startup.ts` с `CHISEL_STARTUP_PACKAGED=1` проверяет загрузку UI и путь от выбора проекта до запроса; архив и частные отказы повторно не исполняются. Для кадров задайте `CHISEL_STARTUP_CAPTURES`, `CHISEL_STARTUP_WIDTH` и `CHISEL_STARTUP_HEIGHT`; `CHISEL_STARTUP_RECENT=1` добавляет недавний проект и проверяет его доступность в окне выбора. Затем запустите `python scripts/render-terminal-captures.py <каталог>` с установленным Pillow.

Для общего `/resume` используйте `bun test tests/unit/session-history.test.ts tests/unit/opentui-sessions.test.tsx tests/integration/session-resume.test.ts`. Production fixture проходит путь от главной без root к настоящему запросу в исходном проекте, переход между проектами, переименование/удаление и readonly fallback недоступной папки. `CHISEL_RESUME_CAPTURES=<каталог>` сохраняет native кадры 120×40, 80×24, 60×15 и 32×10 для того же экспортера PNG. Source-сценарий входит в Linux full run и платформенный subset Windows/macOS; installed/compiled загрузка UI остаётся в существующих smoke.

`subagents-context.ts` ожидает большой сценарий до 40 с внутри общего test deadline 45 с. Один вызов production `control.wait` ограничен 30 с и может вернуть ещё работающего помощника: fixture продолжает опрос до terminal state или остатка собственного deadline. Это не отмена помощника и не ограничение времени его работы. Сценарий сохраняет 104 настоящих чтения, 27 генераций, model compaction и проверки полного artifact. `subagents-runtime.ts` записывает terminal state, exit code, cleanup и хвост вывода фоновых команд для диагностики Windows.

## Полный прогон

```bash
bun scripts/prepare-lsp-tests.ts
bun run test:full
```

`bun test` без фильтров также запускает весь набор. [Native validation](../../.github/workflows/ci.yml) запускается вручную перед выпуском или при изменении native runtime. Обязательны шесть jobs:

| Job | Покрытие |
| --- | --- |
| `Full source (ubuntu-latest)` | Все unit/integration tests один раз, typecheck/lint, deterministic evals, отдельные source UI-fixtures настроек расширений и external SDK; настоящие OpenTUI captures и JUnit в artifacts. |
| `Native smoke (<os>)` на Linux/macOS/Windows | Installed CLI: запуск, manifest tool, download и external SDK. Compiled CLI: download, TS/Python LSP, subagents, worktree, background tasks, external loader и package management. Native OpenTUI загрузка и рендеринг. |
| `LSP lifecycle (<os>)` на macOS/Windows | Полные затронутые LSP-файлы: config, service, transport, runtime, TS/Python/Lua, production-меню и UI tool permissions. Эти tests уже входят в Linux full run. Короткие installed/compiled smoke меню проверяют упаковку отдельно от полного сценария. |
| Дополнительно внутри macOS/Windows smoke | Реальные paths, atomic storage, locks, shell, background ownership, child storage/policy; эти source tests уже входят в Linux full run. |

Все jobs независимы. LSP config/transport перенесены из платформенного subset в отдельные `LSP lifecycle`: их assertions сохранены в тех же файлах и дополнены отменой подготовки, initialize/request, наследованием и общим меню. Installed/compiled LSP smoke проходит только три входа, `ui_tool`/approval/checkpoints и ленивое выключение/включение; ручные формы и весь source-сценарий в поставках не повторяются. Полный source-набор больше не повторяется на каждой ОС. Сложные business cases и OpenTUI просмотр помощников/worktrees остаются в полном source-наборе; поставки проверяют запуск и интеграцию без копирования всего сценария для каждого формата.

Для диагностики одной ОС `gh workflow run ci.yml --ref main -f platform=windows-latest` выполняет её полный native job без повторения Linux source и других ОС. Доступны также `ubuntu-latest` и `macos-latest`. Перед релизом используйте значение по умолчанию `all`: точечный run с пропущенным source не удовлетворяет проверке обязательных jobs.

### Выбор основной ОС и границы покрытия

Linux выбран базовой средой ради скорости и расхода ресурсов CI. Общий набор выполняется один раз, а проверки поставки и выбранные платформенные сценарии распределены между тремя ОС. Это организационный выбор; фактическую длительность каждого прогона измеряйте отдельно, учитывая runner, cache и очередь.

Полный результат Linux относится к Linux. Smoke на Windows/macOS проверяют перечисленные выше сценарии и могут пропустить ошибку за их пределами. Поэтому такая схема даёт более узкое покрытие платформ, чем полный набор на трёх ОС.

При изменении путей, shell, процессов/cleanup, файловых блокировок, native TUI или запуска LSP выполните затронутые тестовые файлы целиком на соответствующей ОС. При исправлении воспроизведённой Windows-ошибки проверка должна пройти на Windows; для macOS действует тот же порядок. Например, изменение остановки Windows-процессов проверяется на Windows командами `bun test tests/unit/background-process.test.ts tests/unit/shell-runtime.test.ts`. Для узкого исправления достаточно соответствующих файлов: весь набор на остальных ОС повторять не требуется. В отчёте отдельно укажите результат Linux, выполненные native smoke и дополнительные проверки конкретной ОС. Если нужная ОС недоступна, явно отметьте непроверенный сценарий.

Кэшируется только npm download cache по ОС и lockfile. Пользовательские данные, credentials, сессии и node_modules не кешируются. Production deadlines и защитные leases не сокращаются ради теста.

Для встроенных разделов MCP/навыков source-сценарий `settings-tools-runtime.test.ts` входит в полный набор Linux и в затронутые UI-файлы Windows/macOS. Compiled smoke отдельно проверяет загрузку нативного UI, bundled skills, настоящий MCP handshake и возврат черновика; полный сценарий форм, фокуса, ошибок и размеров в compiled не дублируется.

Интерактивные расширения проверяет `extension-widgets-runtime.test.ts` в полном source-наборе: внешний reviewed пакет, поля/выбор, Markdown/code/image/canvas, обычное подтверждение перед записью, перенос панели и ошибка callback. Compiled smoke с `CHISEL_WIDGET_SMOKE=1` проверяет загрузку новых компонентов и media в поставке; запись, ошибки и resize в нём не повторяются. На Windows/macOS отдельно выполняется полный файл `opentui-extension-interaction.test.tsx` с фокусом и переключением бесед. Installed/compiled external SDK smoke проверяет новые declarations и цепочки model/tool hooks, включая coding-помощника.

Для точечной диагностики ярлыков `gh workflow run windows-update.yml --ref main -f scenario=launcher` запускает тот же `windows-launcher.ts` без повторения updater. По умолчанию `scenario=all` сохраняет обе проверки; обязательный Native validation также выполняет обе. Harness сначала проверяет существование настоящего `.lnk`, передаёт Unicode-путь в дочерний PowerShell как UTF-8/base64 и сверяет восстановленный путь, затем читает COM-поля через Unicode `IPersistFile`/`IShellLinkW` и исполняет ярлык через ShellExecute. `SLGP_RAWPATH` получает сохранённый target без автоматической перепривязки к профилю проверяющего пользователя; контракт описан в [документации Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishelllinkw-getpath). Ограничения путей и assertions не обходятся.

## LSP и расширенные проверки поставки

Для диагностики процессов Windows используйте `gh workflow run windows-update.yml --ref main -f scenario=processes`: выполняются полные файлы `background-process.test.ts` и `subagents-runtime.test.ts`, без повторения NSIS. В проверке наследованного вывода лимит команды остаётся 10 с, cleanup — до 10 с; внешняя граница теста 25 с позволяет дождаться реального исхода и teardown. Test дополнительно отклоняет `outcome.reason`, поэтому `timed_out` не превращается в успех; при задержке сохраняются фактическая фаза cleanup, детали и вывод. Прежние 15 с могли оборвать саму проверку до завершения предусмотренного cleanup.

Полный [LSP catalog](../../.github/workflows/lsp-catalog.yml) запускается вручную при изменении backends, каталога или provisioning. В input `languages` можно указать только затронутые fixture names, например `python lua`. По умолчанию проверяются все перечисленные backends на трёх ОС; опция `sourcekit` дополнительно проверяет SourceKit на macOS. Ruby SDK устанавливается только при выборе `ruby`. Обычная правка и каждый несвязанный релиз не требуют скачивания и запуска всего каталога. Native smoke сохраняет настоящие TS/Python diagnostics, tool execution и persistence.

При изменении OpenTUI bundling/SDK отдельно запустите `bun tests/fixtures/command-packaging.ts` на затронутых ОС. Он сохраняет installed/compiled UI assertions для commands, LSP, side queries, worktrees, subagents, background tasks, UI contributions и themes. При изменении публичного engine protocol используйте `bun tests/fixtures/desktop-server.ts` с compiled engine. Эти расширенные harness не входят в каждый обычный CI или несвязанный релиз. Это проверки публичной границы ядра, без работы над приложением Desktop.

## Что убрано и что сохранено

- Нет повторных Windows runtime-fixtures перед теми же source tests и нет полного source-набора в Release.
- В installed/compiled smoke больше не повторяются все девять CLI-fixtures и все UI-сценарии в обоих форматах. Для каждого формата остаются запуск и настоящая runtime-интеграция; общий runtime полностью проверяется в source.
- Crash-тесты пакетов действительно завершают отдельный процесс. После его выхода давность только его изолированного lock задаётся через `utimes`: две проверки atomic commit boundary больше не ждут по 30 секунд. Само stale recovery не подменяется; production lock не меняется.
- Проверки Plan/readonly, SSRF/redirects, 429/deadline, cancellation/cleanup, atomic writes/conflicts, CAS/trust, migrations, compaction и истории остаются в исходных test files. Полные файлы и расширенные fixtures доступны отдельно; быстрый профиль не объявляется полным покрытием.

Сценарий `extension-commands-tui.test.ts` проверяет настоящий picker при задержанной активации: отмена не открывает ошибку, не создаёт беседу и освобождает неиспользуемый scope. После повторного выбора проверяются отмена очереди и поздний callback своей вкладки. Совместное ожидание активации и сохранение чужого запроса при отмене отдельно остаются в `extensions-lifecycle.test.ts`; гонка A → B и deadline с cleanup — в `project-admission.test.ts`. Проверки не требуют прежней немедленной смены root до завершения допуска.

## Выпуск

Перед созданием тега запустите `gh workflow run ci.yml --ref main` и дождитесь шести успешных jobs на точном release source. Зелёный Quick CI другого или того же source не заменяет Native validation.

В [Release workflow](../../.github/workflows/release.yml) `scripts/verify-release-ci.ts` получает SHA checkout тега и проверяет GitHub Actions API с правом `actions: read`. Принимается последний ручной run `ci.yml` из main на этом SHA. Отсутствие run, другой source/branch/workflow, pending/failure/skipped, неоднозначные jobs или ошибка API блокируют выпуск. Частичный rerun допускает сохранённые успешные jobs того же source через `filter=latest`.

Release сверяет версию с тегом, собирает четыре установщика и CLI/SDK archive, проверяет запуск/версию новых native binaries, наличие SDK declarations и точный набор пяти assets. Полный source-набор повторно не выполняется. macOS x64 на arm64 runner проверяется сборкой, запуск на Intel этим не подтверждён. Публикация дополнительно проверяется по metadata, размерам, SHA-256 и подходящему smoke опубликованного payload.

## Ошибки и измерение

Сохраняйте логи и устанавливайте причину сбоя. Один повтор неуспешного job при временном отказе допустим с честной записью attempt и исходной причины; повторяющийся отказ требует исправления. Не скрывайте assertions через skip/retry и не повышайте таймауты ради зелёного статуса. UI должен ждать фактическую готовность ввода с конечным deadline и восстановлением фокуса.

Native LSP catalog probe повторяет только начальную подготовку при retryable HTTP 502/503/504: cleanup, одна секунда, одна новая попытка. Assertions, activation, protocol, unsafe targets, cancellation и 429 не получают этот retry. Постоянный отказ остаётся ошибкой. Обычные core policy/integrity и Retry-After не обходятся.

Измеряйте тесты, setup, jobs, очередь и суммарные runner minutes отдельно. Результат конкретного source и непроверенные платформы фиксируйте в [отчётах](README.md), без обещания миллисекунд для настоящего GUI/сервера.
