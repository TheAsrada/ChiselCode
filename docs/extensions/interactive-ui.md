# Интерактивные элементы и панели

[Разработка расширений](README.md) · [Композиция](ui-composition.md) · [Горячие клавиши](../keybindings.md#действия-интерфейса-расширений)

Дополнение SDK v1 в текущих исходниках, **Unreleased**. Опубликованная CLI 0.6.37 его ещё не содержит. Старые пакеты сохраняют прежний контракт. Новые объявляют необходимые возможности в manifest:

```json
"requires": ["ui.controls", "ui.style", "ui.nativeProps", "ui.panes", "ui.media"]
```

Список предоставляет `sdk.capabilities`; декларации и `SDK_CAPABILITIES` экспортируются из `chiselcode/extension-sdk`. Неизвестная требуемая возможность блокирует загрузку до импорта. Старый host отклоняет неизвестное поле manifest. Полный готовый пакет: [Студия заметок](../../examples/extensions/studio/README.md).

## Локальное действие

Зарегистрируйте обработчик при activation; snapshot возвращает только данные:

```js
let revision = 1;
const values = new Map();
const listeners = new Set();
ctx.ui.on("note", (binding, event) => {
  if (event.type !== "change") return;
  values.set(binding.conversationId, event.value);
  ++revision;
  for (const changed of listeners) changed();
});
ctx.ui.register({
  id: "notes", slot: "pane", placement: "sidebar",
  scope: "conversation", title: "Заметка",
  source: {
    snapshot(binding) {
      return {revision, state: "ready", render: {
        mode: "replace", content: {
          type: "input", key: "note", label: "Текст",
          value: values.get(binding.conversationId) ?? "",
          onChange: {id: "note"}
        }
      }};
    },
    subscribe(_binding, changed) {
      listeners.add(changed);
      return {dispose() {listeners.delete(changed);}};
    }
  }
});
ctx.add({dispose() {values.clear(); listeners.clear();}});
```

`ctx.ui.on(id, handler)` получает readonly binding, событие и сохранённые `args`. Источник остаётся read-only. Кнопка вызывает обработчик через объявленное действие `{id, label, type:"event", eventId}` и обычный `action:{id,args?}`. Это отдельный путь от `type:"tool"`: изменение локального состояния не запускает модель или инструмент. Для файлов, процессов и сети используйте собственный tool и обычные разрешения. Доверенный JS работает in-process; этот контракт не является OS sandbox.

## Элементы

| `type` | Данные и поведение |
| --- | --- |
| `input` | Обязательные `key`, `label`, `value`; `placeholder?`, `maxLength?`, `onChange?`, `onSubmit?`, `disabled?`. События `change`/`submit` содержат `value`. |
| `select` | `key`, `label`, `options:[{value,label,description?}]`, `value?`, `onSelect`, `disabled?`. Событие `select` содержит `value` и `index`; значения вариантов уникальны. |
| `button` | Прежние `label`, `action`, `tone?`; добавлены `key?`, `hotkey?`, `disabled?`. Локальное действие получает `press`. |
| `markdown` | `text` до 20000 символов; штатное форматирование сообщений с шириной своего контейнера. |
| `code` | `text` до 20000 символов, `language?`; штатный OpenTUI code renderer. |
| `image` | `data` — base64 байты изображения, `alt`, `fit?`: `fit`, `cover`, `fill`. Размер задаётся `style.width/height`. Host не открывает URL или путь из snapshot. Неверный формат даёт короткий fallback; перед декодированием проверяется размер до 1048576 пикселей. |
| `canvas` | `key`, `label`, `rows` из строк сегментов `{text,fg?,bg?}`, `onPointer?`, `onKey?`. Сегменты образуют собственную терминальную область. События содержат относительные `x/y/button` или `name/sequence/ctrl/shift/meta`. |

Ключи `input`, `select`, `canvas` уникальны внутри contribution. Существующие `text`, `value`, `box`, `native` и их sibling-local keys сохранены. `canvas` может обновляться через source/subscribe; таймер регистрируется в activation и освобождается через `ctx.add`. В JSX/render callbacks расширения не исполняются.

## Оформление и штатные элементы

Все узлы принимают `style`: `fg/bg`, `width` в ячейках или процентах, `height`, `minWidth/maxWidth`, `padding`, `gap`, `grow/shrink`, `border`, `borderColor`, `borderStyle`, `align/justify`, `bold/italic/dim`, `wrap`. Цвет — токен активной палитры (`text`, `surface`, `accent` и остальные theme tokens) или `#RRGGBB`. Изменение локально и не меняет общую тему.

`{type:"native", props:{...}}` сохраняет предыдущий слой. `props` поддерживает оформление, `title` и `placeholder`. Например, `Composer` позволяет изменить рамку, цвет, заголовок, отступы и подсказку штатного ввода. Логика редактирования, черновик, курсор, отправка и подтверждения принадлежат host. Произвольные обработчики, ссылки на renderer и изменение значения редактора через native props не принимаются. Разрешения, доверие и настройки остаются за пределами композиции.

## Панели и фокус

`slot:"pane"` требует `placement`: `sidebar`, `above_prompt` или `below_prompt`; `surfaces` у него нет. Snapshot содержит обычный render patch. `native` внутри самостоятельной панели запрещён. `render.mode:"hide"` убирает панель. Заголовок позволяет свернуть её; то же действие доступно через Alt+U.

Боковые панели расширений получают отдельную колонку. Host резервирует её ширину при расчёте ленты. Если места для чата недостаточно или открыта главная, панель переносится над вводом в область с прокруткой. Включение штатного Sidebar для этого не требуется. Несколько панелей сохраняют порядок registry.

Щелчок или **Alt+U** передаёт фокус конкретному элементу. **Tab / Shift+Tab** переходят между показанными элементами, **Esc** возвращает в чат. `hotkey` имеет вид `alt+s`, `ctrl+shift+k` или `f2` и действует в области данного расширения; обычная буква — только на выбранной кнопке. Системные сочетания отмены, вкладок, настроек и подтверждений сохраняют приоритет. Не назначайте формулам сочетания обычного редактирования текста.

Обновление snapshot сохраняет фокус и черновик. При переносе панели сохраняется текст поля; при удалении выбранного элемента фокус возвращается host. Состояние разделено по binding, contribution, render instance и ключу узла. Для повторяющихся элементов ленты `binding.presentation` в callback содержит `surface`, `instance` и структурированные `values` конкретного участка. Это данные для представления, не разрешение на выполнение.

Обработчики одной UI-подписки выполняются последовательно. Проверяются revision, ключ, тип события, принадлежность handler, длина input и выбранный option. Ошибка обработчика переводит представление в недоступное состояние с видимым уведомлением; поздний результат закрытой беседы не применяется. Полные история и результаты инструментов не зависят от оформления.
