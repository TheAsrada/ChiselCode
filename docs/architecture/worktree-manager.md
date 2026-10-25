# Графический менеджер рабочих копий

[Архитектура](../architecture.md#сервис-рабочих-копий) · [Документация](../README.md) · [Руководство](../worktrees.md)

Менеджер выпущен в [CLI 0.6.40](../contributors/reports/release-0.6.40.md). OpenTUI использует штатные `builtin.worktrees`, `WorktreeService`, ToolExecutor и механизм вкладок. Демонстрационный прототип из [плана](../contributors/plans/worktree-manager.md) не импортируется в продукт.

## Модель состояния и область прав

`WorktreeDescriptor.kind` различает `origin`, `managed`, `external`. Поле добавлено совместимо: старое `readOnly` сохранено и по-прежнему относится к управлению записью worktree service. Оно не является проверкой filesystem permission. Текстовое представление origin прямо объясняет обычные права проекта; признак commit-result появляется только для управляемой копии с известной базой и отличающимся HEAD.

UI не объявляет отсутствующие счётчики нулями. Недоступность удаления по известным counts/users/state — подсказка. Финальный отказ/разрешение всегда принадлежит backend, включая другой процесс и состояние, изменившееся после refresh.

Нулевые `run_shell.targetWorktreeId` и `retryOf` отклоняются Zod до prepare. Сообщение предлагает опустить поле для обычной команды. Неизвестный ID записи возвращает `INVALID_TOOL_INPUT`; mismatch существующей записи с Git/immutable marker остаётся `WORKTREE_RECOVERY_REQUIRED`. Нет перенаправления ошибочного ID в другой root.

## Путь действия интерфейса

`OpenTuiWorktrees` получает application-owned `WorktreeManagerActions`, привязанный к controller, generation и root. Adapter находит зарегистрированную команду именно `builtin.worktrees`, затем ставит действие в обычную очередь разговора. Перед исполнением снова проверяются command owner, scope и актуальность controller.

`runExtensionCommand` создаёт привычный runtime с конфигурацией, Session, lock, policy, grants и одноразовыми core capabilities. Quiet-флаг меняет только представление: UI сам показывает результат и не добавляет повторяющиеся списки в transcript/chatPresentations. Runtime invocations и checkpoints сохраняются; отмена и повторная проверка разрешений не отключаются. Модель не вызывается, сообщения модели не создаются.

Manager не хранит свой файловый executor или алгоритм patch/rollback. CLI и явные subcommands продолжают работать через тот же backend. `/worktree` без аргументов перехватывается только интерактивной оболочкой; одноразовый CLI сохраняет текстовый/JSON результат.

## Открытие origin и вкладок

Обычный `open(ID)` принимает только проверенную управляемую копию. Новый `openOrigin()` получает основной проект из проверенной записи origin либо фактической регистрации Git того же common directory. После admission повторно сверяется Git identity; dispose закрывает временную lease. Произвольный cwd из UI/модели не принимается.

Application активирует нужный workspace scope до создания Session и вкладки. Если разговор по этой папке уже открыт, выбирается он. Origin не получает `Session.worktree` управляемой копии. Закрытие вкладки использует действующие busy/cleanup guards и сохраняет папку. Долговечные процессы и результаты не удаляются ради UI-кнопки.

## Связь preview и apply

`diff` возвращает дополнительный `details.worktreePreview`: пути допустимых файлов и SHA-256 отпечатки пары исходного/результирующего текста, а также число omitted items. Это данные проверки, не capability и не разрешение записи.

GUI передаёт `expectedFiles` для выбранных путей. На подготовке apply сервис сравнивает их с новым snapshot. Расхождение даёт `WORKTREE_STALE` до записи. Затем продолжают действовать существующие immutable plans, проверки source/target, staging, writer leases, изменения во время approval и concurrent-safe rollback.

Поле optional: старые CLI и инструменты сохраняют контракт. Интерактивное подтверждение штатного executor по-прежнему показывает подготовленный актуальный diff. GUI не подменяет его автоматически после устаревшего просмотра и не удаляет ошибочные результаты из истории.

## Input и отображение

Использованы общие `OpenTuiDialog`, `DialogAction`, `FileDiffCard`, палитры и input ownership. Manager остаётся смонтирован под диалогом разрешения, но не принимает ввод, пока approval имеет приоритет. Mouse actions проверяют press/release, selection, drag, размеры и input revision; Enter не может подтвердить только что открытое удаление, поскольку по умолчанию выбрана отмена.

Выбор привязан к ID, поиск — к названию и пути. При исчезновении выбранной копии UI возвращается к списку, а не подставляет другую папку под старое действие. Ошибка refresh сохраняет предыдущий снимок с меткой устаревания; полный текст ошибки доступен на отдельном экране. Маленькое окно оставляет возврат и не допускает подтверждения mutation в обрезанном диалоге.

## Проверки

- `tests/unit/worktree-actions.test.ts`: область readonly, неизвестные counts, ignored/users и nil UUID.
- `tests/unit/opentui-worktrees.test.tsx`: настоящие renderables, две темы, форма/resize, blocked remove и безопасная отмена.
- `tests/integration/worktrees-runtime.test.ts`: настоящие Git, grants, origin admission, обычная запись origin, preview fingerprints, conflict/stale/rollback/retention/ownership.
- `tests/fixtures/tui-worktree-manager.ts` и integration wrapper: production app, настоящий SDK и инструменты, create/open/edit/diff/apply/origin/close/remove с обычными подтверждениями, resize и отсутствие лишних model requests/history.

Полный source выполняется один раз на Linux. Native smoke дополнительно компилирует и выполняет полный сценарий менеджера на Linux/macOS/Windows. Windows/macOS запускают целиком затронутые файлы runtime/UI/paths согласно [порядку проверок](../contributors/testing.md). Физические терминалы и пользовательский Git-config не подменяются результатами headless renderer.

## Сервис рабочих копий

Графический менеджер, quiet command lane, origin admission и preview fingerprints описаны в [устройстве менеджера](worktree-manager.md).

`builtin.worktrees` подключён в явную default composition; пустой `ExtensionHost([])` остаётся пустым. Factory владеет application/repository bookkeeping; workspace service token даёт captured-root port. Registry identity — canonical `git-common-dir`; workspace — working root + worktree-specific git-dir, полученные через Git и realpath, включая linked `.git` file и вызов из subdirectory.

`src/worktrees` готовит immutable private snapshots и планы. Mutation capability находится в core WeakMap, привязана к Session/invocation/lifetime; JSON input и mutable plan.data её не подделывают. Только ToolExecutor после Plan/policy/approvals/guards выдаёт одноразовый grant. Core-issued mixed access plan захватывается один раз: source read, origin write, worktree-local index/HEAD, repository-common Git metadata и registry. Повторного acquire внутри handler нет. File roots независимы; shared refs/config/registrations и generic shell используют common Git write lease. Revisions затрагивают write resources, не все файловые observations соседних worktrees.

Global/per-repository registry использует version checks, atomic fsync/rename и existing cross-process Home lock. Create intent хранит immutable base до mutation; apply intent — source/target identity, selected before/after hashes и Session/invocation checkpoint link. Reconciliation не replay-ит разрешение. Ownership marker и disk stamp защищают от случайной подмены registry/path; это не sandbox против JS с полным доступом пользователя. Use admission/remove делят registry lock; heartbeats проверяют host/PID и Linux process start identity, неизвестный живой owner блокирует remove.

Default worktree registration идёт перед LSP: reverse scope cleanup сначала останавливает процессы, потом освобождает use lease. Origin и все открытые tabs удерживают свои scopes; последний ушедший root закрывает LSP/scope, сохраняя disk tree. `run-command` выдаёт foreground invocation только narrow `worktrees.open(ID)`; verified descriptor передаётся core application action, удерживая admission lease до открытия scope/tab. Side-query context `/btw` этого port не получает. Session.worktree — optional presentation metadata schema 3, не capability.

Apply использует existing EditingService.replaceBatch/commit, реальные fresh-read observations, staged writes, validation перед каждым write и concurrent-safe rollback. Другого patch engine/executor/history store нет. Git driver использует executable+argv, minimal environment без Git routing variables, bounded binary output, deadlines/tree termination; hooks, fsmonitor, external diff/textconv и auto-maintenance отключены. Доступ к Home не расширяет WorkspacePolicy: только issued capability конкретного owned tree/origin. Подробные пределы и recovery: [Worktrees](../worktrees.md).
