# Выпуск CLI 0.6.37

[Материалы участников](../README.md) · [Установка](../../installation.md) · [Потоковые ответы](../../architecture/provider-streams.md)

[CLI 0.6.37](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.37) опубликован 20 октября 2026 года с исправлением `chunk.choices[0]` и проверкой потоковых событий OpenAI/Anthropic. Исходный HEAD подготовки — `9c374ac`; подготовка выполнена прямо в `main`. Описание причины, обработки событий и регрессионных сценариев находится в [контракте потоковых ответов](../../architecture/provider-streams.md).

## Допуск к выпуску

Release source — `6cde1ef46a2f3d26dfefd93b2c4db13428847dc4`. [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/39360554783) успешна на этом SHA. Все четыре обязательных job [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/39360566319) завершились успешно; один раз повторялся только Windows job на том же source. Использовался Bun 1.4.2.

| Проверка | Фактический результат | Длительность job |
| --- | --- | ---: |
| Полный source, Ubuntu | 1313 pass, 3 skip, 0 fail, 165 файлов; тесты 330,91 с; typecheck/lint, eval и дополнительные UI-сценарии успешны | 389 с |
| Native Ubuntu | Установленный npm-пакет, compiled CLI/OpenTUI, внешние расширения, Settings/MCP/skills | 149 с |
| Native macOS | 312 pass, 3 skip, 0 fail, 40 файлов; тесты 75,80 с; installed/compiled smoke | 197 с |
| Native Windows, повтор | 314 pass, 1 skip, 0 fail, 40 файлов; тесты 159,41 с; реальный NSIS updater и installed/compiled smoke | 431 с |

Полный source-набор выполнен один раз на Linux. Установленный CLI на всех трёх ОС прошёл сценарий с локальным HTTP-сервером, gateway SSE → tool → model → checkpoint: heartbeat, finish без delta и usage без choices. От первоначального запуска Native workflow до конца последнего job прошло 867 с, включая диагностику и повтор Windows; это время ожидания, а не сумма runner minutes.

### Первый Windows-прогон

В [первой попытке](https://github.com/TheAsrada/ChiselCode/actions/runs/39360566319/attempts/1) Windows platform step завершился с 312 pass, 1 skip и 2 fail, 209,96 с. `background-process.test.ts` получил `exitCode: null` вместо 0 в сценарии inherited output после выхода лидера, 11,34 с при deadline 10 с. `subagent-lifecycle.test.ts` превысил общий deadline 20 с в сценарии admission/cancellation/storage. Windows job занял 276 с и до installed/compiled smoke не дошёл.

Эти тесты и код background/subagents не менялись относительно 0.6.36. Предположены временные задержки runner; их системная причина не установлена. Выполнен один повтор всего Windows job на том же SHA, без изменения кода, assertions и deadlines. Те же сценарии прошли за 1,75 с и 4,01 с; затем прошли реальные updater, installed/compiled CLI и OpenTUI. Успешные jobs Linux/macOS не повторялись.

Production `verify-release-ci.ts` подтвердил четыре успешных обязательных job на точном source до создания и отправки annotated tag `v0.6.37`. Тег указывает на проверенный SHA; опубликованные теги и assets не заменяются.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/39361890462) завершил все шесть jobs успешно. Он повторно подтвердил Native CI точного source, собрал и опубликовал четыре установщика и npm-архив CLI/SDK. GitHub API подтвердил latest `v0.6.37`, не draft/prerelease, и annotated tag с source `6cde1ef46a2f3d26dfefd93b2c4db13428847dc4`.

Все пять опубликованных файлов скачаны. Размеры и SHA-256 совпали с GitHub API; форматы EXE/PKG/DEB/tgz проверены по сигнатурам файлов.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-Setup-0.6.37-linux-amd64.deb` | 36997134 | `bf09e79988e40decaba0ee96488e5af7e7383397cfe2a5bfb91f46285ea35345` |
| `ChiselCode-Setup-0.6.37-macos-arm64.pkg` | 33359819 | `236c6aee048b9f70fd738b8d08e895fe093960eaa4c4a1e4464993300beb8dfa` |
| `ChiselCode-Setup-0.6.37-macos-x64.pkg` | 35944808 | `2248c95ae30aba6d4a37324acfed849bc24b15323be740b9cffcc724711a8a95` |
| `ChiselCode-Setup-0.6.37.exe` | 38737982 | `bc4fd1b60e0ef98bfb4d7a85967b90d5fb9462a2d5b0ba903372c15c8e61402b` |
| `chiselcode-0.6.37.tgz` | 5863477 | `b2d06b20ea8a26e8f3e789ead0834a955dafb4ac4024bf8abcb8c03036365b22` |

Извлечённый опубликованный DEB и CLI, установленный из опубликованного npm-архива в изолированный prefix, показали `0.6.37`. Оба прошли успешный сценарий с локальным HTTP-provider, gateway SSE → tool → model → persisted checkpoint и отрицательный `--malformed-stream`: понятный `transport`, одна HTTP-попытка, отсутствие исполненных инструментов и сохранённая причина ошибки.

`update --json` опубликованного Linux-бинарника получил latest `0.6.37`, `updateAvailable: false` и все пять файлов с SHA-256. Публичный SDK импортируется отдельно (`API_VERSION=1`), declarations присутствуют. Три встроенных навыка в DEB/npm побайтово совпали с release tag source. npm-архив опубликован в GitHub Release.

Установка npm под Node 24.19.0 завершилась с предупреждением engine зависимости OpenTUI о Node ≥26.4; CLI и smoke выполнялись под поддерживаемым Bun 1.4.3.

Release проверил запуск Windows x64, Linux x64 и macOS ARM64. macOS x64 собран; запуск на Intel не проверялся. Установщики Windows/macOS не подписаны. GUI полного мастера установки и физические терминалы вручную не проверялись; Windows updater проверялся настоящим NSIS и консольными процессами в CI. Результаты публикации записаны отдельным коммитом документации в `main`; release source, tag и assets не изменялись.
