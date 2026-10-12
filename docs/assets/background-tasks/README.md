# Кадры фоновых задач

[Отчёт проверки](../../contributors/reports/background-tasks.md) · [Справка](../../background-tasks.md)

`ordinary-tui` — настоящий `runOpenTuiAgent` и реальный локальный процесс. `state-projection` — native renderer с контролируемыми записями состояний и нагрузкой списка из 256 записей; это проверка отображения, а не доказательство запуска 256 процессов.

У каждого PNG есть одноимённые TXT (`captureCharFrame`) и JSON (`captureSpans`). PNG экспортирован из этих spans через `scripts/render-terminal-captures.py`.

## Обычный запуск

| Размер | Obsidian | Graphite | Ember | Paper |
| --- | --- | --- | --- | --- |
| 160x50 | [unicode](obsidian-unicode-ordinary-tui-160x50-background-popup.png) / [ascii](obsidian-ascii-ordinary-tui-160x50-background-popup.png) | [unicode](graphite-unicode-ordinary-tui-160x50-background-popup.png) / [ascii](graphite-ascii-ordinary-tui-160x50-background-popup.png) | [unicode](ember-unicode-ordinary-tui-160x50-background-popup.png) / [ascii](ember-ascii-ordinary-tui-160x50-background-popup.png) | [unicode](paper-unicode-ordinary-tui-160x50-background-popup.png) / [ascii](paper-ascii-ordinary-tui-160x50-background-popup.png) |
| 120x40 | [unicode](obsidian-unicode-ordinary-tui-120x40-background-popup.png) / [ascii](obsidian-ascii-ordinary-tui-120x40-background-popup.png) | [unicode](graphite-unicode-ordinary-tui-120x40-background-popup.png) / [ascii](graphite-ascii-ordinary-tui-120x40-background-popup.png) | [unicode](ember-unicode-ordinary-tui-120x40-background-popup.png) / [ascii](ember-ascii-ordinary-tui-120x40-background-popup.png) | [unicode](paper-unicode-ordinary-tui-120x40-background-popup.png) / [ascii](paper-ascii-ordinary-tui-120x40-background-popup.png) |
| 80x24 | [unicode](obsidian-unicode-ordinary-tui-80x24-background-popup.png) / [ascii](obsidian-ascii-ordinary-tui-80x24-background-popup.png) | [unicode](graphite-unicode-ordinary-tui-80x24-background-popup.png) / [ascii](graphite-ascii-ordinary-tui-80x24-background-popup.png) | [unicode](ember-unicode-ordinary-tui-80x24-background-popup.png) / [ascii](ember-ascii-ordinary-tui-80x24-background-popup.png) | [unicode](paper-unicode-ordinary-tui-80x24-background-popup.png) / [ascii](paper-ascii-ordinary-tui-80x24-background-popup.png) |
| 40x12 | [unicode](obsidian-unicode-ordinary-tui-40x12-background-popup.png) / [ascii](obsidian-ascii-ordinary-tui-40x12-background-popup.png) | [unicode](graphite-unicode-ordinary-tui-40x12-background-popup.png) / [ascii](graphite-ascii-ordinary-tui-40x12-background-popup.png) | [unicode](ember-unicode-ordinary-tui-40x12-background-popup.png) / [ascii](ember-ascii-ordinary-tui-40x12-background-popup.png) | [unicode](paper-unicode-ordinary-tui-40x12-background-popup.png) / [ascii](paper-ascii-ordinary-tui-40x12-background-popup.png) |
| 24x8 | [unicode](obsidian-unicode-ordinary-tui-24x8-background-popup.png) / [ascii](obsidian-ascii-ordinary-tui-24x8-background-popup.png) | [unicode](graphite-unicode-ordinary-tui-24x8-background-popup.png) / [ascii](graphite-ascii-ordinary-tui-24x8-background-popup.png) | [unicode](ember-unicode-ordinary-tui-24x8-background-popup.png) / [ascii](ember-ascii-ordinary-tui-24x8-background-popup.png) | [unicode](paper-unicode-ordinary-tui-24x8-background-popup.png) / [ascii](paper-ascii-ordinary-tui-24x8-background-popup.png) |

## Логи и карточки

[Пауза следования и новые строки](graphite-unicode-ordinary-tui-120x40-background-follow-paused.png) · [Остановленная задача](paper-unicode-ordinary-tui-120x40-background-stopped.png) · [Основной чат](ember-unicode-ordinary-tui-120x40-background-main.png)

[Foreground: действие «В фон»](obsidian-unicode-ordinary-tui-120x40-foreground-promotion.png) · [Та же карточка после перевода](obsidian-unicode-ordinary-tui-120x40-promoted-card.png)

## Состояния и предел числа строк

| Размер | Obsidian | Graphite | Ember | Paper |
| --- | --- | --- | --- | --- |
| 160x50 | [unicode](obsidian-unicode-160x50-state-projection.png) / [ascii](obsidian-ascii-160x50-state-projection.png) | [unicode](graphite-unicode-160x50-state-projection.png) / [ascii](graphite-ascii-160x50-state-projection.png) | [unicode](ember-unicode-160x50-state-projection.png) / [ascii](ember-ascii-160x50-state-projection.png) | [unicode](paper-unicode-160x50-state-projection.png) / [ascii](paper-ascii-160x50-state-projection.png) |
| 120x40 | [unicode](obsidian-unicode-120x40-state-projection.png) / [ascii](obsidian-ascii-120x40-state-projection.png) | [unicode](graphite-unicode-120x40-state-projection.png) / [ascii](graphite-ascii-120x40-state-projection.png) | [unicode](ember-unicode-120x40-state-projection.png) / [ascii](ember-ascii-120x40-state-projection.png) | [unicode](paper-unicode-120x40-state-projection.png) / [ascii](paper-ascii-120x40-state-projection.png) |
| 80x24 | [unicode](obsidian-unicode-80x24-state-projection.png) / [ascii](obsidian-ascii-80x24-state-projection.png) | [unicode](graphite-unicode-80x24-state-projection.png) / [ascii](graphite-ascii-80x24-state-projection.png) | [unicode](ember-unicode-80x24-state-projection.png) / [ascii](ember-ascii-80x24-state-projection.png) | [unicode](paper-unicode-80x24-state-projection.png) / [ascii](paper-ascii-80x24-state-projection.png) |
| 40x12 | [unicode](obsidian-unicode-40x12-state-projection.png) / [ascii](obsidian-ascii-40x12-state-projection.png) | [unicode](graphite-unicode-40x12-state-projection.png) / [ascii](graphite-ascii-40x12-state-projection.png) | [unicode](ember-unicode-40x12-state-projection.png) / [ascii](ember-ascii-40x12-state-projection.png) | [unicode](paper-unicode-40x12-state-projection.png) / [ascii](paper-ascii-40x12-state-projection.png) |
| 24x8 | [unicode](obsidian-unicode-24x8-state-projection.png) / [ascii](obsidian-ascii-24x8-state-projection.png) | [unicode](graphite-unicode-24x8-state-projection.png) / [ascii](graphite-ascii-24x8-state-projection.png) | [unicode](ember-unicode-24x8-state-projection.png) / [ascii](ember-ascii-24x8-state-projection.png) | [unicode](paper-unicode-24x8-state-projection.png) / [ascii](paper-ascii-24x8-state-projection.png) |
