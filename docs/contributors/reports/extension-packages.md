# Пакеты расширений: реализация и проверки

[Contributor index](../README.md) · [Пользовательское руководство](../../extensions.md) · [Контракт сервиса](../../architecture/extension-packages.md) · [Loader/SDK report](external-extension-loader.md)

Менеджер пакетов выпущен в [v0.6.27](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.27) **14.10.2026**. Изменения сделаны непосредственно в main; новых development branches/worktrees/PR нет. Tag/source — [6394d4f881587697a8abbd5e1e9afbfc372aa7b7](https://github.com/TheAsrada/ChiselCode/commit/6394d4f881587697a8abbd5e1e9afbfc372aa7b7), основной implementation commit — 99d58cb. Опубликованный 0.6.26 неизменен. Параллельные desktop-изменения c9e50ac сохранены в main с версией 0.6.28 и не относятся к source 0.6.27.

## Реализованное поведение

Общий PackageManagementService, bounded folder/streaming STORE/DEFLATE ZIP ingestion, immutable managed versions, separate exact trust, schema 1→2 migration, per-id CAS, journals/commit receipts/reservations/recovery. Production CLI: inspect/install/update/enable/disable/versions/rollback/remove/recover; прежний approve/Home-only loader/recovery flag сохранены.

Application version leases защищают installed/runtime bytes до shutdown/подтверждённого выхода. Crash use остаётся unknown. Owner markers вне hash, selected/active/unknown versions не стираются; legacy manual folders сохраняются. SDK v1, approved EffectPlan, UI/themes/accent и user state installer не меняет.

## Проверено на Linux

- Folder и STORE/DEFLATE ZIP дают одинаковый digest. Paths/case collisions/link attributes/CRC/metadata/encryption/truncation отклоняются без escape.
- Untrusted install disabled, factory не исполняется; source после install удалён. Exact update/rollback работают, denied/stale update сохраняет prior.
- Два отдельных приложения держат v1/v2: remove deferred, graceful process exit допускает cleanup, SIGKILL оставляет unknown lease и bytes.
- Реальные SIGKILL на published и registry_committed: первый не создаёт selection/trust, второй восстанавливает committed outcome без replay. Проверка включает прежний 30-секундный stale storage lock.
- Standalone TS author использует packed public declarations вне checkout; ordinary CLI install/approve/next-startup read tool, ZIP update, rollback, disable/enable/remove работают без internal source import.
- Ordinary runOpenTuiAgent: настоящие light/dark previews, draft/focus/theme/accent сохранены; update действует после restart, rollback возвращает тему, disable/remove дают fallback без изменения desired preference.

Полная suite: **1193 pass, 3 platform skips, 0 fail**, 11092 assertions, 144 files. Это Linux run, не доказательство Windows/macOS. Typecheck/build/compile прошли; lint завершился без ошибок (276 warnings, 50 infos). Все 14 eval-сценариев успешны.

Installed npm и compiled executable выполнили новый extension-packages-cli fixture: внешний author с публичными declarations, actual folder/ZIP, trust, ordinary SDK file tool, update/rollback/disable/remove после удаления source. Общий command-packaging smoke прошёл для CLI/TUI, /btw, LSP, worktrees, subagents, background processes, UI и тем. Existing external SDK CLI regression также прошёл: real read/write/Plan, model/child/background/worktrees, modified asset refusal, raw exit и recovery.

Один завершающий прогон был прерван изменением helper module во время тестов; его результаты исключены. Приведённые 1193 pass относятся к повтору на неизменных исходниках. После последнего fd-open hardening выполнен targeted package/loader regression; окончательный source целиком проверен CI ниже.

## Платформенный CI

[CI 38434556225](https://github.com/TheAsrada/ChiselCode/actions/runs/38434556225) проверяет release source 6394d4f. Все три Quality jobs завершились успешно, включая typecheck/test/lint/eval/build, реальный внешний author package, folder/ZIP install, ordinary installed npm и compiled CLI, native UI/темы и прежние runtime regressions.

| Платформа | Полная suite | Assertions | Quality |
| --- | --- | --- | --- |
| Linux | 1193 pass / 3 skips / 0 fail | 11096 | success |
| macOS | 1193 pass / 3 skips / 0 fail | 11102 | success |
| Windows | 1194 pass / 2 skips / 0 fail | 11115 | success |

На каждой ОС выполнено 1196 tests в 144 files. Windows также прошёл отдельные реальные crash/recovery, shell Unicode, child runtime и compiled child UI cancellation проверки. Windows/macOS local запуск не выполнялся; это результаты CI runners.

Первый прогон 99d58cb ([38432481348](https://github.com/TheAsrada/ChiselCode/actions/runs/38432481348)) завершился failure на Windows: `/lsp-status` generic превысил default 5000 ms, рядом зарегистрирован EPERM при cleanup storage lock; Real Auto LSP получил WEB_TIMEOUT при загрузке Lua backend. На release source все пять `/lsp-status` сценариев прошли с сохранёнными assertions и прежним timeout; generic — 1279 ms. Причина единичного timeout не объявляется доказанной или исправленной изменением лимита.

На attempt 1 release source Real Auto LSP macOS/Windows получил WEB_TIMEOUT при загрузке Bash/C# соответственно. После завершения Quality повторены только failed jobs. Итог **attempt 2 — success во всех шести Quality / Real Auto LSP jobs** Windows/macOS/Linux; macOS также проверил настоящий SourceKit с Xcode. Таймауты, assertions и перечень backend не изменены.

Tag v0.6.27 адресует ровно 6394d4f. [Release 38503462415](https://github.com/TheAsrada/ChiselCode/actions/runs/38503462415), attempt 1 — **success во всех шести jobs**. Его собственный Verify release source: 1193 pass / 3 skips / 0 fail, 11096 assertions, 1196 tests / 144 files. Публичный release не draft, опубликован 14.10.2026 в 03:02 UTC. Все пять assets имеют состояние uploaded:

- chiselcode-0.6.27.tgz — ordinary npm CLI и публичные SDK declarations;
- ChiselCode-Setup-0.6.27.exe;
- ChiselCode-Setup-0.6.27-macos-arm64.pkg;
- ChiselCode-Setup-0.6.27-macos-x64.pkg;
- ChiselCode-Setup-0.6.27-linux-amd64.deb.

Эти результаты относятся к опубликованному source 0.6.27. CI последующего main с desktop-изменениями и документацией — отдельный прогон; успешность опубликованного выпуска не означает его успешность.

Отдельный commit 6394d4f уточняет `restartRequired`: известная загруженная версия, совпадающая с desired selection, не требует restart; update/disable/unknown use требуют. Проверка этих состояний сохранена в package suite.

## Native кадры

56 комплектов TXT captureCharFrame / JSON captureSpans / PNG находятся в [docs/assets/extension-packages](../../assets/extension-packages). PNG построены из настоящих spans скриптом render-terminal-captures.py; browser/imagegen не использовались. Матрица включает 160×50/120×40/80×24/40×12/24×8, light/dark, Unicode/ASCII, details/approval, source failure, update до/после restart, rollback, disable/remove/fallback. Draft/focus и desired theme/accent проверяются assertions. Выбранные wide/small PNG просмотрены вручную; не заявляется ручной просмотр каждого файла.

![Светлая тема до restart после update](../../assets/extension-packages/ascii/update-before-restart-160x50.png)

[Тёмный каталог](../../assets/extension-packages/ascii/north-catalog-160x50.png) · [Светлый каталог 24×8](../../assets/extension-packages/unicode/linen-catalog-24x8.png) · [Настоящее разрешение SDK write](../../assets/extension-packages/ui-obsidian-ascii/external-approval-120x40.png) · [Details 24×8](../../assets/extension-packages/ui-obsidian-ascii/external-details-24x8.png).

## Документация и ограничения

Пользовательский маршрут отделён от author package/SDK API. Добавлены отдельные package lifecycle и architecture contracts. Quickstart использует SDK 0.6.26+ для themes; chat.register возвращает void, DTO возвращает render. После обновления фактической доступности проверены 602 относительные file/anchor/image ссылки документации — 0 issues; git diff --check для изменений документации прошёл.

Нет Memory, marketplace/network installer, dependency scripts, full Settings → Extensions или hot unload/sandbox. Synchronous trusted JS может завершить/заблокировать приложение. Unknown crash use сохраняется и требует проверки, не unsafe PID cleanup.
