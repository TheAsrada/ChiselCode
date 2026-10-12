# UI contributions: реализация и проверки

[Материалы для участников](../README.md) · [Contract](../../architecture/ui-contributions.md) · [Справка](../../interface-contributions.md)

База реализации: main `9e4e62cb896cb508e553e23524ef1e21e714865b`, package 0.6.23, OpenTUI 0.5.12. Все изменения выполняются прямо в main. Memory отложена, loader/install/trust и внешний SDK относятся к следующему этапу. Релиз 0.6.24 пока не опубликован.

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

Локальный Linux полный прогон: **1146 pass, 3 platform skips, 0 failures; 1149 tests / 135 files**. Typecheck прошёл; lint: 185 warnings, 15 infos, 0 errors; eval: 14/14. Последний полный Linux прогон прошёл; отдельно прошли 35 focused UI/LSP/policy/clipboard checks и installed/compiled harness. Commit и межплатформенный CI будут записаны по фактическим результатам. Linux не заменяет Windows/macOS проверки.

Предыдущий docs HEAD 0.6.23 CI `38256388828` завершился с failure Windows Quality из-за 5-секундного timeout legacy Session migration fixture; он не объявляется успешным. Fixture budget увеличен до 15 секунд при сохранении реальной миграции и проверок оригиналов. CI релизного source 0.6.23 `38252417038` и Release `38255473690` остаются подтверждёнными успешными runs.

## Кадры и воспроизведение

Сохранены **80 native capture triplets** в `docs/assets/ui-contributions`: пять размеров 160×50 / 120×40 / 80×24 / 40×12 / 24×8, четыре темы и Unicode/ASCII. Дополнительные кадры показывают context/menu, approval, unavailable и status overflow. Генерация — actual `captureCharFrame` / `captureSpans`, PNG renderer `scripts/render-terminal-captures.py`; browser/imagegen макеты не используются.

Вручную просмотрены PNG каждого размера:

- [160×50, Obsidian ASCII](../../assets/ui-contributions/obsidian-ascii/production-details-160x50.png).
- [120×40, Paper Unicode](../../assets/ui-contributions/paper-unicode/production-details-120x40.png).
- [80×24, Graphite ASCII](../../assets/ui-contributions/graphite-ascii/production-details-80x24.png).
- [40×12, Ember Unicode](../../assets/ui-contributions/ember-unicode/production-details-40x12.png).
- [24×8, Obsidian Unicode](../../assets/ui-contributions/obsidian-unicode/production-details-24x8.png).

На всех размерах title/list и «Назад» доступны; маленькая поверхность сокращает второстепенные сведения. Native owner-switch test выполняет 20 open/close/switch cycles двух бесед одного root и другого root, проверяет late page cancellation, сохранение drafts и отсутствие роста keyboard/resize/service subscribers.

```sh
bun test tests/unit/extension-ui.test.ts tests/integration/ui-tools-runtime.test.ts
bun tests/fixtures/tui-ui-contributions.ts
bun test tests/integration/lsp-runtime.test.ts -t 'registered passive LSP'
bun tests/fixtures/command-packaging.ts
```

Package harness успешно выполнил ту же linked fixture с ordinary modules в установленном npm и compiled executable. Сохранены installed/compiled smokes /btw, worktrees, LSP, subagents и настоящих Background Tasks процессов. Headless CLI не подписывается на UI providers. Финальные checks/source commit/CI/release availability заполняются по фактическим результатам, а не плану.

Ограничения: trusted in-process callback не имеет CPU/OS isolation; snapshot timeout cooperative. Generic view хранит ограниченные plain pages; streaming task logs остаются существующим viewer. Никакой установки произвольного package или Memory в этом релизе нет.

[Вернуться к материалам для участников](../README.md)
