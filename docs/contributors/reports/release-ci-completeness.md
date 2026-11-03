# Полнота CI и допуск к публикации

[Материалы для участников](../README.md) · [Порядок проверок](../testing.md) · [Разработка](../../development.md)

Проверяемый code source — `82e3e7b9a41b27b8778b519954bc2778e798d051`, база — `f7d857c9ae3ac6d3e3d62ac124eecfb10f87052a`. Версия CLI остаётся 0.6.49. Задача меняет CI и порядок допуска к публикации; новый выпуск не запускался. Изменения меню и исправления цикла инструментов сохранены. Последующее дополнение отчёта меняет только Markdown.

## Найденные пробелы

Push кода запускал только Quick CI с быстрым профилем. Полный Native validation требовал ручного запуска, поэтому зелёный обычный CI не означал прохождения всего source-набора. Release уже требовал шесть успешных native jobs на точном source, но проверял их общий статус без обязательных steps и подтверждения состава JUnit.

Полный Linux run пропускает native clipboard, поскольку у headless runner нет desktop clipboard. Этот файл не входил в дополнительный source subset Windows/macOS: прежняя матрица вообще не исполняла его единственный case. Также сборочные jobs заново разрешали имя тега, а CI проверялся только перед началом сборок.

## Текущий порядок

Каждый push кода в main запускает Quick CI и все шесть jobs Native validation. Полный source-набор выполняется один раз на Linux прямой командой `bun test`; отдельный скрипт сверяет JUnit с текущими test/spec files в `tests/unit` и `tests/integration`. Частичный быстрый отчёт, отсутствие файла, пустой/обрезанный XML, ошибки или целиком пропущенный обычный файл не проходят. Единственное исключение целого файла — clipboard на Linux; этот же файл добавлен в Windows/macOS native jobs.

Release принимает последний main run на точном SHA, автоматический или ручной, и проверяет обязательные steps каждого job. Пропущенные/отсутствующие steps и новый pending/failed run блокируют публикацию. Все сборки и публикация используют один сохранённый SHA; перед переводом draft в публичный release повторяются проверка CI и разрешение тега в этот SHA.

PR сохраняет быстрые проверки. Изменения только Markdown и docs/assets проверяет Docs CI; для выпуска на таком source нужен ручной Native validation с `platform=all`. Полный каталог внешних LSP backends, платные live evals и расширенные SDK harness остаются отдельными проверками по изменённому поведению. Общий source-набор не объявляется полным прогоном на трёх ОС: на Windows/macOS выполняются native поставки, LSP lifecycle и выбранные платформенные source files.

## Проверки

Локально на Linux/Bun 1.4.2:

- Точечные проверки JUnit и release gate: 12 pass, 0 fail, 251 assertions. Проверены частичный отчёт, пропущенные файлы и steps, неверный SHA, старый зелёный run при новом неуспешном, привязка сборок к проверенному source и повторный допуск перед публикацией.
- Быстрый профиль: 505 pass, 0 fail, 3731 assertions, 53 files, 1,76 с. Новая проверка отчёта работает без процессов, серверов и GUI.
- Typecheck, build и actionlint всех workflows успешны. Lint успешен с прежними 416 warnings и 58 infos. Документация: 138 страниц, 1550 локальных ссылок, 0 ошибок.
- Настоящий JUnit Bun с пятью успешными cases и Linux clipboard skip принят при соответствующем списке файлов. Частичный отчёт, проверенный по всему source inventory, отклоняется.

Push source запустил [Native validation 41640053713](https://github.com/TheAsrada/ChiselCode/actions/runs/41640053713) автоматически, без workflow dispatch. [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/41640053734) и [Docs CI](https://github.com/TheAsrada/ChiselCode/actions/runs/41640053269) успешны.

Native validation завершился успешно с первой попытки, без rerun:

| Job | Фактический результат |
| --- | --- |
| `Full source (ubuntu-latest)` | 1517 pass, 3 platform skips, 0 fail; 192 файла, 385,68 с. Проверка JUnit подтвердила 1520 cases из всех файлов. Документация, typecheck/lint, 14 offline evals и оба дополнительных source UI-fixtures успешны. |
| `Native smoke (ubuntu-latest)` | Installed/compiled CLI и SDK, настоящий LSP, shell, помощники, worktrees, background processes и native OpenTUI успешны. |
| `Native smoke (macos-latest)` | Дополнительный source subset: 467 pass, 3 platform skips, 0 fail; 59 файлов, 105,66 с. Installed/compiled smoke успешны. |
| `Native smoke (windows-latest)` | Дополнительный source subset: 469 pass, 1 platform skip, 0 fail; 59 файлов, 351,55 с. Настоящие NSIS updater/launcher и installed/compiled smoke успешны. |
| `LSP lifecycle (macos-latest)` | 56 pass, 0 fail; 8 файлов, 77,64 с; installed/compiled меню успешны. |
| `LSP lifecycle (windows-latest)` | 56 pass, 0 fail; 8 файлов, 111,91 с; installed/compiled меню успешны. |

Логи обеих платформ содержат успешный native clipboard case: Unicode copy/paste, нормализация переноса строк и сохранение редактора. Полный source остаётся Linux-проверкой; subset и smoke Windows/macOS не объявляются повтором всего source-набора.

Реальный вызов `GITHUB_REPOSITORY=TheAsrada/ChiselCode bun scripts/verify-release-ci.ts` во время очереди этого source завершился отказом `queued/null`. Старый зелёный native run другого коммита не принят. После завершения того же автоматического run команда завершилась успешно и подтвердила шесть обязательных jobs и все 42 обязательных steps на `82e3e7b9a41b27b8778b519954bc2778e798d051`.

Release workflow проверен через actionlint и unit-контракты YAML: checkout по сохранённому SHA, обязательные зависимости jobs, сверка тега и повторный gate до публикации. Настоящая публикация, создание draft/tag, полный внешний каталог LSP, платные live evals и запуск macOS x64 на Intel в этом задании не выполнялись.
