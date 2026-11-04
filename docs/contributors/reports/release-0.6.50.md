# Выпуск CLI 0.6.50

[Материалы для участников](../README.md) · [Установка](../../installation.md) · [Кадры выбора папки](../../assets/folder-picker/README.md)

[CLI 0.6.50](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.50) опубликован 04.11.2026 в 09:23:38 UTC и подтверждён как latest, без draft/prerelease. Выпуск включает сохранение последнего явно выбранного профиля и модели, упрощённый выбор папки и восстановление занятости проекта после прерванных команд. [Изменения выпуска](../../../CHANGELOG.md#0650---2026-11-04).

Release source — `03856a5fb3ebd8ec4216cddc4482687ccea57250` из `main`. Annotated tag `v0.6.50` указывает на этот SHA; объект тега — `696e96efc9d5cce7100b1d3c5273bda73bd97266`. Версии `package.json`, обеих записей `package-lock.json` и `src/version.ts` равны 0.6.50. Код продукта совпадает с `eea402027d75ab54c0cbbd583c7e14315443ddab`, кроме версии. Последующее обновление документации не меняет tag и assets.

## Проверки release source

[Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/41804772327), [Docs CI](https://github.com/TheAsrada/ChiselCode/actions/runs/41804772437) и [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/41804772269) прошли на точном source. Все шесть обязательных jobs и steps успешны с первой попытки. Штатный `scripts/verify-release-ci.ts` подтвердил допуск перед созданием тега; Release повторил проверку перед сборкой и публикацией.

| Job | Результат | Время job |
| --- | --- | ---: |
| Full source, Linux | 1539 pass, 3 skip, 0 fail; JUnit подтвердил все 196 файлов и 1542 теста; документация, typecheck, lint, eval и заключительные UI-fixtures прошли | 444 с |
| Native Linux | Installed CLI/SDK, compiled CLI, настоящие TS/Python и OpenTUI прошли | 229 с |
| Native macOS | 488 pass, 3 skip, 0 fail в 63 файлах; installed/compiled smoke и native clipboard прошли | 415 с |
| Native Windows | 490 pass, 1 skip, 0 fail в 63 файлах; реальный updater, ярлыки, installed/compiled smoke и native clipboard прошли | 799 с |
| LSP lifecycle, macOS | 56 tests в 8 файлах и installed/compiled меню прошли | 178 с |
| LSP lifecycle, Windows | 56 tests в 8 файлах и installed/compiled меню прошли | 229 с |

Полный source-набор выполнен один раз на Linux: 386,12 с. От создания Native run до завершения прошло 802 с (13 мин 22 с), сумма длительностей шести jobs — 2294 с (38 мин 14 с). Это timestamps GitHub API, а не оценка оплачиваемого времени. Повторы и изменения таймаутов не потребовались.

Предыдущий [Native run на `eea4020`](https://github.com/TheAsrada/ChiselCode/actions/runs/41686197012) не получил macOS runners: GitHub сообщил `The job was not acquired by Runner of type hosted even after multiple attempts` и capacity constraints. Эти jobs не начали тесты. Для допуска 0.6.50 использован успешный полный run нового release source.

Локально на Linux с Bun 1.4.2 прошли 506 быстрых тестов в 54 файлах за 7,79 с, typecheck, JS/SDK build и запуск CLI с версией 0.6.50. Lint завершился без ошибок, с 446 warnings и 58 infos. Проверка документации перед выпуском подтвердила 140 страниц, 1598 локальных ссылок и 0 ошибок. Пересекающиеся наборы не суммируются.

Три Linux skips относятся к двум Windows-only shell-сценариям и native clipboard без desktop display. macOS пропускает два Windows-only сценария и Linux detached orphan; Windows — только detached orphan. Файлы `project-navigation.test.ts`, `opentui-projects.test.tsx`, `model-preference.test.ts`, `project-startup.test.ts` и `background-recovery.test.ts` целиком включены в платформенный subset. Реальная перезагрузка компьютера для проверки legacy claims не выполнялась; она не подменяется успешными crash/recovery fixtures.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/41806727294) завершил все шесть jobs успешно на том же source. От создания run до завершения прошло 169 с, сумма длительностей jobs — 258 с. Перед публикацией повторно проверены source тега и Native validation. API подтвердил ровно пять assets в состоянии `uploaded`: четыре установщика и npm-пакет CLI с SDK. Архив опубликован в GitHub Release; публикация в npm registry этим workflow не выполняется.

Все пять файлов скачаны в отдельный каталог. Локальные размеры и SHA-256 совпали с Release API.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `chiselcode-0.6.50.tgz` | 5942375 | `a7f23d71e8fa78974c0f2658e6fd6a8a32b212778212b12dda48075ca525973f` |
| `ChiselCode-Setup-0.6.50-linux-amd64.deb` | 37050440 | `a63d6d9addbdf8c4a3c8442fd65d06ff4b9d22ce9f145e67c0139b698ad49afc` |
| `ChiselCode-Setup-0.6.50-macos-arm64.pkg` | 33440057 | `b62742c12ed0577454cb811ca062c94450d06b95eb5585423efa66772f86f8e0` |
| `ChiselCode-Setup-0.6.50-macos-x64.pkg` | 36026237 | `a8d76d6dc3288246acc7e0f1fd9884b7b80ad4779054852aaf635404c1b9d665` |
| `ChiselCode-Setup-0.6.50.exe` | 38792599 | `834cc5f1c7df45760a5d305e296a2b0b31d834242056dbae040bc3b0405f61ee` |

Linux DEB извлечён через `dpkg-deb --extract` без системной установки. Metadata подтвердили `chiselcode`, `0.6.50` и `amd64`; извлечённый бинарник вернул 0.6.50 и прошёл `manifest-cli.ts`: настоящий локальный API → инструмент → API → сохранённая сессия.

npm-архив установлен в отдельный prefix с `--ignore-scripts` и зависимостями из npm registry. CLI через Bun 1.4.2 вернул 0.6.50 и прошёл тот же manifest smoke; SDK declarations и встроенный навык создания расширений присутствуют. Первая установка с `--offline` остановилась на `ENOTCACHED` из-за отсутствующей metadata зависимостей в локальном npm cache; обычная установка прошла. npm сообщил `EBADENGINE` для Node 24.22.1 при требовании OpenTUI Node ≥26.4.0; исполнение пакета через Node не проверялось.

После публикации обновлены установка, выбор модели, галерея выбора папки и оглавление выпусков. Итоговый `bun run docs:check` подтвердил 141 страницу, 1605 локальных ссылок и 0 ошибок. Настоящие кадры OpenTUI и их исходные spans сохранены в [галерее](../../assets/folder-picker/README.md); новые изображения для выпуска не создавались.

## Ограничения проверки

Полный source-набор выполнен на Linux; Windows/macOS получили платформенные tests, LSP lifecycle и installed/compiled smoke. Опубликованные Windows EXE и macOS PKG локально на Linux проверены по размеру и SHA-256; их запуск после скачивания и ручная GUI-установка не выполнялись. Linux DEB проверен извлечением и запуском payload, без системной установки.

macOS x64 собирается на arm64 runner; запуск на Intel Mac не подтверждён. Физические терминалы, Windows ARM64, Linux ARM64 и другие дистрибутивы отдельного покрытия здесь не получили. Release workflow создаёт Windows/macOS установщики без подписи; notarization macOS не выполняется. Отдельный концепт ChiselCodeDesktop не изменялся и не выпускался.
