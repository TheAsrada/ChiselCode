# Выпуск CLI 0.6.51

[Материалы для участников](../README.md) · [Установка](../../installation.md) · [Диагностика ожидания модели и LSP](provider-wait-and-lsp.md)

[CLI 0.6.51](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.51) опубликован 9 ноября 2026 года в 21:32:31 (UTC+05:00). Изменения включают ограничение пауз в потоке ответа, отдельные статусы модели и инструментов, повтор диагностики после тайм-аута подготовки LSP, подключение ChatGPT и автосохранение Settings. [История изменений](../../../CHANGELOG.md#0651---2026-11-09).

Тег `v0.6.51` указывает на исходный коммит `667ed44f1dc819e8a118c4b4ecae5a7dfe5f1f86` из `main`. Объект аннотированного тега — `0ac70121a6938b3ead9ff34702283d0f77db6dad`. Версии в `package.json`, обеих записях `package-lock.json` и `src/version.ts` совпадают.

## Проверки исходников

[Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/42652714142) и [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/42652713835) прошли на коммите тега. Скрипт допуска подтвердил все шесть обязательных задач и их шаги до отправки тега. Release повторил проверку перед сборкой и публикацией.

| Задача | Результат | Длительность |
| --- | --- | ---: |
| Full source, Linux | 1573 прошли, 3 пропущены по условиям платформы. JUnit подтвердил 201 файл и 1576 тестов. Документация, typecheck, lint, eval и дополнительные UI-сценарии прошли | 410 с |
| Native smoke, Linux | Installed CLI и SDK, compiled CLI, реальные LSP и OpenTUI | 219 с |
| Native smoke, macOS | Платформенные тесты, native clipboard, installed и compiled smoke | 430 с |
| Native smoke, Windows | Платформенные тесты, updater, ярлыки, native clipboard, installed и compiled smoke | 875 с |
| LSP lifecycle, macOS | Тесты конфигурации, отмены, процессов и меню, installed и compiled smoke | 183 с |
| LSP lifecycle, Windows | Тесты конфигурации, отмены, процессов и меню, installed и compiled smoke | 184 с |

Native validation заняла 892 с от создания до завершения. Сумма длительностей шести задач — 2301 с. Полный набор Linux выполнен за 356,86 с. Два Windows-only сценария оболочки и native clipboard без графической сессии пропущены на Linux.

[Предыдущий прогон](https://github.com/TheAsrada/ChiselCode/actions/runs/42651038955) на `cf7be85` обнаружил два сбоя интеграционных проверок. Одно ожидание относилось к прежнему статусу «Думаю», а фикстура агента передавала `AbortSignal` в `structuredClone`. Сценарии исправлены и прошли локально, затем весь набор прошёл на новом SHA. Код продукта между этими коммитами совпадает. [Реальный HTML LSP](https://github.com/TheAsrada/ChiselCode/actions/runs/42651166702) проверен на Linux, macOS и Windows на `cf7be85`.

На Linux локально прошли 525 быстрых тестов, 27 проверок LSP lifecycle/transport, typecheck, lint и сборки JS/SDK и compiled CLI. В тесте с heartbeat после завершённой команды собранный CLI прекратил ожидание за 60,03 с, разорвал соединение и сохранил `timeout` и единственный результат команды. В проверке LSP с принудительным тайм-аутом загрузки следующая диагностика запустила реальный HTML-сервер и вернула результат `current`. Локальный профиль `work2` с `claude-haiku-5-5` получил `ExceededBudget` как на установленном 0.6.50, так и на 0.6.51 из локального npm-архива.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/42655312154) завершил шесть задач на том же SHA за 178 с. GitHub подтвердил публикацию версии как latest, четыре установщика и npm-архив с CLI и SDK. Архив доступен в GitHub Release. Публикация в npm registry в этот процесс не входит.

| Файл | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-Setup-0.6.51-linux-amd64.deb` | 37065010 | `a8cfd02050be9cfec5705a235b3c9e7fd52191051bfb4f27deb4a4e390107b27` |
| `ChiselCode-Setup-0.6.51-macos-arm64.pkg` | 33456047 | `89ea7f3ff1cea5d89607c249f4653045727db0041354835a2fd07058e9c159b3` |
| `ChiselCode-Setup-0.6.51-macos-x64.pkg` | 36039115 | `6adb3fec8d8fed8e622fbf32e3366b6ac729c9dd13afa15e37fe2e369d4c49f9` |
| `ChiselCode-Setup-0.6.51.exe` | 38793164 | `f52ee936c80d520bf8f98317f456f2d94eb9980e6e1353a32cd7551a05a319b1` |
| `chiselcode-0.6.51.tgz` | 5956789 | `6a1907f709fe1a38f38b544c6b655d309012aa1e99ba008661db118ddbaca268` |

Размеры и SHA-256 всех скачанных файлов совпали с GitHub Release API. Из Linux DEB извлечён бинарник через `ar` и `bsdtar`. Метаданные подтвердили `chiselcode`, `0.6.51` и `amd64`. Бинарник сообщил версию 0.6.51 и прошёл сценарий с локальным API, выполнением инструмента и сохранением разговора. Тот же сценарий прошёл для CLI из опубликованного npm-архива, установленного в отдельный prefix. В архиве проверены декларации SDK.

## Ограничения проверки

Полный набор исходных тестов выполнен на Linux. macOS и Windows прошли свои платформенные проверки, LSP lifecycle и smoke. Скачанные EXE и PKG локально проверены по размеру и SHA-256. Ручная установка через Windows и macOS не выполнялась. Пакет macOS x64 собран на arm64 runner, запуск на Intel Mac не проверен. Установщики Windows и macOS выпущены без подписи. Нотаризация macOS не выполнялась.
