# Проверка сводок действий OpenTUI

[Материалы участников](../README.md) · [Справка](../../agent-actions.md) · [Архитектура](../../architecture/tool-actions.md)

## Исходники

Работа выполняется прямо в `main`, без веток, development worktrees и PR. База сводок — `d005b38`, с сохранёнными исправлениями background owner и shell. Подготавливается CLI 0.6.32; OpenTUI остаётся 0.5.12. Результаты release source и native CI фиксируются после фактического завершения.

## Сценарии

`tool-actions.test.ts` проверяет параллельные start/result, границы сообщений, раскрытие, JSON replay, навыки/метаданные, неизвестные инструменты, diff/cards, 1200 операций, отмену и позднее чтение после закрытия. Файл входит в быстрый профиль.

`tui-tool-actions.ts` запускает production `runOpenTuiAgent`, настоящий executor, чтение/поиск файлов, `load_skill`, shell с кодом 1 и длинным выводом. Локальный scripted endpoint подтверждает передачу инструкций модели. Fixture использует barriers готовности, mouse/keyboard events и настоящий renderer; раскрытие и чтение artifact не увеличивают model calls. Повторное открытие сохраняет счётчики/ошибку и не повторяет shell. Размеры: 120×40, 80×24, 40×20 и 24×18; проверяются все четыре темы в Unicode и ASCII (8 сочетаний).

## Настоящие кадры

TXT/JSON получают `captureCharFrame` и `captureSpans`; PNG строит `scripts/render-terminal-captures.py`. Макеты и генерация изображений не используются.

- [Закрытые действия и загрузка навыков](../../assets/tool-actions/obsidian-ascii-closed-and-skills-loading.png).
- [Раскрытая сводка](../../assets/tool-actions/obsidian-ascii-actions-open.png).
- [Сведения о навыках](../../assets/tool-actions/obsidian-ascii-skills-open.png).
- [Ошибка закрытой группы](../../assets/tool-actions/obsidian-ascii-error-closed.png).
- [Полный сохранённый вывод](../../assets/tool-actions/obsidian-ascii-saved-output.png).
- [Узкий экран 24×18](../../assets/tool-actions/obsidian-ascii-narrow-24x18.png).
- [Светлая тема и Unicode](../../assets/tool-actions/paper-unicode-closed-and-skills-loading.png).
- [Восстановленная беседа](../../assets/tool-actions/paper-unicode-restored.png).

## Воспроизведение

```bash
bun test tests/unit/tool-actions.test.ts
CHISEL_CAPTURE_DIR=dist/tool-actions-captures bun test tests/integration/tool-actions-tui.test.ts
python scripts/render-terminal-captures.py dist/tool-actions-captures
```

Локально Linux: быстрый профиль — **356 pass**; заключительный профиль действий, расширений, фоновых задач и восьми сочетаний темы/Unicode — **43 pass**. Отдельно прошли 45 проверок runtime/diff/tools/scrollback, typecheck, lint без ошибок и build. Production UI-fixture также прошёл после компиляции в отдельный исполняемый файл. Проверены сохранение черновика, фокуса, раскрытия и позиции прокрутки при новых событиях. Первый полный Linux source-прогон: 1239 pass, 3 skip, 1 fail — старый assertion ожидал техническую строку расширения; он заменён проверкой структурированного источника и результата, после чего затронутый integration-файл прошёл целиком. Повторный полный прогон относится к обязательному CI точного release source. Windows-only clipboard/CMD/Python локально недоступны.

Подготовка и обязательные проверки выпуска выполняются по [порядку проверок](../testing.md). Linux source и native installed/compiled smoke имеют разное покрытие; результаты не переносятся на непроверенные платформы.

Первый native run `38849485457` выявил ошибку подготовки macOS CI: платформенные LSP transport tests запускались до установки закреплённых внешних зависимостей (9 fail). Восемь новых UI-сценариев на macOS прошли. Перед платформенным набором добавлена та же явная подготовка LSP, которая уже выполнялась в Linux source job; assertions и состав проверок сохранены. Устаревшие прогоны отменены при обновлении release source, до создания тега.
