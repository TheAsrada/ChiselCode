# UI contributions внутренних расширений

[Архитектура](../architecture.md) · [Пользовательская справка](../interface-contributions.md) · [Отчёт](../contributors/reports/ui-contributions.md)

Это рабочий internal linked API встроенных возможностей. [Публичный SDK и внешний loader](external-extensions.md) адаптируют его для подготовленного trusted пакета; external context не получает private core navigation constructors. Установка, обновление, удаление и Settings используют управляемый store и exact-content review. Data-only contracts и AbortSignal не создают OS sandbox и не прерывают синхронный бесконечный JS callback.

## Регистрация

`src/extensions/index.ts` экспортирует `UiContribution`, `UiDetailsView`, `UiBinding`, `UiSource`, `UiSnapshot`, `UiDetailsPage`, `UiRow`, `UiAction`, `UiActionUse`, `UiTone`, `UiOwnerSummary`, `OwnedUiContribution`, схемы `UiSnapshotSchema`, `UiDetailsPageSchema`, `UiActionUseSchema`, `UiRowSchema` и core consumers `ExtensionUiRegistry` / `UiSubscription`. Контракты не импортируют React, OpenTUI или controller.

`ctx.ui.register(contribution)` и `ctx.ui.registerView(view)` входят в существующий staged lifecycle `WorkspaceExtensionScope`. Identity — canonical workspace, scope instance, host-assigned extension ID и local ID. Local ID соответствует `[a-z][a-z0-9_-]{0,63}`. Метаданные и ссылки функций захватываются при регистрации; поздние регистрации, дубликаты и ошибочная metadata отклоняются. Публикация происходит после общего seal. Rollback и reverse disposal продолжают cleanup остальных ресурсов после ошибки.

Четыре slots: `status`, `context_section`, `menu_entry`, `render` (последний начиная с 0.6.33). Menu group ограничен `conversation`, `project`, `extensions`; core groups остаются первыми. Порядок стабилен по order, extension ID и local ID. Идентичные local IDs разных расширений разрешены. Renderer выбирает Palette, размеры, размещение и input ownership.

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

## Композиция и live UI

Решение для 0.6.33: расширить существующий registry декларативным `slot: render`, а не передавать расширению React/OpenTUI или второй UI runtime. Публичные `UiNode`/`UiSurface` определены в `extension-sdk/ui-composition.ts`; core schema проверяет plain DTO, глубину, объём, уникальные keys и единственное native-встраивание. SDK v1 остаётся совместимым со старыми пакетами.

`UiSurface` собирает отсортированные cache patches вокруг штатного узла. `native` относится к предыдущему слою. Источники и инструменты не исполняются в paint path. Ошибка дерева/источника оставляет native, уведомление рисуется вне композиции. Root/input/error owners сохраняются один раз; защищённые dialogs не являются render sites. Высота ленты распределяется flex-layout после добавленных панелей. При перестройке wrapper host восстанавливает cursor и scroll; стабильные keys сохраняют обычные обновления без remount.

Для включения без перезапуска выбран явный `manifest.kind: ui`. `UiExtensionRuntime` владеет отдельным mount на canonical workspace/package. Введённый путь сопоставляется с cached canonical identity, включая symlink/junction и macOS `/var`/`private/var`; metadata reads не обращаются к файловой системе. Он использует прежние loader, exact-content trust, runtime snapshot, module import и use leases. Разрешены UI/chat/tools/cleanup; runtime registrations, model commands, services и themes не проходят этот lifecycle. Обычные пакеты сохраняют boot snapshot. Headless и `--no-external-extensions` не запускают UI mounts.

`UiSubscriptions` объединяет представления по attested identity, сохраняя исходный scope каждого view/action. UI tool получает private receipt с base scope, handler и UI lifetime. `runExtensionCommand` прикрепляет этот handler к обычному core runtime: guards основного workspace остаются обязательными. Сигнал UI mount включён в общий signal, в том числе при ожидании подтверждения. JSON не создаёт receipt. Перезагрузка одного пакета не отменяет чужой UI tool или фоновые процессы. Неподтверждённый cleanup блокирует повторный mount до перезапуска и отражается в каталоге.

`create_extension` — обычный `library_write` tool. Prepare проверяет manifest, пути и JavaScript пассивным Acorn parser. Он не вызывает Bun transpiler, import или macro expansion; macro imports отклоняются до разрешений. AST даёт default export и известные imports без исполнения исходника. Execute создаёт private temporary source и вызывает прежний PackageManagementService; atomic commit всегда выключен и без trust receipt. Агент не пишет registry, не активирует пакет и не подтверждает его digest. Встроенный `extension-creator` объясняет контракт и завершается указанием на Settings review.

### Сопоставление с Claude Code mods

Изучены первичные источники Anthropic на 16 октября 2026 года. [Обзор mods](https://code.claude.com/docs/en/plugins/mods/overview) описывает внутрипроцессные JavaScript/TypeScript hooks: события UI, инструментов и запросов проходят через обработчики плагина. Установка, отключение и обновление используют обычный plugin lifecycle. Модуль может обращаться к файлам, сети и данным процесса; mods не являются OS sandbox. Permission prompt исключён из изменения интерфейса.

[UI API](https://code.claude.com/docs/en/plugins/mods/interface) использует именованные render sites и `ui.render` с matcher по компоненту. `next(e)` продолжает цепочку; полученную engine reference можно встроить в своё дерево, сохранив штатное отображение. Собственное дерево заменяет участок. В документации отдельно описаны проверка элементов с fallback, обновление через invalidate, панели, полоса над вводом и владение клавиатурой. В ChiselCode эти принципы выражены cache patches и `native`; формат Claude API не копируется. Наш SDK не расширяет права инструментов через UI.

В официальном [token-weather](https://github.com/anthropics/claude-code-playground/blob/main/claude-code/mods/token-weather/hooks/token-weather.mjs) события начала сеанса и завершения хода обновляют ограниченную историю показаний, а отдельный render handler рисует полосу над вводом. Это подтверждает полезное разделение сбора данных и рисования. Наши source/subscribe и bounded snapshots сохраняют такое разделение в существующей архитектуре.
