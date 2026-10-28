# Выпуск CLI 0.6.43

[Материалы для участников](../README.md) · [Установка](../../installation.md) · [Навыки](../../skills.md) · [Архитектура установки](../../architecture/skill-installation.md)

[CLI 0.6.43](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.43) опубликован 28.10.2026 в 13:03:49 UTC+05:00 (Asia/Yekaterinburg). Выпуск исправляет установку навыков после неверного `revision`, выбор стандартного каталога при совпадении имён и сообщения об ошибках GitHub. Подробности поведения — в [руководстве по навыкам](../../skills.md#установить-по-ссылке-или-команде) и [CHANGELOG](../../../CHANGELOG.md#0643---2026-10-28).

Release source — `2fbbebbe881d5243914c2816569dcf498213c0c8` из `main`. Версии `package.json`, корневого `package-lock.json` и `src/version.ts` синхронизированы. Annotated tag `v0.6.43` создан после допуска четырёх обязательных jobs и указывает на этот source; объект тега — `13e8c617fc069f23eb1a7134968898b8ceb5935c`.

## Проверки release source

[Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/40652237401), [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/40652226990) и [Docs CI](https://github.com/TheAsrada/ChiselCode/actions/runs/40652227301) прошли на точном release source. Native CI использовал Bun 1.4.2; все четыре jobs завершились с первой попытки, без повторов. Перед тегом `verify-release-ci.ts` подтвердил допуск; Release повторно проверил тот же source через GitHub API.

| Job | Результат | Время job |
| --- | --- | ---: |
| Full source, Linux | 1432 pass, 3 skip, 0 fail; 1435 тестов в 180 файлах за 368,55 с; typecheck, lint, eval и дополнительные UI-fixtures прошли | 420 с |
| Native Linux | Installed npm/SDK, compiled CLI и OpenTUI-сценарии прошли | 188 с |
| Native macOS | 416 pass, 3 skip, 0 fail; 419 тестов в 49 файлах за 151,76 с; installed/compiled smoke прошли | 361 с |
| Native Windows | 418 pass, 1 skip, 0 fail; 419 тестов в 49 файлах за 390,57 с; реальный updater, installed/compiled smoke и UI прошли | 850 с |

Полный source-набор выполнен один раз на Linux. Windows/macOS получили платформенный набор и проверки поставки; пересекающиеся результаты не суммируются. Локально прошли 476 быстрых тестов, typecheck, JS/SDK build, проверка документации и запуск CLI с версией 0.6.43. Lint в CI сохраняет 400 прежних предупреждений и 58 информационных замечаний, блокирующих ошибок нет.

Проверки навыков подтверждают отклонение нулевого SHA до сети и записи, поддержку `null`, сохранение явной версии, выбор стандартного каталога и полного пути, сообщения 422/429, ограниченное чтение JSON-ошибок, отмену, разрешения, SSRF, integrity и атомарную публикацию. Отдельно прошёл сценарий сжатия контекста расширений: небольшой запас для истории рассчитывается сверх текущего каталога инструментов, а автоматическое и аварийное сжатие проверяются явно.

От создания Native workflow до завершения последнего job прошло 854 с (14 мин 14 с). Суммарное время jobs — 1819 с (30 мин 19 с runner time). Эти длительности относятся к этому прогону CI.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/40653831063) завершил все шесть jobs успешно с первой попытки: допуск source, сборки Windows/macOS/Linux и npm/SDK, публикация. Release API подтвердил `v0.6.43`, отсутствие draft/prerelease и пять assets в состоянии `uploaded`. npm-пакет доступен в GitHub Release как архив `chiselcode-0.6.43.tgz`.

Все пять опубликованных файлов скачаны; их размеры и SHA-256 совпали с Release API.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-Setup-0.6.43-linux-amd64.deb` | 37025478 | `5f8121d5a2003477aec77bb5ddca95b62a6dd2a2af07af0fd835e881e9d7b4b7` |
| `ChiselCode-Setup-0.6.43-macos-arm64.pkg` | 33405065 | `b785e405aa277ecdd4d4ca91b8c4fd52a8280309509d1dee77c14e1675c462f5` |
| `ChiselCode-Setup-0.6.43-macos-x64.pkg` | 35992847 | `e1c3c052c36e2bb60fbee4e0c2d68e903786e236f7ca2805cce5e897505dfa1e` |
| `ChiselCode-Setup-0.6.43.exe` | 38757008 | `7e3db85af0ec9feebc6b9578dde494b938cf432e4443a55279b150874b7c5290` |
| `chiselcode-0.6.43.tgz` | 5907865 | `50dea1270428f94bc111967caa637548a9f80b3ad5c35b961126db6b6a2a9ece` |

Linux binary запущен из распакованного временного DEB; npm-пакет установлен в отдельный временный каталог. DEB manifest, binary и обычный CLI вернули 0.6.43. Обе опубликованные поставки прошли `skill-install-cli.ts`: исправление нулевого SHA до сети, выбор `skills/caveman`, HTTPS/TLS/proxy и немедленная загрузка инструкций и справки через штатные инструменты. Библиотеки и проекты fixture изолированы от пользовательских данных.

`update --json` у опубликованного Linux binary подтвердил `current: 0.6.43`, `latest: 0.6.43`, `updateAvailable: false` и пять assets с теми же размерами и контрольными суммами. В установленном npm-пакете проверены обычный CLI, declarations extension SDK и UI composition, встроенный `extension-creator`.

После публикации обновлены руководство установки и индекс отчётов. Последующий коммит содержит только документацию; tag и файлы выпуска привязаны к release source выше.

## Ограничения проверки

Полный source-набор выполнен на Linux; Windows/macOS имеют платформенные проверки и smoke поставки. На Linux пропущены системный clipboard без desktop-сессии и две Windows-only проверки CMD/Python. На macOS пропущены detached orphan и две Windows-only проверки; на Windows — detached orphan.

CLI-сценарий установки использует управляемые совместимые API и настоящий транспорт; он проверяет выполнение инструментов в поставке. Качество ответов живых моделей разных провайдеров этим сценарием не проверяется.

macOS installers собраны на ARM64 runner. Intel-пакет проверен сборкой; отдельный запуск на Intel Mac и ручной GUI-прогон установщиков на физических устройствах не выполнялись. Установщики не подписаны; нотариальная проверка macOS не выполнялась.
