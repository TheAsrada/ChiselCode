# Выпуск CLI 0.6.42

[Материалы для участников](../README.md) · [Установка](../../installation.md) · [Навыки](../../skills.md) · [Архитектура установки](../../architecture/skill-installation.md)

[CLI 0.6.42](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.42) опубликован 25.10.2026 в 22:47:48 UTC+05:00 (Asia/Yekaterinburg). Выпуск добавляет штатную установку внешних навыков по ссылке или команде `npx skills add … --skill …`, проверку пакетов и чтение справочных файлов навыка в той же задаче. Документация разделена на пользовательские руководства, архитектуру и отчёты; локальные ссылки и навигацию проверяет отдельный Docs CI.

Release source — `ab847af6bcf9fd1cd9cd5ecd8b093c9d7dd3ded6` из `main`. Версии `package.json`, корневого `package-lock.json` и `src/version.ts` синхронизированы. Annotated tag `v0.6.42` создан после успешного допуска четырёх обязательных jobs и указывает на этот source; объект тега — `6aea0f6472e67d06459cf8beab7ec0eaf206415d`.

## Проверки release source

[Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/40216822538), [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/40216820796) и [Docs CI](https://github.com/TheAsrada/ChiselCode/actions/runs/40216820771) прошли на точном release source. Native CI использовал Bun 1.4.2; все четыре jobs завершились с первого раза, без повторов. Перед тегом `verify-release-ci.ts` подтвердил допуск; Release повторно проверил тот же source через GitHub API.

| Job | Результат | Время job |
| --- | --- | ---: |
| Full source, Linux | 1415 pass, 3 skip, 0 fail; 1418 тестов в 180 файлах за 282,59 с; typecheck, lint, eval и дополнительные source UI-fixtures прошли | 326 с |
| Native Linux | Installed npm/SDK, compiled CLI и OpenTUI-сценарии прошли | 180 с |
| Native macOS | 399 pass, 3 skip, 0 fail; 402 теста в 49 файлах за 152,65 с; installed/compiled smoke прошли | 388 с |
| Native Windows | 401 pass, 1 skip, 0 fail; 402 теста в 49 файлах за 382,94 с; реальный updater, installed/compiled smoke и UI прошли | 821 с |

Полный source-набор выполнен один раз на Linux. Windows/macOS получили платформенный набор и проверки поставки. Пересекающиеся результаты не суммируются. Локально прошли 471 быстрый тест, проверки допуска релиза и согласованности документации провайдеров, typecheck, lint, JS/SDK build и запуск CLI с версией 0.6.42. Lint сохраняет 401 прежнее предупреждение и 58 информационных замечаний, блокирующих ошибок нет.

Проверки навыков включают выбор источника, закрепление коммита, blob integrity, бинарные файлы, отмену параллельной загрузки с сохранением первопричины, конфликты, portable paths, сетевые разрешения и чтение инструкций/справки в одной задаче. Installed и compiled CLI на трёх ОС прошли обычный HTTPS/TLS/proxy-сценарий с изолированной библиотекой.

От создания Native workflow до завершения последнего job прошло 824 с (13 мин 44 с). Суммарное время jobs — 1715 с (28 мин 35 с runner time). Эти длительности относятся к CI.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/40217954076) завершил все шесть jobs успешно: допуск source, сборки Windows/macOS/Linux и npm/SDK, публикация. Release API подтвердил `v0.6.42`, отсутствие draft/prerelease и пять assets в состоянии `uploaded`. npm-пакет опубликован в GitHub Release как архив `chiselcode-0.6.42.tgz`.

Все пять опубликованных файлов скачаны; их размеры и SHA-256 совпали с Release API.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-Setup-0.6.42-linux-amd64.deb` | 37031872 | `5452e26b7608a5913b1fcdb7e542979e38b49b01d9d57ecdecd92a601aeaf6ab` |
| `ChiselCode-Setup-0.6.42-macos-arm64.pkg` | 33401866 | `4a0bf84d1c28ae2fb87de635ff9618359ba9b5fd868b27fd055908f635e7d558` |
| `ChiselCode-Setup-0.6.42-macos-x64.pkg` | 35988561 | `cffd7bf1aab2d6682a518791a7f82f27214e56bb99b528687afc388cf2eafc43` |
| `ChiselCode-Setup-0.6.42.exe` | 38757765 | `e2714b234265b48e242114ddf443d62b8aeb22bff24dcc761fbe277b6530eb54` |
| `chiselcode-0.6.42.tgz` | 5904694 | `df76b68f396f2c930d699ba9479c6b07c190eaf7122829340f068f09b4329de0` |

Linux binary запущен из распакованного временного DEB; npm-пакет установлен в отдельный временный каталог. DEB manifest, binary и обычный CLI вернули 0.6.42. Обе опубликованные поставки прошли `skill-install-cli.ts`: HTTPS-загрузка, закреплённый snapshot, сохранение бинарного asset и чтение инструкций/справки в той же задаче.

`update --json` у опубликованного Linux binary подтвердил `current: 0.6.42`, `latest: 0.6.42`, `updateAvailable: false` и пять assets с теми же размерами и контрольными суммами. npm-архив содержит обычный CLI, declarations extension SDK и UI composition, встроенный `extension-creator`.

После публикации обновлены руководство установки, справка навыков и индекс отчётов. Последующий коммит содержит только документацию; tag и файлы выпуска привязаны к release source выше.

## Ограничения проверки

Полный source-набор выполнен на Linux; Windows/macOS имеют платформенные проверки и smoke поставки. На Linux пропущены системный clipboard без desktop-сессии и две Windows-only проверки CMD/Python. На macOS пропущены detached orphan и две Windows-only проверки; на Windows — detached orphan.

macOS installers собраны на ARM64 runner `macos-26-arm64`. Intel-пакет проверен сборкой; отдельный запуск на Intel Mac и ручной GUI-прогон установщиков на физических устройствах не выполнялись. Установщики не подписаны; нотариальная проверка macOS не выполнялась.
