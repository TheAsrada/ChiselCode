# UI contributions внутренних расширений

[Архитектура](../architecture.md) · [Пользовательская справка](../interface-contributions.md) · [Отчёт](../contributors/reports/ui-contributions.md)

Это рабочий internal linked API. Код расширения исполняется в процессе приложения. Loader, установка, trust, marketplace, внешний SDK и совместимость package/apiVersion остаются отдельным этапом. Data-only contracts и AbortSignal не создают OS sandbox и не прерывают синхронный бесконечный JS callback.

## Регистрация

`src/extensions/index.ts` экспортирует `UiContribution`, `UiDetailsView`, `UiBinding`, `UiSource`, `UiSnapshot`, `UiDetailsPage`, `UiRow`, `UiAction`, `UiActionUse`, `UiTone`, `UiOwnerSummary`, `OwnedUiContribution`, схемы `UiSnapshotSchema`, `UiDetailsPageSchema`, `UiActionUseSchema`, `UiRowSchema` и core consumers `ExtensionUiRegistry` / `UiSubscription`. Контракты не импортируют React, OpenTUI или controller.

`ctx.ui.register(contribution)` и `ctx.ui.registerView(view)` входят в существующий staged lifecycle `WorkspaceExtensionScope`. Identity — canonical workspace, scope instance, host-assigned extension ID и local ID. Local ID соответствует `[a-z][a-z0-9_-]{0,63}`. Метаданные и ссылки функций захватываются при регистрации; поздние регистрации, дубликаты и ошибочная metadata отклоняются. Публикация происходит после общего seal. Rollback и reverse disposal продолжают cleanup остальных ресурсов после ошибки.

Три slots: `status`, `context_section`, `menu_entry`. Menu group ограничен `conversation`, `project`, `extensions`; core groups остаются первыми. Порядок стабилен по order, extension ID и local ID. Идентичные local IDs разных расширений разрешены. Renderer выбирает Palette, размеры, размещение и input ownership.

```ts
import type { ChiselExtension, UiSnapshot } from "../../src/extensions/index.js";

export const extension: ChiselExtension = {
  id: "linked.review",
  activate(ctx) {
    // Cache заполняет штатная доменная работа, не открытие интерфейса.
    const cached: UiSnapshot = {
      revision: 1, state: "empty", detail: "Проверки ещё не выполнялись",
      action: { id: "open" },
    };
    ctx.ui.register({
      id: "review", slot: "context_section", scope: "conversation",
      title: "Проверка проекта",
      actions: [{ id: "open", label: "Открыть", type: "view", viewId: "review" }],
      source: { snapshot: () => cached },
    });
    ctx.ui.registerView({
      id: "review", scope: "conversation", title: "Проверка проекта",
      page: () => ({ revision: 1, state: "empty", summary: cached.detail }),
    });
  },
};
```

`UiSource.snapshot(binding)` возвращает readonly cache DTO, `subscribe(binding, changed)` — disposable subscription. Named view имеет `page(binding, {cursor?, search?})` и optional subscribe. Revision монотонен; row IDs стабильны. Не выполнять tools, модель, network, анализ/scan или произвольное чтение файлов внутри provider. Activation может подключить cache events; она не запускает команду.

## Binding и данные

Core назначает `UiBinding.workspaceRoot`, `scopeInstance`, optional conversation/session IDs, generation и signal. До Session её ID отсутствует; просмотр Session не создаёт. Conversation provider получает только readonly `read.ownerSummary()` и `read.subscribeOwner()`, ограниченные его владельцем. Workspace provider не получает conversation/session identity или чужие owner counters. Mutable Session, controller, SDK, credentials и raw environment не выдаются.

`ExtensionUiBinding` — application adapter, не extension port. Он связывает видимый controller со scope, отписывается при switch/replacement и хранит selection/cursor/search/scroll по owned view key. Закрытие UI отменяет readonly requests; runtime фоновых задач и помощников продолжает существующее владение. Старые результаты fenced по scope instance, binding lifetime, generation и request serial; старые revisions игнорируются.

Strict DTO schemas принимают plain text, состояния `loading/empty/ready/stale/error/unavailable`, tones `muted/accent/success/warning/error`, counts, rows и declared action uses. ANSI/OSC/C0/C1 и секреты очищаются до cache/publication. Malformed, oversize, throw и timeout изолируются fallback «Данные недоступны». Plain данные не входят в model messages или новую долговременную память.

Row IDs уникальны внутри списка и страницы. UI scope получается через узкий host path без перечисления навыков. Изменения tracked documents обновляют LSP cache даже у backend, который не прислал diagnostics; открытие view не добавляет анализ.

| Ограничение | Значение |
| --- | --- |
| Contributions / named views на extension | 12 / 8 |
| На workspace scope | 64 / 32 |
| Snapshot / page | 64 KiB sanitized JSON |
| Title / detail | 120 / 2000 символов |
| Section preview | 8 rows |
| Page / mounted list window | 100 / 64 rows |
| Generic viewer cache | Одна ограниченная page и summary, менее 256 KiB |
| Initial/cache request | 2 секунды, cooperative cancellation |
| Publications | Coalescing до 10 в секунду на source |
| Compact status | До 3 items и один overflow |

Retry явный. Subscription events обновляют cache; постоянного polling/retry loop нет. Registry не форматирует историю на output delta. Headless runtime регистрирует descriptors, но не bind-ит UI providers.

## Действия

Static `UiAction` объявляет `view` с owned local view ID, `tool` с local tool name или `core` с private attested navigation reference. DTO содержит только `{id, args?}`. Unknown IDs, foreign tool names и устаревшие snapshot/page actions не получают authority. Core references создаёт внутренняя composition; они отсутствуют в linked exports и не восстанавливаются из JSON.

Dispatcher захватывает owner/generation/key/revision/args до await, проверяет live action и dedupe pending mutations. Own-tool action принимает только `ext:<host-owner>:<local-tool>`, schema-valid input и private application receipt. `prepareUiToolInvocation` не регистрирует slash-команду: оно входит в обычную `TuiTabExecution` queue и `runExtensionCommand` / session tool runtime. Сохраняются Plan, permissions, approval arbiter, guards, policy rechecks, coordinator, cancellation, artifacts и checkpoints. Закрытие view не откатывает уже принятый effect; результат сохраняется первоначальному owner.

Navigation не вызывает модель и не ждёт busy main. Background/subagent controls используют прежние narrow verified ports; generic arbitrary writes/processes не обходят executor. Resource busy сохраняет существующий typed result и lease. Скрытые secret args не запускаются как строка с placeholder.

Chat API сохранён. Core targets `subagent` и `background_task` открываются общим owner adapter; `open/promote/stop/wait` сохраняют прежние ограничения. Backward-compatible `extension_view` содержит local `viewId` и optional bounded informational `dataRef`; extension ID берётся из owned presentation. Сохранённый target не является execution capability. Отсутствующее view показывает недоступность без replay/model/tool.

## Production consumers

LSP регистрирует status, section и menu entry с generic analysis view. `LspService.uiStatus()` читает service-owned frozen cache; `subscribeUi()` сообщает изменения configuration/lifecycle/diagnostics/workspace revision. View не вызывает `status()`, `collectContext()` или диагностику. Counts относятся к tracked evidence; unknown/stale не становятся подтверждением отсутствия ошибок. UI координаты one-based, protocol character остаётся UTF-16. Restart — отдельное явное действие собственного process tool.

Background Tasks регистрирует menu/status и открывает существующий viewer. Backend, logs, leases, promotion snapshot confirmation и child attribution сохранены. Subagents регистрирует status/navigation, tree renderer и F7 остаются core-owned. Independent fixture `tests/fixtures/ui-extension.ts` использует только linked exports; обычный `runOpenTuiAgent` отображает её без feature-ID switch.

Generic renderer использует shared Dialog, Palette, scrollbox и captured keyboard hub. Menu Enter поглощается; Space действует только в menu focus. Details имеют bounded pagination/search и один оконный список. Mouse down/up захватывает действие; drag и поздняя смена owner не перенаправляют effect. Approval имеет priority; Ctrl+C в view не вызывает main cancellation.

Связанные контракты: [Chat presentation](extension-chat.md), [Background Tasks](background-tasks.md), [Помощники](subagents.md), [Побочные запросы](../side-questions.md).

[Вернуться к архитектуре](../architecture.md)
