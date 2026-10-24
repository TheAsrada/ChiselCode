# Выпуск CLI 0.6.40

[Материалы участников](../README.md) · [Установка](../../installation.md) · [Менеджер и настоящие кадры](worktree-manager-0.6.40.md) · [Разбор провайдера](provider-client-diagnostics.md)

[CLI 0.6.40](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.40) опубликован 24 октября 2026 года в 14:56:33 UTC после успешной проверки release source. Выпуск включает графический менеджер рабочих копий, исправления параметров shell, формата запросов Chat Completions, диагностики HTTP 400 и границ Git-инструментов.

Release source — `f987268db7c0344107720e6787fa12057b93c956`, отправлен прямо в `main`. Annotated tag `v0.6.40` создан после прохождения всех обязательных jobs и указывает на этот source; объект тега — `c688bc0e304605192c6950887ef3f825e10a4cfd`.

## Проверки release source

[Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/40103615424) прошёл на точном source с Bun 1.4.2. [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/40103614606) также успешен.

| Job | Результат | Время job |
| --- | --- | --- |
| Native smoke (windows-latest) | Успешно | 12 мин 35 с |
| Native smoke (macos-latest) | Успешно | 4 мин 22 с |
| Full source (ubuntu-latest) | Успешно | 6 мин 48 с |
| Native smoke (ubuntu-latest) | Успешно | 2 мин 33 с |

Полный Linux source: **1357 pass, 3 skip, 0 fail**, 12092 expect-вызова, 1360 тестов в 173 файлах за 345,98 с. На Linux пропущены системный clipboard и две проверки CMD/Windows Python. Typecheck, lint, eval и дополнительные OpenTUI/extension fixtures также прошли. Lint не содержит блокирующих ошибок; прежние предупреждения не отключались.

Дополнительный платформенный набор из 359 тестов в 45 файлах: Windows — 358 pass, 1 skip, 0 fail за 358,98 с; macOS — 356 pass, 3 skip, 0 fail за 106,58 с. Пропуск Windows относится к проверке detached orphan; пропуски macOS — detached orphan и две проверки CMD/Windows Python.

На трёх ОС прошли installed npm и compiled smoke, настоящий OpenTUI, инструменты, рабочие копии, LSP, MCP, навыки и расширения. Compiled production-сценарий нового менеджера на каждой ОС создал копию через настоящий Git approval, выполнил обычный model → read/write → model, сохранил origin до переноса, показал diff, перенёс результат с проверкой fingerprints, вернулся в origin, закрыл вкладку, отказал в опасном удалении и удалил отдельную чистую копию. Проверены resize и отсутствие лишних модельных запросов/представлений чата. Windows дополнительно прошёл реальное обновление исполняемого файла и перезапуск консоли.

### Первый кандидат и исправление проверки

[Первый Native run](https://github.com/TheAsrada/ChiselCode/actions/runs/40102935183) на `d07116b20629d9018c152ae6f85f8f022184c23f` не прошёл Windows: новый тест fingerprints с несколькими реальными Git-процессами прервался по стандартному лимиту Bun 5000 мс. Остальные 357 тестов Windows-набора прошли, один пропущен; полный Linux source и оба native job Linux/macOS были успешны.

Следующий коммит изменил только deadlines двух новых Git-сценариев на конечные 30000 мс. Assertions и production-код не менялись. Локально оба сценария прошли за 2,78 с. На Windows тест fingerprints успешно завершился за **12967,30 мс**, что подтверждает недостаточность прежних 5 секунд и соблюдение новой границы. На итоговом source заново прошли все четыре обязательные jobs; первый run не используется как допуск релиза. Поэтому полный Linux source выполнен по одному разу на каждом из двух кандидатов, без повторов для каждого установщика.

Локально на Linux/Bun 1.4.4 до публикации прошли быстрый профиль (438 pass), целевые runtime/UI-наборы, source-сценарий обеих тем, compiled fixture менеджера, typecheck/lint/build/compile, installed npm manifest и compiled CLI manifest/worktree smoke. Эти пересекающиеся наборы не суммируются с CI.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/40104570998) успешно завершил все шесть jobs: повторную проверку допуска точного коммита, сборки Windows/macOS/Linux, npm/SDK и публикацию. GitHub Release API подтвердил tag `v0.6.40`, отсутствие draft/prerelease и пять assets со статусом `uploaded`. Заметки опубликованы по-русски с абсолютными ссылками на справку.

Все пять файлов скачаны из опубликованного выпуска. Их размеры и SHA-256 совпали с Release API и данными `update --json` из опубликованного Linux binary.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-Setup-0.6.40-linux-amd64.deb` | 37016592 | `5ad94c52a0b83d6e43d7cc331b0a0e68955e0c47fcbbba1d2700c04a6c34ab9e` |
| `ChiselCode-Setup-0.6.40-macos-arm64.pkg` | 33388661 | `ef3fd392107cdcf396131ef96893533a0c6559176a042240c20f96f9724aaca8` |
| `ChiselCode-Setup-0.6.40-macos-x64.pkg` | 35973921 | `a27efd0e969d4cec89ced24a8203d7de02eb60542bebc79573cede35e10ef9bd` |
| `ChiselCode-Setup-0.6.40.exe` | 38747056 | `b45be7888108911bff949d90ed639159f2be722b0a076ba48d9e715077a69ffc` |
| `chiselcode-0.6.40.tgz` | 5893277 | `fa49fcd5a1e13ee93d759583af0d21fe35c8ce080615fd903a81e14f12631c35` |

Исполняемый файл извлечён из опубликованного DEB без установки в систему: `--version` вернул `0.6.40`, `update --json` — `current: 0.6.40`, `latest: 0.6.40`, `updateAvailable: false` и все пять assets с совпадающими контрольными суммами. npm-архив содержит `chiselcode@0.6.40`, declarations extension SDK, `ui-composition.d.ts` и встроенный `extension-creator`.

Обновлены установка, справка рабочих копий и провайдеров, архитектура, решение проблем и оглавления. После публикации проверены 14 изменённых Markdown-файлов и 229 относительных ссылок, anchors и изображений; новый отчёт достижим из обоих оглавлений. До source-коммита отдельно проверены 10 Markdown-файлов и 244 ссылки/изображения реализации.

## Ограничения проверки

Полный source-набор выполнен на Linux; Windows/macOS имеют платформенные проверки и smoke поставки. macOS x64 package собирается, но отдельного запуска на физическом Intel Mac нет. GUI установщиков вручную не запускался; Установщики не подписаны; нотариальная проверка macOS не выполнялась.

Живой аккаунт исходного шлюза не использовался. Проверки настоящего SDK и локального HTTP endpoint подтверждают исправления клиента, но не устанавливают скрытую причину прежнего HTTP 400 внешнего сервиса. Исходная Windows-папка и происхождение её массовых изменений Git по истории не воспроизводятся. Репозиторий концепта Desktop не изменялся и не выпускался.
