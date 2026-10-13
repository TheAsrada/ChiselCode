# Представления, guards и lifecycle

[Разработка расширений](README.md) · [Tools и commands](tools-commands.md) · [Проверки](testing.md)

Default factory получает frozen `{sdk,manifest}`. Она возвращает `id/version/apiVersion/entry/activate`. Runtime helpers injected тем же host, поэтому compiled приложению не нужна bare-module resolution из папки расширения. Не сохраняйте Session/workspace в singleton factory.

Activation context содержит workspaceRoot, lifetime signal, registration ports и `add(disposable)`. В нём нет execute/file/process/model capabilities. Metadata/callbacks захватываются при регистрации. Late/duplicate/aborted/disposed registrations отклоняются; успешный seal публикует весь frame. Optional failure снимает только свои registrations/resources; required linked/builtin failure сохраняет строгий rollback scope.

## Chat и UI

`ctx.chat.register({id,render})` возвращает safe summary/cards. Tool/command `chat: {title, view}` выбирает formatter. Formatter получает frozen data, не изменяет выполненный результат; ошибка даёт существующий fallback. `extension_view` ведёт к owned named view. Не сериализуйте callback, token или path как authority в Session.

`ctx.ui.register` поддерживает `status`, `context_section`, `menu_entry`; `registerView` — summary/key/value/paginated list. Slot scope — workspace или conversation. Core контролирует Palette, размеры, фокус и keyboard/mouse. External actions — открыть own view или вызвать own registered tool. Private core navigation constructors, JSX/renderables и raw input handlers отсутствуют.

Точные DTO/scoping/limits совпадают с [контрактом UI](../architecture/ui-contributions.md): 12 contributions и 8 views на extension, 64 KiB snapshot, 8 preview rows, page до 100 и mount до 64 rows, cache до 256 KiB, readonly provider timeout 2 секунды, coalescing до 10 publications/second. Для данных до Session используйте empty/unknown; UI не создаёт Session или model request.

## Context и guards

`contextProviders.register({id,collect})` получает readonly invocation snapshot и возвращает `{text}`. Context входит через обычный budget как данные, не system authority. Collect не получает tools/model. Error и sanitation используют существующий pipeline.

`guards.afterPrepare/beforeExecute` получают readonly bounded snapshot. Решение — `continue` или `deny` с причиной; guard не выдаёт approval/Bypass или новые права.

## Собственное состояние

Создайте token через injected `sdk.createServiceToken<T>(diagnosticId)` и используйте `ctx.services.provide/get/lookup`. Token принадлежит SDK данного package: совпадающая строка или JSON не дают доступа. Workspace registries независимы. Cross-extension services и lookup builtins не входят в API v1.

Ресурс явно передайте `ctx.add`. Закрытие последнего owner освобождает workspace frame; соседняя беседа того же root сохраняет shared service. Dispose не выгружает module-level JavaScript и не доказывает остановку arbitrary raw effects. Recovery fences штатных worktree/process capabilities сохраняются при неподтверждённом cleanup.
