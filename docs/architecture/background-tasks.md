# Архитектура фоновых задач

[Обзор архитектуры](../architecture.md) · [Справка](../background-tasks.md) · [Материалы проверок](../contributors/reports/background-tasks.md)

`BackgroundTaskService` принадлежит application/repository composition. `builtin.background` предоставляет инструменты управления, `/tasks`, форматтеры и context provider; scheduler и процессы принадлежат core. Lookup, activation, autocomplete, Settings и render не запускают команды. Runtime AI-помощников остаётся отдельным.

## Принятие и исполнение

`run_shell` по умолчанию выполняется foreground. Необязательные поля: `background`, `taskKind`, `label`, `deadlineMs`, `outputBytes`, `readySignal`, `targetWorktreeId`, `retryOf`. Произвольный cwd вне разрешённого root или чужая копия не выбираются аргументом.

Core фиксирует UUID, ordinal, root Session/conversation/generation, child, invocation/turn, origin и actual workspace, deadline и private process identity. Submission key привязан к владельцу и вызову, записывается до spawn. Повтор принятого вызова возвращает прежний результат, включая завершённый или истёкший; receipt остаётся после удаления логов. Ручной retry — новый prepare/approval и новая identity.

Путь: capture/validation → durable acceptance и reservation → fair admission → ordinary `ToolExecutor` prepare/approval/guards/live policy → lifetime access → durable starting handshake → `ManagedProcess` → running/terminal result. Состояния очереди, ресурсов и разрешений различимы. До spawn ошибка не создаёт running. Deadline включает очередь и подтверждения. После принятия background parent tool call получает terminal tool result с handle; actual command outcome отдельный.

Техническая execution Session не попадает в список разговоров и не допускает обычный resume. Background controls имеют core attestation, effect read и пустой workspace access; чужое расширение не получает их права по имени или `builtin.*`.

## Передача ресурсов

`WorkspaceCoordinator` и durable registry `executions.json` удерживают canonical workspace и common/local Git resources. Check + grant + adopt атомарны под коротким registry lock. Обычные foreground конфликты сериализуются; конфликт с background lifetime lease даёт `BACKGROUND_RESOURCE_BUSY` с task ID/владельцем/ресурсом вместо бесконечного ожидания. Сервисные чтения и stop не ждут lease своей задачи.

Executor выдаёт private одноразовое разрешение, привязанное к фактическим handler, plan, Session и invocation. Service принимает уже удержанный lease, без release/reacquire. `finally` caller освобождает только непереданный доступ; service освобождает переданный один раз после подтверждённой очистки. Caller DTO, PID или source string разрешением не являются. Межпроцессный registry сохраняет fence погибшего shell owner: PID liveness не доказывает отсутствие его writers.

Owned detached target выбирается через P2.1 worktree port, от committed base и с обычными approvals. Durable роль `background_write` блокирует apply/remove при active или recovery writer. Независимые file tools origin работают, common Git/shell lease сохраняется. Host shell не объявляется read-only по имени `test`/`server` или предполагаемым write paths.

## Общий процессный backend

Foreground и background используют `ManagedProcess` и одинаковый approved shell path. В packaged/compiled приложении supervisor исполняется встроенным Bun runtime через `-e`; это helper процесса, не второй model/application executor и не daemon. Stdin команды закрыт; stdout/stderr backpressured, без unlimited execa `all` buffer.

Core фиксирует `ShellRuntime` до spawn: CMD на Windows, `/bin/sh` на Linux/macOS. `collectDynamicContext` и описание `run_shell` сообщают модели тот же диалект, включая child loop. Windows backend запускает CMD с `/d /s /c`, отключая AutoRun; Python получает UTF-8 defaults. Неверный `;`/отсутствующая команда объясняются после настоящего failed result; replay и подмена exit code отсутствуют.

Встроенный Windows transport использует стандартный PowerShell только как фиксированный helper: настройка UTF-8 выполняется до запуска CMD, а approved command/cwd/executable передаются данными и удаляются из environment до запуска пользовательского процесса. PowerShell не интерпретирует пользовательскую строку. `.NET Process` закрывает stdin и читает stdout/stderr по 4096 байт через `BaseStream.ReadAsync`, без line buffers. Private frames с base64 возвращают точные bytes в общий sanitizer; пользовательский вывод не может стать управляющим frame. Helper остаётся жив до process exit, EOF и адресованного core acknowledgement после census потомков. Тот же код встроен в обычный bundle и compiled binary; отдельной установки или daemon нет.

От census исключаются только собственные console hosts helper с проверенными parent PID и системным executable path. Одного имени `conhost.exe` недостаточно; пользовательские descendants продолжают удерживать ресурсы. PID исходного CMD приходит из живого private handshake и сохраняется при promotion. Diagnostic phase не является доказательством cleanup и не выдаёт права stop по чужому PID.

Private instance UUID и живой handle адресуют stop. Linux helper включает subreaper через встроенный FFI, чтобы увидеть быстрых осиротевших потомков; наблюдаемый переход в чужую group сохраняет unknown. POSIX использует собственную process group, TERM → 2 секунды → KILL; Windows — проверяемое дерево descendants и ожидаемый taskkill. Cleanup ограничен 10 секундами. Leader exit, EOF pipes и исчезновение обычных descendants — отдельные события. Код 0 при неподтверждённых writers не снимает fence. Наблюдаемый escape/неподтверждённая остановка сохраняют `cleanup_unknown`; произвольный OS daemon escape не обещается полностью очищенным.

Promotion не вызывает spawn: core заново адресует обычный approval/guards/live policy и принимает process/logs/timers/access. Старый foreground abort отсоединяется только после передачи. Абсолютный deadline сохраняется. Approval не держит registry lock; завершение/timeout во время approval возвращают фактический исход без restart. Admission promotion и starts координируются; повторное действие на одном instance не передаёт lease дважды.

## Вывод и хранение

`ProcessLog` декодирует UTF-8 по частям, удаляет ANSI/OSC/control и нормализует CR. `SecretRedactor` с holdback применяется до файлов, UI/events/tail. Два bounded stream buffers и backpressure сохраняют append sequence; порядок разных pipes не объявляется идеальным wall-clock порядком. Длинное поле/строка не накапливаются до бесконечного newline. Disk errors и output limit вызывают controlled stop, без raw fallback.

Чтение использует absolute byte cursor + output generation, проверяет canonical regular file/no symlink и owner до доступа. UTF-8 границы не разрезаются; page содержит oldest/cursor/next/end/truncated/eof/expired. Максимум 32 KiB за вызов. UI читает только страницы, отображает до 512 rows; поиск retained logs явный, bounded, локальный, без shell grep или arbitrary path.

Typed owner records schema 1 и reservations живут в canonical Home с atomic writes/locks. Session получает узкие revision patches карточек и refs; writer не сохраняет stale whole parent Session. Main, `/btw`, child spend и chat metadata merge-ятся. Background shell не расходует model tokens.

Retention удаляет только safely terminal output/history, сохраняя receipt и recovery markers. Resume saved starting/running не создаёт разрешения на replay/reconnect/kill PID. Не запущенная очередь становится interrupted; неизвестное дерево — lost/interrupted с recovery fence. Автоматического освобождения unknown writer по старым метаданным нет.

`recover` освобождает fence после временной ошибки сохранения только при сохранённом private cleanup attestation от того же живого `ManagedProcess`. Конкурентные recovery-вызовы разделяют одну операцию. После restart такого attestation нет; PID, DTO и отсутствие leader не считаются доказательством завершения descendants. Истёкшие/удалённые записи исключаются из списка истории, но status/duplicate получают прежний receipt без повторного spawn.

## Владельцы, политика и уведомления

Main tasks живут между turns, но закрываются с conversation/application. Child tasks ограничены own worktree, frozen parent ceiling, live policy и child deadline; readonly/Plan не получают process capability. Root parent видит собственные child tasks. Перед terminal result child batch bounded drain/service stop и cleanup выполняются до release writer use; итог содержит реальные task outcomes. Передачи child task родителю нет.

Feature disable и live policy narrowing отменяют queue/останавливают процессы, сохраняют данные. Main Ctrl+C отменяет owner group; captured input фонового viewer не отменяет main. Stop-all получает захваченный список UUID после отдельного подтверждения. Wait cancellation и close viewer не stop.

Completion envelope дедуплицируется по task ID + terminal revision и доставляется через существующий context provider на следующем обычном model boundary. Он ограничен и обозначен как данные, не инструкции. Callback не пишет `parent.messages`, не синтезирует tool_result без call и не запускает платный idle turn. Events fenced по owner/generation; stdout coalesced, один shared elapsed clock и cleanup listeners.

Headless batch drain ограничен общим deadline; service останавливается при выходе main. JSON содержит IDs/outcomes/cleanup/partial refs; failed/unresolved task не скрывается успешным кодом main.

## Представление

По уточнению владельца вход находится в **Меню → Фоновые задачи**, а список/логи — shared OpenTUI Dialog. Четвёртая sidebar-вкладка не создаётся. Native popup использует Palette четырёх существующих тем, stable UUID selection, owner groups, actual tail, состояния и подписанное использование output budget. Narrow/fullscreen layouts сохраняют open/stop/back; main draft/scroll сохраняются.

Existing chat API расширен typed target `background_task` и действиями open/promote/stop/wait. Dispatcher проверяет live owner через core port. Same task card обновляется revision, полный stream в transcript не вставляется. Foreground promotion и busy resource card используют тот же renderer. См. [контракт оформления](extension-chat.md).

Связанные контракты: [Помощники](subagents.md), [Рабочие копии](../worktrees.md), [Разрешения](../permissions.md), [Конфигурация](../configuration.md).
