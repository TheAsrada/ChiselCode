# Общее ядро для терминала и desktop

ChiselCode Desktop находится в [отдельном репозитории](https://github.com/TheAsrada/ChiselCodeDesktop). Terminal UI и desktop используют один AgentRuntime, tools, EditingService, PermissionPolicy, провайдеры и хранилища.

## Граница приложения

`src/desktop/server.ts` — адаптер управления проектами и разговорами. `src/desktop/entry.ts` компилируется в автономный `chisel-engine`; тот же интерфейс доступен через `chisel app-server`. Транспорт — JSON-RPC 2.0, JSONL через stdin/stdout; сетевой listener не открывается. Stdout предназначен только для протокола, stderr не является историей разговора.

`src/desktop/protocol.ts` не импортирует runtime, Bun, OpenTUI или Electron. Из него и `client.ts` собирается браузерный `@chiselcode/desktop-sdk`. Вызовы `initialize` согласуют major протокола и сообщают capabilities, engineVersion и формат сессий. Неизвестный метод и несовместимый major отклоняются. Desktop не импортирует внутренние классы или mutable Session.

## Выполнение и владельцы

Application adapter держит один extension host, отдельные MCP managers по canonical root и владельца каждого открытого разговора. Один foreground turn на разговор; разные разговоры одного процесса сохраняют существующий WorkspaceCoordinator. Подтверждение адресовано requestId/sessionId/turnId и проходит core ApprovalResolver. Отмена очищает ожидание разрешения. Перезапуск процесса не повторяет запросы и инструменты.

Cross-process execution lease привязана к canonical Git common directory или корню обычного проекта. Пока один процесс выполняет задачу, другой получает WORKSPACE_BUSY. В одном процессе используются прежние блокировки инструментов; linked worktrees между отдельными процессами консервативно делят допуск. Копия/отдельный clone имеет свою границу. Lease сохраняется до завершения активных помощников и фоновых процессов. Метаданные lock содержат PID, hostname и одноразовый token; reclaim разрешён только для установленно мёртвого владельца. Живой или неизвестный владелец не считается stale по таймеру.

Настройки и credentials используют общий межпроцессный storage lock при patch. Сессии по-прежнему принадлежат core ProjectSessionStore, schemaVersion=3; в desktop нет второй реализации миграций. Поддерживаемые версии CLI и desktop должны использовать этот допуск. Старые CLI до 0.6.28 не соблюдают новый execution lease: одновременные изменения одной папки с ними не поддерживаются.

## Обновление

При работе агента изменения CLI и Desktop согласуются в рамках одного задания по [AGENTS.md](../../AGENTS.md) и [порядку совместной разработки и выпуска](../contributors/desktop-sync.md). Просьба владельца «сделай релиз» по умолчанию относится к обоим проектам: сначала публикуется CLI/engine, затем проверенный Desktop с этим engine.

Core release публикует автономные engine binaries, SDK и встроенные навыки с SHA-256 manifest. Desktop закрепляет tag, source commit, protocol и каждый asset hash в engine.lock.json. Обновление означает изменение lock, скачивание проверенных артефактов и прогон desktop acceptance. Приложение запускает собственное встроенное ядро, поэтому установленный глобально chisel не может незаметно заменить его версию. Engine и UI выпускаются одним установщиком.

Добавление runtime capability проходит сначала через core tests, затем через протокол/SDK и desktop acceptance. Изменения движка при совместимом контракте требуют нового lock, без копирования реализации. Изменение UI или нового типизированного метода требует также клиентского изменения. Major протокола меняется только при разрыве wire compatibility.

## Проверка

`bun tests/fixtures/desktop-server.ts` проверяет настоящий процесс, SDK, провайдера, запись файла, diff, подтверждение, отказ, отмену, межпроцессный допуск и чтение истории после перезапуска. Передавайте путь compiled binary первым аргументом для проверки установочного engine. Fixtures используют локальную scripted модель, но production runtime/tools/storage.

Расширения выполняются в ядре с прежней моделью доверия; renderer получает данные. Это не изоляция произвольного JS расширения и не новая системная sandbox. Побочный /btw и произвольные UI contributions требуют отдельной графической реализации. Каталог пакетов и реальные формы LSP/subagents/background доступны через [extension management](extension-settings.md); runtime не копируется в renderer.
