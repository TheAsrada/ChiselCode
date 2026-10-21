# Композиция интерфейса

[Разработка расширений](README.md) · [Включение и создание агентом](../ui-mods.md) · [Архитектура](../architecture/ui-contributions.md#композиция-и-live-ui)

Дополнение SDK v1 начиная с CLI 0.6.33. Старые пакеты совместимы с текущим host; опубликованная 0.6.32 не поддерживает этот контракт. Новое поле `kind` отклоняется старым host, поэтому UI-пакет не активируется в нём частично.

Расширенные компоненты, локальные обработчики, native props, самостоятельные панели и `requires` доступны в текущих исходниках **Unreleased**, ещё не в опубликованной 0.6.37. [Полный контракт интерактивного UI](interactive-ui.md).

## Зарегистрировать оформление

Manifest с `kind: "ui"` загружается отдельным live UI lifecycle в OpenTUI. Пример [workbench](../../examples/extensions/workbench/index.mjs) — self-contained ESM без зависимостей на renderer. Для установки достаточно папки с manifest и `.mjs`; отдельная сборка не нужна.

```js
ctx.ui.register({
  id: "message-frame", slot: "render", surfaces: ["AssistantMessage"],
  scope: "conversation", title: "Рамка ответа", order: 40,
  source: {
    snapshot() {
      return { revision: 1, state: "ready", render: {
        mode: "replace", content: {
          type: "box", border: true, tone: "accent", children: [
            { type: "text", text: "Ответ", bold: true },
            { type: "native" }
          ]
        }
      } };
    }
  }
});
```

Это прежний `ctx.ui.register`, с новым slot. Сохраняются scope, actions, readonly binding, ограничения источников и cleanup. JavaScript провайдера вызывается при обновлении cache, не во время React render. `subscribe(binding, changed)` сообщает об изменениях и возвращает Disposable. `revision` увеличивается счётчиком; значение часов для этого не подходит.

| `render.mode` | Поведение |
| --- | --- |
| `before` | Добавить дерево перед предыдущим слоем |
| `after` | Добавить после предыдущего слоя |
| `replace` | Заменить слой; `native` в дереве сохраняет его один раз |
| `hide` | Убрать участок, `content` отсутствует |

Порядок: `order` от 0 до 100 (по умолчанию 50), затем extension ID и contribution ID. Каждый следующий слой работает с результатом предыдущих. Только `replace` может содержать `native`; повторное встраивание запрещено. Loading, stale, error и unavailable не заменяют стандартный участок. Ошибка источника показывает уведомление вне изменяемых участков.

## Дерево элементов

`UiNode`, `UiRenderPatch`, `UiSurface` и список `UI_SURFACES` экспортируются из публичного SDK. Для исполняемого пакета используйте injected `sdk`; TypeScript types удаляются при сборке.

| Элемент | Поля |
| --- | --- |
| `text` | `text` до 2000 символов, `tone?`, `bold?` |
| `value` | `field`: `text`, `title`, `state`, `count`, `path`; `tone?`, `maxLength?` 1–20000 |
| `box` | `children`, `direction?` row/column, `gap?` 0–3, `padding?` 0–2, `border?`, `tone?`, `grow?` |
| `button` | `label`, `action: {id, args?}`, `tone?` |
| `native` | Содержимое предыдущего слоя, `props?` для штатного оформления |
| `input`, `select` | Поля формы с локальными обработчиками |
| `markdown`, `code` | Форматированный текст и код |
| `image`, `canvas` | Изображения из байтов и интерактивные цветные области |

Любой элемент может иметь стабильный `key` в формате UI ID. Соседние явные keys уникальны. Не меняйте key при обновлении подписи. Для списков задавайте keys, чтобы перестановка элементов сохраняла их состояние. Нативный участок без явного key получает устойчивый ключ. `grow: true` нужен контейнеру, оборачивающему растягиваемую ленту. Row допускает перенос при недостатке ширины; для вертикальных панелей используйте column.

Тоны: `muted`, `accent`, `success`, `warning`, `error`. Общее поле `style` поддерживает токены палитры и `#RRGGBB`, размеры, flex, рамки и текстовые атрибуты. Произвольных терминальных escape-последовательностей, JSX и ссылок на controller нет. Обработчики регистрируются отдельно через `ctx.ui.on`, в дереве остаются только идентификаторы. Строки очищаются прежним sanitizer/redactor. `value` читает структурированные данные конкретного участка; это не шаблонный язык и не разбор отрисованных строк. Неизвестное значение пустое. История и полный результат инструмента сохраняются независимо от оформления.

Ограничения: 128 узлов, глубина 8, до 32 children в контейнере, 64 KiB snapshot, 256 KiB snapshot cache на registry/binding. Сохраняются 12 contributions и 8 views на расширение, cooperative deadline провайдера 2 секунды и coalescing до 10 обновлений/с. Суммарное число UI-пакетов ограничено общим лимитом установленных расширений.

## Участки интерфейса

| Область | Имена |
| --- | --- |
| Основная раскладка | `App`, `Main`, `WorkspaceTabs`, `Header`, `Home` |
| Главная | `HomeLogo`, `HomeHints` |
| Лента | `Transcript`, `UserMessage`, `AssistantMessage`, `SystemMessage`, `CommandOutput` |
| Представления | `ToolActions`, `Skills`, `FileDiff`, `ChatCard`, `Compaction` |
| Работа агента | `RequestStatus`, `ToolProgress` |
| Ввод | `Composer`, `AbovePrompt`, `BelowPrompt`, `PromptHints`, `PromptControls`, `StatusLine` |
| Боковая панель | `Sidebar`, `SidebarMenu`, `ContextPanel`, `AgentTree` |

`Header` относится к заголовку сеанса без workspace-вкладок. Участок появляется только вместе со своим штатным компонентом. Например, закрытый Sidebar не создаётся расширением сам по себе; для постоянно видимой полосы используйте `AbovePrompt`.

`App`, `Main`, `Home`, `Composer` сохраняют native ровно один раз. Hide или replace без native для них пропускается. Аналогично защищены строки ошибок и лента, содержащая ошибку. Разрешения, доверие, настройки и модальные окна остаются вне композиции. Core сохраняет черновик, позицию курсора и чтения при перестройке native-обёртки; переключение беседы продолжает использовать её собственное представление.

## Действия и lifecycle

Button ссылается на объявленный own action. Разрешены own view, own tool и own event handler. Поля и выбор передают типизированные события через `ctx.ui.on`. `slot: "pane"` создаёт отдельную панель с `placement`; она не зависит от видимости штатного Sidebar. Отсутствующее действие или чужое имя не получает authority; аргументы и revision сверяются с сохранённым snapshot. Alt+U открывает host-owned список показанных элементов и сворачивание панелей. Мышь или выбор поля передаёт ему фокус; Tab/Shift+Tab переходят между элементами, Esc возвращает в чат. Системные сочетания сохраняют приоритет.

UI-пакеты регистрируют UI/views, chat formatters, собственные tools и Disposables. Commands, services, guards, context providers и themes в таком пакете отклоняются с rollback activation. Для них используйте стандартный пакет. Кнопка UI-tool прикрепляет единственный подтверждённый handler к обычному core-scoped runtime. Сохраняются guards основного workspace, разрешения, очередь и checkpoints. Отключение UI-owner отменяет ожидание approval и выполнение его инструмента.

UI scopes принадлежат паре workspace/package. Изменение одного не останавливает core или соседний пакет. Factory UI-пакета получает новый settings snapshot при изменении settings revision; JS-модуль импортируется по canonical path без cache-busting. Mutable state храните внутри activation с учётом conversation ID. Headless runtime UI-пакеты не активирует.

Если обновление переводит standard-пакет, уже известный текущему boot plan в `kind: ui`, сначала нужен перезапуск: host не монтирует новый UI поверх старого кода с тем же ID. Неудачный cleanup также сохраняет требование перезапуска.
