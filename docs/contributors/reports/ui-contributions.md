# UI contributions: реализация и проверки

[Материалы для участников](../README.md) · [Contract](../../architecture/ui-contributions.md) · [Справка](../../interface-contributions.md)

База реализации: main `9e4e62cb896cb508e553e23524ef1e21e714865b`, package 0.6.23, OpenTUI 0.5.12. Все изменения и коммиты выполнены прямо в main, без development branches/worktrees и PR. Memory отложена, loader/install/trust и внешний SDK относятся к следующему этапу. [Релиз 0.6.24 опубликован](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.24) **12.10.2026 в 20:08:04 UTC**.

## Изменения

- Registry и typed schemas входят в существующий host lifecycle: staged/sealed activation, capture, limits, rollback, disposal.
- Owner bindings отделяют workspace LSP cache от conversation tasks/children; late results и revisions fenced.
- Production LSP, Background Tasks и subagent status/navigation используют registered slots. Generic details и own-tool actions работают через обычный native renderer и policy/checkpoint path.
- Menu сохраняет Enter consumption, добавляет Space activation и selection по stable key. Details используют bounded rows/pages/search, отдельный input owner и восстановление focus.
- UI DTO sanitation предшествует cache/events. Сохранённые cards остаются readable; unavailable extension view не replay-ит инструмент.

Изменения сосредоточены в `src/extensions/ui*.ts`, lifecycle/contracts/index и builtin consumers, LSP cached projection, `src/ui/extension-ui.ts`, native details/status/sidebar consumers и application tool queue. Process backend фоновых задач сохранён.

## Реальные проверки

Независимый linked fixture запускается через ordinary `runOpenTuiAgent`: три slots, Space, details, pagination, маленький экран, normal approval, реальная запись файла, Session checkpoint и disposal. Его code не входит default extensions и не создаёт production slash command.

Core tests проверяют namespaces, seal/late/duplicate/rollback, owner caches, late results, monotonic revisions, sanitized limits и 20 bind/dispose cycles. UI tool runtime проверяет Plan, deny, guards, schema и background resource fence. Passive LSP scenario получает настоящую TypeScript diagnostic, затем отмечает cached данные stale после workspace revision; page не запускает повторный анализ.

Релизный source commit: **`342444486b28ad8694c42363b9a57f134e3aa519`**, прямо в main. [CI 38298393448](https://github.com/TheAsrada/ChiselCode/actions/runs/38298393448) завершён успешно во всех шести Quality / Real Auto LSP jobs.

Tag `v0.6.24` указывает на этот source. [Release 38301457001](https://github.com/TheAsrada/ChiselCode/actions/runs/38301457001) завершён успешно: source verification, Linux/macOS/Windows installers и публикация. Release имеет `draft=false`, `prerelease=false`; все четыре assets имеют состояние `uploaded`:

| Установщик | Файл | Размер, bytes |
| --- | --- | --- |
| Windows x64 | ChiselCode-Setup-0.6.24.exe | 38 637 006 |
| macOS arm64 | ChiselCode-Setup-0.6.24-macos-arm64.pkg | 33 216 811 |
| macOS x64 | ChiselCode-Setup-0.6.24-macos-x64.pkg | 35 811 065 |
| Linux amd64 | ChiselCode-Setup-0.6.24-linux-amd64.deb | 36 895 988 |

| Платформа CI | Полный набор | Real Auto LSP | Distribution |
| --- | --- | --- | --- |
| Linux | 1148 pass, 3 skips, 0 failures | success | installed/compiled CLI и native TUI: success |
| macOS | 1148 pass, 3 skips, 0 failures | success, включая SourceKit | installed/compiled CLI и native TUI: success |
| Windows | 1150 pass, 1 skip, 0 failures | success | early compiled cancellation, installed/compiled CLI/TUI и updater installer: success |

На каждой платформе полный набор содержит **1151 tests / 136 files**. Локальный Linux полный прогон: **1148 pass, 3 platform skips, 0 failures**. Typecheck прошёл; lint: 185 warnings, 15 infos, 0 errors; eval: 14/14 в каждом Quality job. Отдельно прошли focused UI/LSP/policy/clipboard, реальные Session FIFO/cross-process locks и installed/compiled harness. Windows/macOS подтверждены CI, а не локальным Linux прогоном.

Предыдущий docs HEAD 0.6.23 CI `38256388828` завершился с failure Windows Quality из-за 5-секундного timeout legacy Session migration fixture; он не объявляется успешным. Fixture budget увеличен до 15 секунд при сохранении реальной миграции и проверок оригиналов. CI релизного source 0.6.23 `38252417038` и Release `38255473690` остаются подтверждёнными успешными runs.

Промежуточные CI `38284054866` и `38285918369` выявили преждевременное чтение Session checkpoint в compiled fixture и слишком короткие filesystem budgets Windows fixtures. Проверки теперь ждут настоящий terminal tool result; очистка 64 ignored LSP documents проверяется на последовательных штатных bounded context boundaries. Production budget 250 мс не увеличен, eager UI scan не добавлен. Fixture создания и чтения 500 provider manifests получил 20 секунд вместо общих пяти; проверки полноты и поиска сохранены.

Промежуточные Windows Quality `38288302079`, `38291014306` и `38294718993` не прошли поздний installed/compiled child cancellation scenario; они не объявляются успешными. Диагностика локализовала ожидание checkpoint после отмены. Runtime публикует terminal outcome после освобождения ресурсов, показывает этап завершения, сохраняет recovery fence при ошибке освобождения копии и не заменяет failed cleanup обычной отменой. Ранний и поздний compiled cancellation paths прошли в финальном Windows CI. Ожидания CI ограничены: Quality — 35 минут, shell и ранний compiled child smoke — по 3 минуты.

Поздний compiled Windows сценарий дополнительно локализовал ожидание checkpoint после отмены. Checkpoint одной Session сериализован; same-process storage writers используют FIFO перед прежним cross-process file lock. Release wait ограничен, проверка owner token и recoverable guard сохранены. Реальные файловые проверки подтверждают FIFO, отсутствие потерянных записей и ожидание lock отдельным Bun процессом.

Этот финальный отчёт и release availability обновлены отдельным commit в main после публикации; tag не передвигался. Новый docs HEAD не объявляется прошедшим CI до результата его собственного workflow. Подтверждённые checks выше относятся к релизному source.

## Кадры и воспроизведение

Сохранены **91 native capture triplets** в `docs/assets/ui-contributions`: 80 кадров пяти размеров 160×50 / 120×40 / 80×24 / 40×12 / 24×8 в четырёх темах и Unicode/ASCII, два кадра смены owner и девять кадров настоящего background процесса. Дополнительные кадры показывают context/menu, approval, unavailable и status overflow. Генерация — actual `captureCharFrame` / `captureSpans`, PNG renderer `scripts/render-terminal-captures.py`; browser/imagegen макеты не используются.

Вручную просмотрены PNG каждого размера:

- [160×50, Obsidian ASCII](../../assets/ui-contributions/obsidian-ascii/production-details-160x50.png).
- [120×40, Paper Unicode](../../assets/ui-contributions/paper-unicode/production-details-120x40.png).
- [80×24, Graphite ASCII](../../assets/ui-contributions/graphite-ascii/production-details-80x24.png).
- [40×12, Ember Unicode](../../assets/ui-contributions/ember-unicode/production-details-40x12.png).
- [24×8, Obsidian Unicode](../../assets/ui-contributions/obsidian-unicode/production-details-24x8.png).

На всех размерах title/list и «Назад» доступны; маленькая поверхность сокращает второстепенные сведения. Native owner-switch test выполняет 20 open/close/switch cycles двух бесед одного root и другого root, проверяет late page cancellation, сохранение drafts и отсутствие роста keyboard/resize/service subscribers.

Также вручную просмотрены [другой root с сохранённым черновиком](../../assets/ui-contributions/owner-switch/other-owner-120x40.png), [native окно настоящего процесса](../../assets/ui-contributions/background-production/graphite-unicode-ordinary-tui-120x40-background-popup.png) и [его компактный вариант 24×8](../../assets/ui-contributions/background-production/graphite-unicode-ordinary-tui-24x8-background-popup.png). Process fixture проверяет живой вывод, paused follow, selected stop и возврат к работающему основному чату.

```sh
bun test tests/unit/extension-ui.test.ts tests/integration/ui-tools-runtime.test.ts
bun tests/fixtures/tui-ui-contributions.ts
bun test tests/integration/lsp-runtime.test.ts -t 'registered passive LSP'
bun tests/fixtures/command-packaging.ts
# Дополнительные реальные кадры; JSON затем преобразуется штатным PNG renderer.
CHISEL_UI_OWNER_CAPTURES=docs/assets/ui-contributions/owner-switch bun test tests/unit/opentui-ui-bindings.test.tsx
CHISEL_CAPTURE_DIR=docs/assets/ui-contributions/background-production CHISEL_CAPTURE_THEME=graphite CHISEL_CAPTURE_UNICODE=1 bun tests/fixtures/tui-background.ts
```

Package harness успешно выполнил ту же linked fixture с ordinary modules в установленном npm bundle и compiled executable на всех трёх ОС. Сохранены installed/compiled smokes /btw, worktrees, LSP, subagents и настоящих Background Tasks процессов. Headless CLI не подписывается на UI providers. Эти проверки не являются публикацией package в npm registry.

Ограничения: trusted in-process callback не имеет CPU/OS isolation; snapshot timeout cooperative. Generic view хранит ограниченные plain pages; streaming task logs остаются существующим viewer. Никакой установки произвольного package или Memory в этом релизе нет.

[Вернуться к материалам для участников](../README.md)
