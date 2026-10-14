# Каталог расширений и операции настроек

[Архитектура](../architecture.md) · [Управление пакетами](extension-packages.md) · [Desktop](desktop.md) · [Декларативный SDK](../extensions/settings.md)

`ExtensionManagementService` объединяет пассивные package status P3.2, manifest metadata, реальные настройки builtins и диагностики уже существующих workspace scopes. List не вызывает `host.open`, не импортирует пакет и не спрашивает модель. Actual activation относится к текущему application/root; registry и use records других процессов не доказывают active. Полные loaded digest и settings revision позволяют отличить работающую версию от отложенного выбора. Повреждение, activation failure, project narrowing и deferred removal попадают в каталог.

Подготовка использует единственный `PackageManagementService`. Service держит private prepared handle, а клиент получает `ExtensionReview`: ID, version/digest, revision, compatibility и проверенный inventory. Review связан с UUID операции, exact digest и текущей revision. Install дополнительно проверяет registry revision, update/trust/rollback/remove — per-ID CAS. Trust установленного пакета изменяется атомарно после повторного inspect. UI не может изготовить commit authority из JSON.

Операции имеют preparing/review/committing/completed/cancelled/error и bounded progress. Один requestId не создаёт второй capture/commit; другое подтверждение для занятого ID отклоняется. Закрытие review вызывает core cancel, private staging очищается. Review истекает через 30 минут; одновременно допускаются восемь незавершённых операций, retained DTO ограничены 64. Отмена после начала публикации не выдает несуществующий rollback: outcome определяет P3.2 transaction.

`ExtensionSettingsStore` хранит global per-ID значения отдельно от immutable package bytes. Manifest задаёт bounded declarative validation. Save под registry lock перепроверяет выбранный digest/revision, затем использует settings CAS и atomic write. Secret references не входят в DTO; новые credential references публикуются вместе с metadata, старые удаляются после commit. Unknown keys сохраняются, runtime snapshot выдаёт только текущую схему. Секрет, полученный через SDK, регистрируется в общем redaction boundary.

SDK API v1 дополнен `settings.read/secret`; desktop SDK 1.1.0 и protocol 1.1 добавляют совместимые методы. Handshake capabilities: `extension-management`, `extension-settings`. Старый engine показывает недоступность нового раздела; существующие methods/events/session schema не изменены.

Публичные методы: `extensions/list`, `prepare`, `operation`, `cancel`, `commit`, `setEnabled`, `settings/read`, `settings/save`, `builtin/read`, `builtin/save`, `lsp/action`. Входные DTO проходят strict schemas адаптера. Builtin forms переиспользуют `LspSettingsStore`, `SubagentSettingsStore`, `BackgroundSettingsStore` и их global/project revisions/ceilings. Просмотр LSP использует только существующий service; запуск сервера остаётся явным `/lsp-restart` с обычными permissions.

Desktop renderer получает только SDK DTO. Native bridge выбирает directory/ZIP и выдаёт одноразовый path grant для prepare; renderer не читает файлы, не устанавливает пакет и не получает credentials. Явный перезапуск проверяет активные turns, children/background и клиентскую очередь, сохраняет UI draft/session, закрывает engine. Production handshake не отключается. Для source candidate есть отдельный dev-only lock selector; установленное приложение его игнорирует.

OpenTUI сохраняет неотправленный composer draft отдельно от Session/model messages: protected CredentialStore content и bounded metadata под canonical Home. Главный черновик восстанавливается при запуске, session draft — при открытии беседы. Package remove не удаляет drafts, settings, sessions и пользовательские файлы.
