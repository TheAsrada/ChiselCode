# Внутренний сервис помощников

[Оглавление](../README.md) · [Обзор архитектуры](../architecture.md) · [Пользовательская справка](../subagents.md)

## Composition и полномочия

`SubagentService` — core-owned repository/application service. `defaultExtensions` связывает его с настоящим `runChildAgent`, общим WorktreeService и `builtin.subagents`. Пустой ExtensionHost остаётся пустым. Activation, lookup и command listing не запускают модели или копии.

Core binding фиксирует Session/conversation/root/generation, профиль, модель, endpoint, политику и снимок разговора. DTO не содержит ключей, SDK, renderer или mutable Session. Linked foreground command получает узкий `subagents` port с submit/list/status/wait/result/cancel; submit проходит те же production tools и executor. Начатые calls отслеживаются до освобождения invocation; принятая задача живёт до закрытия owner, а не окончания callback. Сохранённый invocation port после завершения отклоняется. `/btw` не получает этот порт.

`controlActions` явно задаётся в command contribution, валидируется и фиксируется вместе с callback. TUI вызывает ограниченный `executeControl` до foreground queue для list/status/wait/result/cancel. Контекст содержит проверенный owner port, без tools/model. Submit остаётся обычным разрешаемым действием. Никакой классификации только по строке `/agent` в renderer нет.

Внутренние capabilities не являются публичным SDK. In-process JavaScript не изолирован; ограничения относятся к предоставляемому API, а не произвольным системным импортам.

## Принятие и scheduler

Подготовка синхронно захватывает immutable task/model/config/reference projection до allocation и approvals. Stable operation key — parent Session, turn и invocation ID. Повтор возвращает прежнюю принятую задачу. Durable allocation и parent receipt предшествуют scheduler/model/create. Ошибка сохранения не запускает child.

Очередь FIFO каждого owner с круговым admission между разговорами. Принято максимум 32 задачи, queued максимум восемь; active максимум два на owner и четыре на приложение. Awaiting approval занимает slot. Start отложен за пределы parent executor lease; wait/network/approval не держат filesystem, common Git или registry locks.

Coding start использует отдельную техническую Session и реальный P2.1 executor для create. Private worktree plan допускает только core creation consumer. Generic revision check для этого private create заменён точными повторными проверками captured OID, Git identity, своего registry record и destination: создание соседней managed копии не делает собственный intent устаревшим. Common write lease сохраняется; approvals не удерживают lease. Это не exemption произвольному Git или shell.

## Дочерний runtime и контекст

Каждый child имеет новую Session, ContextManager, event bus, checkpoint writer, tool runtime, signal и настоящий AgentRuntime loop. Readonly использует scope origin; coding получает verified detached root и отдельные extension/LSP scopes. Parent pending protocol/observations/undo не клонируются. Handoff — bounded reference data с provenance; context none исключает историю, сохраняя задачу, применимые owner/project constraints и hard policy. Required task/system/tool schemas проверяются до сети; reference units удаляются целиком с truncation.

`recovery: new_child` запрещает исполнение начальных pending protocol blocks. Просмотр сохранённого child и обычный CLI resume не начинают новый unrestricted runtime. После crash допускается только изучение результата и новое явное поручение.

## Ceiling, approvals и budgets

`ChildToolPolicy` сначала проверяет mode, фактический handler identity и sealed spec fingerprint; затем пересекает frozen parent policy с live origin/user/child policy. Проверки выполняются перед prepare и execute. Plan запрещает coding независимо от Bypass/JSON. Readonly не получает shell/write/delegation; coding получает workspace edits и разрешаемый run_shell, но не shared Git writes, lifecycle worktrees, skills writes, MCP или произвольные extension tools. Web redirects перепроверяют обе network policies, а не только первый URL.

Application ApprovalArbiter не вытесняет активный запрос. Среди ожидающих foreground получает приоритет, после двух foreground admissions доступен следующий child. Address включает root owner, child/session/invocation/generation/mode/cwd. Session grants не расширяют frozen ceiling. Noninteractive approval завершает задачу честным approval_unavailable, без зависания и replay.

Все defaults находятся в `src/subagents/config.ts`. ChildBudget атомарно резервирует estimated input плюс clamped output в child и owner envelope до каждого generation/compaction request. Observed usage заменяет резерв ровно один раз; unknown/ambiguous outcome сохраняет резерв. Transport использует настоящие drivers с SDK retries 0, compatibility fallback disabled и strict terminal validation. Единственный retry layer допускает максимум три attempts после явного 429/5xx до text; каждый attempt входит в общий предел 24. После partial/network ambiguity повтор всего поручения отсутствует. Native count_tokens заменён локальным подсчётом; это estimated planning, не provider billing.

## Запись и расходы

Реестр Home/subagents хранит owner file schemaVersion 1 под межпроцессным `withLock`: UUID owner hash, revision, process identity/token/heartbeat, bounded records. Atomic rename проверяет lock ownership и revision. Нет registry в repository и нового домашнего root.

Child пишет только свой Session. Parent `patchChild` обновляет revisioned receipt/spend под тем же index lock, что main save и patchSideQuery. Main full save merge-ит актуальные independent metadata; derived total = own main + side + children. Duplicate и поздние receipts не прибавляют cumulative expense повторно. Child Session показывает собственный расход; обычные списки разговоров не включают child technical sessions вторично. SchemaVersion Session остаётся 3: добавлены optional typed child fields, legacy записи сохраняются.

Inline result ограничен 16 КиБ, полный текст/artifact — 64 КиБ. Result port создаёт проверенный untrusted artifact в artifact store parent, чтобы штатный read_tool_result мог прочитать его. Progress ограничен 256 событиями; обновления текста объединяются. Известные credentials и terminal controls удаляются до callbacks/events/UI/storage, включая split deltas.

## Lifetime и UI

Окончание foreground не закрывает children TUI. Owner close fences output, отменяет queue/model/tools/approval и ждёт bounded cleanup. Coding use lease `subagent_write` освобождается после tool bindings/LSP/host cleanup. Неподтверждённый или умерший write owner сохраняет recovery block, не превращается в свободную копию. WorktreeService блокирует apply/remove при активном или unknown writer. Никакого автоматического discard/remove.

Headless drain ждёт группу перед выходом. Просмотр и resume reconcile saved active records только после process identity check; неизвестный/live foreign owner блокирует новый runtime. Interrupted mutations не replay.

UI использует существующую правую панель, `AgentsSidebar`, `OpenTuiAgentDetails`, Palette и shared dialog. Typed core events задают stable IDs/ordinal; selection не определяется индексом или transcript parsing. Active input owner фиксируется до глобальных listeners: дерево/details не отправляют Ctrl+C в main. Approval выше passive details и `/btw`; hide не отменяет operation. Settings остаётся центральным popup со сгруппированной навигацией.

[Оглавление](../README.md) · [Разработка](../development.md) · [Материалы проверки](../contributors/reports/subagents.md)
