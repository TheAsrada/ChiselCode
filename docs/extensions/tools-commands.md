# Tools, commands и модель

[Разработка расширений](README.md) · [Первый пакет](quickstart.md) · [Lifecycle](contributions.md)

`sdk.defineTool` принимает JSON Schema и metadata. Не привозите отдельный Zod instance. Поддерживается bounded object schema: `type/properties/required/additionalProperties/items`, `enum/const`, числовые и строковые пределы, `pattern`, размеры массивов/objects, `uniqueItems`, `anyOf/oneOf/allOf`, `description/title/default`. `$ref`, remote resolution, formats, `$schema` и неизвестные keywords отклоняются. `default` описательный; host не подменяет аргументы.

Host назначает canonical имя `ext:<manifest-id>:<local-name>`, source и permission по effect. `read` использует read, `workspace_write` — edit, `process` — shell. Обычные Plan/Build, запреты, approvals, guards, rechecks, coordinator и checkpoints сохраняются. Доверие к коду не является разрешением tool call.

## Подготовленный эффект

Prepare получает новый readonly объект с `workspaceRoot/sessionId/invocationId/mode/signal` и `plan`. Он не содержит Session, events, sandbox, credential storage или private grants.

- `plan.readText(path, {offset?, limit?})` — штатное чтение с наблюдением ревизии, пределом 512000 bytes и workspace policy.
- `plan.writeText(path, content)` — штатный fresh-read preflight и diff через EditingService.
- `plan.shell(command, {cwd?, timeout?})` — фиксированная foreground host-команда. Для background/promotion используйте обычный `run_shell` через command tools port.

Верните EffectPlan именно этого invocation. Это opaque identity: JSON clone, план другого вызова или подмена ресурсов отклоняются. Execute получает readonly invocation и `effects.run()` без аргументов. Он выполняет только захваченный план, один раз. Host удерживает outer lease до завершения уже начатого эффекта даже при ошибке callback; вложенный executor не acquire-ит конфликтующий lease.

Существующий файл сначала прочитайте штатным инструментом. После approval смена bytes даёт stale error; direct trusted fs call не считается штатным наблюдением. Запись сохраняет undo/checkpoint через текущий runtime.

## Команды и capabilities

`ctx.commands.register` захватывает metadata, parser, policy и callback. Автодополнение не выполняет callback. `foreground` получает invocation-bound `model` и `tools.execute(name,args)`. Own tools задавайте полным canonical именем. Поддерживаемые builtin operations ограничены текущим port: worktrees create/list/status/diff/apply/remove; subagents submit_readonly/submit_coding/list/status/result/wait/cancel; Background Tasks list/status/read_output/wait/stop/recover; LSP status/diagnostics/definition/references/symbols/restart. Process start Background Tasks идёт через `run_shell`.

Прямых WorktreeService/SubagentService/BackgroundTaskService нет. Foreign external tools и произвольные cwd/PID/session не доступны. Обычные tools calls считаются, проходят live policy и child ceilings. Readonly child не получает process от доверия расширению.

`side_query` получает только model port и readonly invocation. Верните **результат собственного** `model.request(input,observer)`; реконструированный DTO не выдаёт authority. Model/owner/credentials задаёт host. Отдельные accounting, cancellation, сохранение, streaming и конечные limits остаются такими же, как у [/btw](../side-questions.md). Activation, UI provider и autocomplete не получают model port.

Native/network capabilities используются штатными tools и действующей политикой; `web_search/web_fetch` проходят действующие network guards. API v1 не предоставляет свободный fetch, sandbox executor или произвольный service lookup. Доверенный JS может обращаться к ОС напрямую — это отдельное свойство модели доверия, а не SDK capability.
