# Проверка сводок действий OpenTUI

[Материалы участников](../README.md) · [Справка](../../agent-actions.md) · [Архитектура](../../architecture/tool-actions.md)

## Исходники

Работа выполнена прямо в `main`, без веток, development worktrees и PR. База сводок — `d005b38`, с сохранёнными исправлениями background owner и shell. [CLI 0.6.32 опубликован](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.32) 16 октября 2026 года. Release source — `ee79111e3b09a558858d8f8f929f2f17ec2b9e2c`; OpenTUI остаётся 0.5.12.

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

## Проверки release source

[Native validation 38849777815](https://github.com/TheAsrada/ChiselCode/actions/runs/38849777815) прошёл на точном `ee79111`. Все четыре обязательных job успешны; повтор того же source не потребовался. [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/38849777746) также успешен.

| Job | Результат | Время job |
|---|---|---|
| Full source, Linux | 1248 pass, 3 skip, 0 fail; typecheck/lint; 14/14 deterministic evals; UI расширений | 6 мин 24 с |
| Native smoke, Linux | Installed/compiled CLI, настоящий LSP, инструменты, helpers/worktree/background, SDK, native OpenTUI | 1 мин 56 с |
| Native smoke, macOS arm64 | 59 pass, 3 skip, 0 fail в платформенном наборе; installed/compiled smoke | 2 мин 52 с |
| Native smoke, Windows x64 | 61 pass, 1 skip, 0 fail в платформенном наборе; installed/compiled smoke | 5 мин 57 с |

Восьмёрка новых UI-сценариев прошла целиком на Linux, Windows и macOS. Общая длительность от старта run до завершения последнего job — 6 мин 52 с; сумма runner time четырёх jobs — 17 мин 9 с. Это разные измерения, с учётом очереди и параллельного выполнения. Сам полный Linux test process занял 322,58 с.

Три skip Linux: нативный clipboard без desktop session и два Windows-only CMD/Python сценария. Оба Windows-сценария выполнены на Windows. В macOS/Windows дополнительно пропущен Linux-only detached orphan; полное покрытие всех source-файлов на этих ОС не заявляется. Интерактивная проверка системного clipboard и запуск macOS Intel остаются вне этого прогона.

## Опубликованная поставка

[Release 38850407614](https://github.com/TheAsrada/ChiselCode/actions/runs/38850407614) завершился успешно. Тег `v0.6.32` создан после native CI и указывает на проверенный `ee79111`; GitHub Release опубликован, не draft/prerelease, и является `latest`. Опубликованы ровно четыре установщика и npm-архив CLI/SDK.

Все пять файлов скачаны из публичного выпуска: размеры и SHA-256 совпали с GitHub API. Проверены форматы EXE/PKG/DEB и версия npm/DEB; SDK declarations присутствуют в tarball. Извлечённый Linux DEB и установленный из опубликованного tarball пакет показали `0.6.32` и прошли настоящие manifest/model/tool/persistence и external SDK/trust/read/write/Plan/refusal/exit/recovery smoke.

| Asset | Размер, байт | SHA-256 |
|---|---:|---|
| `chiselcode-0.6.32.tgz` | 5798078 | `4a11c1ce728adc78fde7ce53436302ab3c9a7f20317102c2c4771ce08d39fb02` |
| `ChiselCode-Setup-0.6.32-linux-amd64.deb` | 36962150 | `d706280172d6d21b9a16ab573baa7aba8295500d5a8022e3f24487e67e390293` |
| `ChiselCode-Setup-0.6.32-macos-arm64.pkg` | 33298440 | `0b59d5e220a941ce7d059cbf7b146d85aaa88b93e9c60c2552931bea8c0e08bd` |
| `ChiselCode-Setup-0.6.32-macos-x64.pkg` | 35886842 | `ee81240c52215b8fbb613ab7e0faf9e52cbf2ff950aa86550bbabd1cb407f6c4` |
| `ChiselCode-Setup-0.6.32.exe` | 38683526 | `dbbc8d2c6ef9e1fb17be5625553cce487fd2b6884d630673f6c17a7cac8eb7d7` |

Release проверил запуск новых Windows x64, Linux x64 и macOS arm64 binaries. macOS x64 собран на arm64 runner и не запускался на Intel. Windows/macOS установщики не подписаны; системный GUI установки локально не запускался. Документация после публикации зафиксирована отдельным коммитом `main`, тег и assets сохранены неизменными.
