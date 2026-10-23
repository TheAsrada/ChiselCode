# Выпуск CLI 0.6.39

[Материалы участников](../README.md) · [Установка](../../installation.md) · [Диагностика `web_fetch`](web-fetch-diagnostics.md)

[CLI 0.6.39](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.39) опубликован 23 октября 2026 года. Выпуск содержит диагностику отказов HTTP и неполного статического содержимого `web_fetch`, а также безопасную для UTF-8 обрезку превью результатов инструментов.

Release source — `88aa84e5d642a4b683c6096f6062bf4add371ca5`, подготовлен и отправлен прямо в `main`. Annotated tag `v0.6.39` указывает на этот source. Публикация завершилась 23 октября 2026 в 05:09 UTC.

## Проверки release source

[Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/39902902208) успешно завершилась на точном release source. Все четыре обязательные jobs прошли: полный Linux source и smoke для Ubuntu, macOS и Windows.

Полный source на Ubuntu и Bun 1.4.2: 1339 успешных тестов, 3 пропуска, 0 ошибок, 11991 проверка ожиданий; всего 1342 теста в 170 файлах за 323,31 с. На Linux пропущены три платформенные проверки: системный буфер обмена, команды CMD и вывод Windows Python. Typecheck, lint, eval и OpenTUI/extension fixtures также завершились успешно. Native smoke собрали CLI/SDK и проверили установленные и compiled варианты, включая LSP, MCP, навыки, расширения, инструменты и обновление Windows.

В текущем execution-контейнере Bun не установлен, поэтому локальные команды не запускались. Source, native и сборки установщиков выполнены GitHub Actions на закреплённом Bun 1.4.2.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/39903857676) успешно завершил все шесть jobs. GitHub Release API подтвердил опубликованный релиз без draft/prerelease, tag `v0.6.39` и пять загруженных файлов.

Все пять файлов скачаны с GitHub Releases. Размеры совпали с метаданными релиза, а SHA-256 каждого совпал со значением из `chisel update --json` опубликованного Linux binary.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-Setup-0.6.39.exe` | 38739107 | `d68b3ef355866a4790edf1ccac82abfe1b7c2a49b948aff3f49a9954b8c58f4b` |
| `ChiselCode-Setup-0.6.39-macos-arm64.pkg` | 33374559 | `ca65316f654505196e76f7b4e7df0772babc975e2a9513bd3069fed07239384b` |
| `ChiselCode-Setup-0.6.39-macos-x64.pkg` | 35963917 | `20434206a591e2e3e5fabaad20c0ce09a375f9d0ecec699f62b2759b590d53a2` |
| `ChiselCode-Setup-0.6.39-linux-amd64.deb` | 37011882 | `97e37781f4382b45588017634acdf905959d8fa4b633d713bf99630c459ab3cc` |
| `chiselcode-0.6.39.tgz` | 5882438 | `4198df7547d5e9a9a99420d9245e0c28b2a2808e4a5b67d96d371168a2e311e5` |

Извлечённый из опубликованного DEB binary показал `0.6.39`. Его `update --json` сообщил `current` и `latest` `0.6.39`, `updateAvailable: false` и все пять опубликованных assets. npm-архив содержит `chiselcode@0.6.39` и публичные declarations extension SDK.

Native CI запускался на трёх ОС. macOS x64 package собран, но отдельного запуска на физическом Intel Mac не было; GUI установщиков вручную не запускался. Workflow не подписывает установщики. Полный source suite повторно для каждого формата поставки не запускался.
