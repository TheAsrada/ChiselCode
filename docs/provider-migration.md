# Provider Architecture: migration и проверка

Исходная точка: HEAD `9efae37ad2dd9fe8782839ec91c6559fbd412533`, совпадает с последним опубликованным релизом **v0.6.0** (30 сентября 2026). Baseline: typecheck PASS; lint PASS (144 files); bun test **233 pass / 0 fail**. Исходный config не имеет schemaVersion, хранит defaultProvider/defaultModel и закрытый record providers. Session schemaVersion=2 хранит provider; session index schemaVersion=1. Credential storage — существующий credentials.enc, изменения формата не планируются.

## Что изменилось относительно v0.6.0

Provider Definition, Protocol Driver и Profile разделены. Каталог открыт для namespaced manifests; labels/env vars/endpoints/defaults/capabilities имеют source of truth в definitions. Generic app/CLI/UI/config/sessions/core не выбирают поведение по имени provider. SDK imports остались только в drivers. AgentRouter использует generic openai-chat. Core Runtime v2 и его tool/context/editing mechanics сохранены.

## Старый config

Читается без записи, migrates in memory в schemaVersion=2. Provider openai → profile openai-default; остальные аналогично. Unknown fields/providers сохраняются. Global defaultModel переносится только в default profile при отсутствии собственного model. apiKeyRef и baseUrl сохраняются. Multiple profiles имеют независимые настройки; --provider не выбирает случайный account.

## Credentials

credentials.enc физически не мигрирует. Config/session migration и provider discovery не расшифровывают store. Credential lookup происходит только при выбранном runtime, explicit key check/doctor/settings; запись — только при сохранении нового ключа пользователем. Existing apiKeyRef не переименовываются. Новому profile по умолчанию соответствует одноимённая запись credential.

## Когда config переписывается и какие backups

Только реальный save настроек (включая изменение UI preferences) сохраняет config v2. Перед первым v2 save исходные bytes записываются в config.v1.backup.json через exclusive create; существующая backup не заменяется. Config пишется в temporary file с fsync и atomic rename. Невалидный config не reset; error показывает path без содержимого/секретов. Unknown future schemaVersion не угадывается.

## Старые sessions и indexes

v2 с provider читается в памяти как v3 providerId/profileId/model. Legacy profile ID: provider ID + -default, slash namespace заменяется дефисом. Missing provider получает controlled unknown identity; missing profile требует explicit selection при request. Transcript/runtime/context/summary/undo/diffs сохраняются. Session unknown/removed provider открывается и показывается; новый запрос требует установленный provider и настроенный profile.

Нет mass migration project sessions при startup. Save/checkpoint/rename переписывает только соответствующую session в v3. Отдельный session backup не создаётся; atomic writes сохраняют исходник при ошибке. Совсем старые sessions из прежнего config directory по-прежнему копируются в project storage с сохранением original files. Session index v1 rebuild в v2 — cache; project registry/metadata остаются schemaVersion=1.

## Старые CLI commands

chisel, setup, doctor, --provider, --model, --base-url, --resume, /settings и /model поддерживаются. --provider — compatibility interface, не удалён и не получает deprecation warning. Один profile используется; при нуле предлагается setup, при нескольких требуется --profile. Новые --profile и providers path/list/validate описаны в CLI docs.

## Deprecated внутренний API

Legacy adapter constructors, URL helpers, ProviderKind/Schema open-string aliases, non-enumerable config defaultProvider/defaultModel/providers projection и session.provider оставлены для compatibility. Диск хранит config v2 и session v3; persisted enum отсутствует. Projection providers не выбирает произвольный profile, если accounts несколько. Runtime не зависит от этих wrappers.

## Архитектурные адаптации к текущему коду

ТЗ говорит AgentLoop; текущий HEAD использует AgentRuntime и compatibility AgentLoop. Оба получают только adapter. Context overflow recovery/cancellation требуют context_overflow/cancelled/transport/refusal: generic error model расширен, эти категории не удалены. Если у definition/profile нет effective endpoint, runtime возвращает invalid_endpoint: SDK default не выбирает сервис за пользователя. Пользовательские drivers не загружаются: только manifests для bundled protocols. Discovery выполняет только локальный parsing; registry deterministic ordering выполняется отдельно.

## Ограничения

Live-model/API checks не входят в offline test suite и требуют реальные profile/credentials. Health unsupported не failure. Стоимость approximate только для явно известной model/definition, прочее unknown. Никакого marketplace, executable custom JS, watcher или OS sandbox для providers не добавлено.
