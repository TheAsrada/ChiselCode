# Проверка Background Tasks

[Материалы участников](../README.md) · [Пользовательская справка](../../background-tasks.md) · [Внутренний контракт](../../architecture/background-tasks.md)

## Статус

Изменения сделаны прямо в `main`, без новой ветки, development worktree или PR. Исходная база: `926d67e`, package 0.6.22, OpenTUI 0.5.12. Подготовлена версия 0.6.23; в опубликованный v0.6.22 функция не входит. Изменение UI по поручению владельца: кнопка в «Меню» открывает отдельное нативное окно; исходные три вкладки боковой панели сохранены.

Исходный коммит реализации и кадров: `bee0c8e2b4f1513ce5379050caa6ff3094aaadde` — «feat: добавить фоновые команды и нативное окно задач». Исправления shell, маршрутизации ввода и подготовка 0.6.23 добавлены следующими коммитами без переписывания истории. Публикация версии и итог текущего удалённого CI пока не подтверждены.

Этот отчёт отделяет локальные результаты от межплатформенного acceptance. Roadmap не помечен completed/released: Windows/macOS и удалённый CI текущего изменения не запускались. Новые production process/junction/installed/compiled проверки добавлены в существующую матрицу трёх ОС.

## Shell и ввод в 0.6.23

На снимках Windows CMD исполнял строки, рассчитанные на другую оболочку: отсутствующий `tail` завершал pipeline с ошибкой, а `; echo ...; git status` становились аргументами `findstr`. Модель раньше получала только `win32`, без фактического диалекта. Теперь main и child prompt, а также описание `run_shell` сообщают CMD/`/bin/sh`, правила кавычек/разделителей и доступные файловые инструменты. Команда не переводится автоматически в другой язык и не повторяется после ошибки. Ненулевые коды настоящих tests, `AssertionError` и `ModuleNotFoundError` остаются ошибками проекта, а не успешным выполнением shell.

Общий `ManagedProcess` фиксирует shell profile до spawn; Windows CMD запускается с отключённым AutoRun и code page 65001, Python получает UTF-8 defaults. Native CMD/Python Unicode, stderr и exit codes проверяются на Windows runner, в том числе через ordinary installed/compiled CLI. Программы, явно выбравшие другую кодировку, не объявляются автоматически перекодированными.

Enter в сфокусированном «Меню» поглощается без открытия пункта и отправки черновика; мышь и прежние команды/shortcuts остаются. После Esc Enter отправляет сообщение. UI использует одну общую `keypress`-подписку на renderer; порядок callbacks, captured owner и `stopPropagation` сохранены, новая поверхность не получает событие, которое её открыло. Повторные открытия проверяют число keyboard/resize listeners, production TUI и installed/compiled сценарий проверяют настоящий native editor.

[Кадр меню Obsidian](../../assets/sidebar/obsidian-menu.png) · [Graphite](../../assets/sidebar/graphite-menu.png) · [Ember](../../assets/sidebar/ember-menu.png) · [Paper](../../assets/sidebar/paper-menu.png). Рядом с каждым PNG сохранены TXT/JSON фактического renderer.

## Реальные сценарии

- `background-process.test.ts`: stdin EOF и exit 7, output pipes после leader exit, один process instance при detach, split secrets/OSC/UTF-8, атомарная передача local/durable resources, реальный symlink/junction, TERM-игнорирующий потомок и Linux detached orphan с честным unknown.
- `background-runtime.ts`: default contributions и executor запускают batch, service с обычным потомком и потоковым выводом, дедуплицируют принятие, сохраняют exit/output; очередь 8 и overflow; foreground promotion со spawn count 1, прежним deadline и безопасным старым abort. Owned P2.1 copy начинается от committed base; origin file tools продолжаются, common Git/shell и apply/remove получают busy; последующий apply сохраняет HEAD/index/unrelated dirty bytes. Два независимых проекта работают параллельно; закрытие одной настоящей вкладки останавливает её процесс и сохраняет сервер другой. Fault adapter ломает запись running после настоящего spawn: процесс останавливается, результат показывает failed, ресурсы освобождаются после cleanup. Отдельный сбой terminal checkpoint настоящего завершённого процесса сохраняет fence до explicit recovery по private cleanup proof; два recovery-вызова получают одну revision.
- `subagents-runtime.ts`: настоящий parent → два coding child model/tool loops через controlled HTTP adapter, реальные Git/files/stores; каждый child запускает bounded batch в своей копии. Root сохраняет child attribution, реальные outcomes и accounting; child terminal ждёт cleanup, copy apply после него проходит обычные конфликты.
- `tui-background.ts`: ordinary `runOpenTuiAgent`, реальная service-команда и native renderer. Busy main продолжает model request; `/tasks`, окно/логи/локальный поиск/resize/selected stop не создают model requests. Ctrl+C при чтении не отменяет main, закрытие viewer не stop. Пауза follow оставляет старые строки на месте и показывает новые; настоящий mouse action «В фон» сохраняет карточку и один запуск. HTTP adapters контролируемые, процесс и UI настоящие.
- `background-crash.ts`: реальный отдельный процесс приложения завершается SIGKILL; ordinary CLI читает Session и сохранённый вывод. Команда не повторяется; исходный PID не подключается и не убивается, durable resources остаются занятыми, recovery без private proof отклоняется.
- `background-cli.ts`: ordinary package и compiled CLI запускают реальную команду exit 7 в пути с кириллицей и двойными пробелами, читают retained output/status после resume без replay/model; Plan отклоняет start. `command-packaging.ts` проверяет installed bundle и compiled native TUI через тот же backend.

## Проверки и пределы доказательства

Локальная платформа — Linux x64, Bun 1.4.2, OpenTUI 0.5.12; проверки завершены 12.10.2026.

| Проверка | Фактический результат |
| --- | --- |
| `bun run typecheck` | Успешно |
| `bun test` для 0.6.23 | 1136 passed, 3 skipped, 0 failed; 131 файл, 10337 assertions |
| Финальные process/background/child/worktree/UI regressions | 35 passed, 415 assertions; настоящие процессы, Git, stores, persistence fault и recovery |
| Нативные состояния / список / listeners | 8 passed, 233 assertions; максимум 64 смонтированных task rows, resize listeners не растут после 12 повторных открытий |
| Production TUI captures | 8 успешных прогонов: четыре темы × Unicode/ASCII; отдельно настоящий mouse promotion |
| `bun run lint` | Без ошибок; 166 warnings, 14 infos |
| `bun run eval --category all` | 14 из 14 сценариев успешно |
| `bun run build`, `bun run compile` | Успешно |
| `command-packaging.ts` | Успешно: installed npm, compiled native TUI, прежние LSP/worktrees/subagents/`/btw` |
| Bundle и compiled `background-cli.ts` | Успешно: exit 7, retained output/resume, отсутствие replay/model, Plan refusal, сохранение пробелов команды |

В локальном Linux пропущен существующий тест обмена Unicode через системный clipboard и две настоящие CMD/Python проверки, предназначенные для Windows runner. Полный набор включает остановку при ошибке сохранения сразу после spawn, сохранение пробелов в `/tasks start`, подсказки диалекта, отсутствие Enter activation в меню и общий keyboard dispatcher. Последующий ordinary production TUI и installed/compiled прогон прошли; после объединения keyboard subscriptions `MaxListenersExceededWarning` в финальном ordinary TUI не обнаружен. Предупреждения React `act` относятся к тестовым потоковым кадрам. Lint сохраняет предупреждения `noNonNullAssertion` и существующие диагностические замечания; это не проверка с нулём warnings.

Intentional daemon escape и ограничения ОС не объявляются универсально очищенными; unknown сохраняет recovery block. Linux использует process group и subreaper; для macOS/Windows требуется удалённая проверка обычных descendants, быстрого выхода leader и packaged helper. CPU/RAM quotas, PTY/stdin, daemon/reconnect, auto restart и HTTP readiness probe не реализованы. Локальный Linux не заменяет проверки Windows/macOS. Recovery metadata не является доказательством отсутствия descendants и не разрешает kill восстановленного PID. После crash или неизвестного escape без подтверждения исходного backend автоматического снятия fencing и универсальной кнопки освобождения нет.

## Кадры интерфейса

Кадры получены production `runOpenTuiAgent` через `captureCharFrame` и `captureSpans`; PNG экспортированы из фактических spans скриптом `scripts/render-terminal-captures.py`. Browser/imagegen mockups не используются. Матрица: 160×50, 120×40, 80×24, 40×12, 24×8; темы Obsidian/Graphite/Ember/Paper, Unicode и ASCII, длинное русское название с wide characters.

[Полная матрица TXT / JSON / PNG](../../assets/background-tasks/README.md) содержит 114 кадров, по три файла на кадр. `ordinary-tui` показывает настоящий production process flow; `state-projection` отдельно проверяет отображение running/queued/approval/failed/cleanup_unknown и предел mounted rows на контролируемых DTO. Он не доказывает запуск 256 процессов.

Вручную просмотрены PNG списка Obsidian, логов Graphite с паузой follow, состояния cleanup_unknown в Ember и маленького Paper 24×8: текст и действия доступны, footer не перекрывает body. Дополнительные тесты проверяют open/stop/back на каждом размере.

![Окно фоновых задач](../../assets/background-tasks/obsidian-unicode-ordinary-tui-120x40-background-popup.png)

![Старый вывод остаётся на месте](../../assets/background-tasks/graphite-unicode-ordinary-tui-120x40-background-follow-paused.png)

## Воспроизведение

```bash
bun run typecheck
bun test
bun run lint
bun run eval --category all
bun run build
bun run compile
bun tests/fixtures/command-packaging.ts
bun tests/fixtures/background-cli.ts ./dist/chisel
CHISEL_CAPTURE_DIR=/absolute/captures CHISEL_CAPTURE_UNICODE=1 bun tests/fixtures/tui-background.ts
CHISEL_CAPTURE_DIR=/absolute/captures CHISEL_CAPTURE_PROMOTION=1 bun tests/fixtures/tui-background.ts
CHISEL_BACKGROUND_STATE_CAPTURES=/absolute/captures bun test tests/unit/opentui-background.test.tsx
python3 scripts/render-terminal-captures.py /absolute/captures
```

Тематическая справка и архитектура возвращаются к оглавлению; interactive/configuration/permissions/sessions/worktrees/subagents/CLI содержат короткие ссылки на workflow и ограничения. Пользовательская справка указывает 0.6.23 и страницу выпуска; фактический результат публикации фиксируется отдельно в статусе отчёта.
