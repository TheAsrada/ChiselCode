# Контракт тем расширений

[Архитектура](../architecture.md) · [SDK тем](../extensions/themes.md) · [Справка пользователя](../themes.md)

`src/themes/contracts.ts` определяет data-only `ThemeContribution/ThemeToken`. `src/themes/palettes.ts` владеет встроенными палитрами; старый UI entry `appearance.ts` сохраняет совместимые exports. `ThemeCatalog` принадлежит application `ExtensionHost`, а не React mount или `WorkspaceExtensionScope`.

## Приём определения

Linked `ChiselExtension.themes` захватывается при создании host. Public `ExtensionDefinition.themes` — optional factory metadata; внешний adapter создаёт frozen copy. Private loader metadata bridge связывает проверенную factory definition с optional wrapper. После successful seal `host.open` принимает её темы один раз. Пакет с failed activation не публикует новые палитры; failed theme validation изолирована конкретным определением.

Core назначает namespace `(extensionId, themeId)`, source внешнего пакета берётся из inspected manifest. Schema strict, callback/style/layout полей нет. Проверка полного набора RGB цветов и contrast ratio использует linear sRGB relative luminance. Limits и точные exported типы описаны в [SDK](../extensions/themes.md#поля-и-проверка).

Immutable registry не зависит от текущей беседы. Принятые данные остаются после workspace dispose; новые workspace могут добавить собственные ранее не загруженные темы. Проектное запрещение не запускает import ради каталога. Application dispose удаляет cache/subscriptions. Нет таймеров на темы, providers на каждый кадр, повторной activation или model context.

## Настройки и отображение

`ui.theme` принимает прежние builtin names либо namespaced extension identity, без версии config migration. Пользовательский `ui.accent` применяется последним. Catalog subscriptions принадлежат верхнему TUI mount; core выбирает Palette и light/dark dialog shadow. Смена палитры не меняет keys компонентов, root/session identity, editor/scroll refs или process ownership.

`OpenTuiSettings` использует общий каталог: поиск только по bounded immutable data; оконный список, selection, source/variant, preview и явное apply/cancel. Предпросмотр меняет Palette текущего UI, не рисует отдельный renderer расширения. Применение вызывает narrow `updateGlobalConfig`, сохраняя другие формы и пользовательские поля. Отмена и unmount восстанавливают последнюю сохранённую палитру.

После штатного открытия начального workspace startup проверяет сохранённую identity. Если она недоступна, выбирает Obsidian для этого запуска и сообщает об этом; сохранённая identity не стирается автоматически. Code/trust/enabled изменения применяются после restart по существующему loader contract. Нельзя объявить imported arbitrary JS выгруженным из процесса при выключении.

Темы — guardrails декларативных данных trusted in-process расширений. Они не являются OS isolation для произвольного кода пакета; code trust и обычные tool permissions остаются прежними.

Связанные контракты: [Внешние расширения](external-extensions.md) · [UI contributions](ui-contributions.md) · [Отчёт](../contributors/reports/extension-themes.md).
