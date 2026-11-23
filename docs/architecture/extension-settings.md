# Каталог расширений и операции настроек

[Архитектура](../architecture.md) · [Управление пакетами](extension-packages.md) · [Desktop](desktop.md) · [Декларативный SDK](../extensions/settings.md)

`ExtensionManagementService` объединяет пассивные package status P3.2, manifest metadata, реальные настройки builtins и диагностики уже существующих workspace scopes. List не вызывает `host.open`, не импортирует пакет и не спрашивает модель. Actual activation относится к текущему application/root; registry и use records других процессов не доказывают active. Полные loaded digest и settings revision позволяют отличить работающую версию от отложенного выбора. Повреждение, activation failure, project narrowing и deferred removal попадают в каталог.

Подготовка использует единственный `PackageManagementService`. Service держит private prepared handle, а клиент получает `ExtensionReview`: ID, version/digest, revision, compatibility и проверенный inventory. Review связан с UUID операции, exact digest и текущей revision. Install дополнительно проверяет registry revision, update/trust/rollback/remove — per-ID CAS. Trust установленного пакета изменяется атомарно после повторного inspect. UI не может изготовить commit authority из JSON.

Операции имеют preparing/review/committing/completed/cancelled/error и bounded progress. Один requestId не создаёт второй capture/commit; другое подтверждение для занятого ID отклоняется. Закрытие review вызывает core cancel, private staging очищается. Review истекает через 30 минут; одновременно допускаются восемь незавершённых операций, retained DTO ограничены 64. Отмена после начала публикации не выдает несуществующий rollback: outcome определяет P3.2 transaction.

`ExtensionSettingsStore` хранит global per-ID значения отдельно от immutable package bytes. Manifest задаёт bounded declarative validation. Save под registry lock перепроверяет выбранный digest/revision, затем использует settings CAS и atomic write. Secret references не входят в DTO; новые credential references публикуются вместе с metadata, старые удаляются после commit. Unknown keys сохраняются, runtime snapshot выдаёт только текущую схему. Секрет, полученный через SDK, регистрируется в общем redaction boundary.

SDK API v1 дополнен `settings.read/secret`; desktop SDK 1.1.0 и protocol 1.1 добавляют совместимые методы. Handshake capabilities: `extension-management`, `extension-settings`. Старый engine показывает недоступность нового раздела; существующие methods/events/session schema не изменены.

Публичные методы: `extensions/list`, `prepare`, `operation`, `cancel`, `commit`, `setEnabled`, `settings/read`, `settings/save`, `builtin/read`, `builtin/save`, `lsp/action`. Входные DTO проходят strict schemas адаптера. Builtin forms переиспользуют `LspSettingsStore`, `SubagentSettingsStore`, `BackgroundSettingsStore` и их global/project revisions/ceilings. Просмотр LSP использует только существующий service; терминальное меню запускает сервер через `prepareUiToolInvocation` и общую очередь с обычными permissions. Удаление пользовательских LSP-команд не меняет публичные методы engine/SDK; существующий `lsp/action` не обходит запрет запуска без process tool.

Desktop renderer получает только SDK DTO. Native bridge выбирает directory/ZIP и выдаёт одноразовый path grant для prepare; renderer не читает файлы, не устанавливает пакет и не получает credentials. Явный перезапуск проверяет активные turns, children/background и клиентскую очередь, сохраняет UI draft/session, закрывает engine. Production handshake не отключается. Для source candidate есть отдельный dev-only lock selector; установленное приложение его игнорирует.

OpenTUI сохраняет неотправленный composer draft отдельно от Session/model messages: protected CredentialStore content и bounded metadata под canonical Home. Главный черновик восстанавливается при запуске, session draft — при открытии беседы. Package remove не удаляет drafts, settings, sessions и пользовательские файлы.


## Разделы настроек OpenTUI

`ExtensionManagementService` проецирует доступные вклады в общий каталог Settings. Источник метаданных внешнего пакета — проверенный manifest. Раздел адресуется как `extension:<manifest.id>`, форма берётся из `settings.fields`. Для встроенных форм ID раздела совпадает с ID владельца. LSP, субагенты и фоновые задачи хранят метаданные в своих модулях и используют существующие формы. ChatGPT добавляет поисковые метаданные к «Подключениям» и предоставляет варианту сервиса свой provider.

Основная навигация и поиск используют один список. Вклад появляется при включённом владельце и с учётом ограничений текущего проекта. Смена доступности обновляет список и закрывает открытый раздел. Индекс содержит только метаданные. Пакет открывает тот же редактор, что и карточка, с проверкой schema, digest и revision, автосохранением и CredentialStore.

OpenTUI применяет выключение к активным workspace scopes. Lifetime владельца отменяется, регистрации снимаются, ресурсы из `ctx.add` освобождаются в обратном порядке. Команды, инструменты и действия, полученные до выключения, теряют доступ вместе с прежним lifetime. Встроенные возможности получают новый lifetime при включении. Стандартный пакет сохраняет загруженный модуль до перезапуска процесса. Пакеты `kind: "ui"` переиспользуют свой отдельный live lifecycle.

[Настройки пакета в OpenTUI](../assets/settings-sections/package.png) · [Поиск после выключения](../assets/settings-sections/search-disabled.png) · [Карточка пакета с перезапуском](../assets/settings-sections/restart.png) · [Форма LSP после повторного включения](../assets/settings-sections/lsp-restored.png).

## Каталог OpenTUI и карточка расширения

В 0.6.34 OpenTUI отделяет каталог от карточки выбранного расширения. Пассивный список показывает только metadata; Enter и нажатие открывают `details`. Каталог, фильтр, карточка, source, review, версии и параметры — состояния одного `OpenTuiExtensions` внутри Settings, с общей captured root и ID пакета. Стрелки внутри карточки перемещаются по действиям и не меняют владельца открытой формы.

Список доступных кнопок и keyboard targets строятся из структурированных `MenuEntry` и `CatalogExtension.actions`. Буквенные команды изменения пакета удалены; мышь и Enter проходят через один `invoke`, busy guard и прежние методы management service. Название, состояние, reason и предупреждение о restart показаны до технического accordion. Неизвестные поля параметров, секреты, CAS/revision, review digest и отмена остаются ответственностью ядра.

Review сохраняет исходно снятое доверие и отдельное подтверждение. Кнопки доверия/подтверждения/отмены закреплены под прокручиваемой проверкой пакета, поэтому длинный inventory не скрывает управление. Проверка несовместимости и требуемого доверия повторяется и перед commit. Просмотр не импортирует пакет и не вызывает модель.

Выбор, поиск и фильтр сохраняются при возврате в каталог. Запрос на прокрутку к выбранной строке или native editor исполняется в `renderBefore`, после native layout; обычное обновление данных не возвращает пользователя наверх. Горизонтальная полоса отключена отдельно от вертикальной: OpenTUI 0.5.12 применяет общий `scrollbarOptions` к обеим полосам. Незавершённый ввод учитывается в dirty state; resize не пересоздаёт поле секрета. Общий `DialogAction` получил необязательную семантическую подпись справа, чтобы состояние каталога не окрашивало всё название.

Каталог карточек сохраняет существующий протокол Desktop. [Кадры и фактические проверки CLI](../contributors/reports/extensions-cards.md).
