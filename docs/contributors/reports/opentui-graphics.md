# Единое графическое оформление OpenTUI

[Материалы для участников](../README.md) · [Настройки интерфейса](../../configuration.md#параметры-интерфейса) · [Архитектура](../../architecture.md#главная-и-вкладки-терминала)

Изменение относится к Unreleased после CLI 0.6.33. Опубликованный тег и файлы 0.6.33 не изменяются.

## Решение

Интерактивный чат уже использовал единственный renderer OpenTUI. Настройка «Графика» выбирала отдельные ветки оформления: ASCII-логотип, рамки и стрелки либо Coder Mini, графические рамки и ползунок. Эти ветки и их переключение удалены целиком. Нет context-флага, альтернативного логотипа, обратного вызова сохранения или UI-переключателя. `TerminalScrollbox` задаёт общие defaults нативного ползунка, а компоненты используют обычные рамки OpenTUI.

При загрузке и сохранении `GlobalConfigV2Schema` удаляет устаревшее поле `ui.unicodeDecorations`, включая старое `false`. Сохраняются тема, accent, sidebarMode, неизвестные будущие поля и прочая конфигурация. Та же нормализация применяется к schema v1. Изменение настройки на диске не требуется для первого запуска с графикой.

Alternate-screen и split-footer остаются способами размещения одного OpenTUI renderer. Одноразовые задачи, JSON, служебные команды и автоматизация CLI сохраняют прежнее поведение. Краткая текстовая подпись на экране, куда полный логотип не помещается, определяется размером окна.

## Реальные кадры

Production `runOpenTuiAgent` запускается со старым конфигом `unicodeDecorations: false`. Кадры получены настоящими `captureCharFrame()`/`captureSpans()`; PNG экспортированы скриптом проекта без изменения содержимого.

Кадры пересняты на исправленном source `59219ef`.

| Сценарий | Кадр | Исходный capture |
| --- | --- | --- |
| Obsidian, главная 120×36 | [PNG](../../assets/opentui-graphics/obsidian-home-120x36.png) | [JSON](../../assets/opentui-graphics/obsidian-home-120x36.json) |
| Paper, оформление без переключателя | [PNG](../../assets/opentui-graphics/paper-settings-120x36.png) | [TXT](../../assets/opentui-graphics/paper-settings-120x36.txt) |
| Obsidian, 40×18 | [PNG](../../assets/opentui-graphics/obsidian-home-40x18.png) | [TXT](../../assets/opentui-graphics/obsidian-home-40x18.txt) |
| Paper, 24×8 | [PNG](../../assets/opentui-graphics/paper-home-24x8.png) | [TXT](../../assets/opentui-graphics/paper-home-24x8.txt) |

## Проверки

Локально Linux, Bun 1.4.3: быстрый профиль — 356 passed; production-проверки инструментов, creator, тёмной/светлой темы и прежнего `false` прошли. Проверены сохранение editor instance, фокуса и Unicode-черновика при настройках, смене вкладок и resize; scroll position при добавлении содержимого; карточки diff и остальные панели. Удалены дубли матрицы двух вариантов оформления, сохранены темы, размеры, разрешения, отмена и остальные assertions сценариев.

Typecheck, lint без ошибок и CLI/SDK build прошли; lint сохраняет warnings/info. Новый production-сценарий выполнен также compiled binary `chisel-graphics` с установленными рядом навыками. Проверены 15 изменённых Markdown и 250 локальных ссылок/anchors/изображений.

На точном source [`59219ef`](https://github.com/TheAsrada/ChiselCode/commit/59219efcb597c6b4aa9674e831b6db7231700843) успешно завершились [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/38908909494) и все четыре jobs [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/38908917627), Bun 1.4.2 / Node 24.19.0:

| Проверка | Результат |
| --- | --- |
| Полный source-набор, Linux | 1233 passed, 3 skipped, 0 failed; 1236 тестов в 161 файле, 291,02 с |
| Evals, все категории | 14 из 14 сценариев успешны |
| macOS platform/UI/config | 211 passed, 3 skipped, 0 failed; 214 тестов в 29 файлах |
| Windows platform/UI/config | 213 passed, 1 skipped, 0 failed; 214 тестов в 29 файлах |
| Native smoke Linux/macOS/Windows | Installed/compiled CLI и SDK, нативный OpenTUI, compiled creator и защищённые действия успешны |
| Typecheck, lint, CLI/SDK build | Успешны; lint с warnings/info |

Полный source-набор выполнен один раз на Linux; на macOS/Windows проверены целиком затронутые UI/config test files и новый production-сценарий. Smoke поставки не подменяет полный source-прогон этих ОС. Физические терминалы, шрифты conhost/SSH и системный GUI здесь вручную не проверялись. Опубликованный выпуск 0.6.33 не изменялся.

Первый source-прогон `09374f7` показал 1224 passed, 3 skipped и 9 failed. Восемь проверок Web/Markdown ожидали ASCII или удаляли только `|` при проверке перенесённого текста; они обновлены для графических рамок с сохранением проверок содержимого и пустых строк. Проверка clipboard нашла наложение двухстрочного compact header на сообщение: строки заголовка теперь имеют фиксированную высоту и не сжимаются. Тот же mouse selection/copy/cancel сценарий проходит с неизменными проверками текста. Все 34 теста трёх файлов прошли локально; файлы добавлены целиком в macOS/Windows-набор. Native smoke первого source прошли на всех трёх ОС; исправленный source прошёл отдельный итоговый run выше, без повторов на том же source.

Воспроизведение кадров:

```bash
CHISEL_GRAPHICS_CAPTURES=docs/assets/opentui-graphics bun tests/fixtures/tui-graphics.ts
CHISEL_CAPTURE_THEME=paper CHISEL_GRAPHICS_CAPTURES=docs/assets/opentui-graphics bun tests/fixtures/tui-graphics.ts
python3 scripts/render-terminal-captures.py docs/assets/opentui-graphics
```
