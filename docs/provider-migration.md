# Provider Architecture: migration и проверка

Исходная точка: HEAD `9efae37ad2dd9fe8782839ec91c6559fbd412533`, совпадает с последним опубликованным релизом **v0.6.0** (30 сентября 2026). Baseline: typecheck PASS; lint PASS (144 files); bun test **233 pass / 0 fail**. Исходный config не имеет schemaVersion, хранит defaultProvider/defaultModel и закрытый record providers. Session schemaVersion=2 хранит provider; session index schemaVersion=1. Credential storage — существующий credentials.enc, изменения формата не планируются.

Аудит обнаружил provider branches в app/run-prompt, CLI, setup-values, settings, opentui-agent, core/context-usage, sessions/store, URL helpers и adapters. SDK imports есть в app/run-prompt и adapters. Эти места переводятся на definitions/drivers по рабочим этапам.

Core Runtime v2 требует context_overflow/cancelled/transport/refusal: эти error categories сохраняются в расширенном generic ProviderError вместо удаления ради сокращённого примера ТЗ. AgentLoop — compatibility API над AgentRuntime; оба получают только adapter.

Config v1→v2 lazy: чтение не пишет диск; следующий save валидирует оба состояния и создаёт `config.v1.backup.json` без перезаписи существующей backup. Затем temp file с fsync заменяет config через rename. Ошибки не reset config и не печатают содержимое. apiKeyRef сохраняются, credentials.enc не читается. Legacy config API временно получает non-enumerable accessors; на диск они не попадают.

Session v2→v3 lazy: load переводит provider в providerId и legacy default profile ID, включая unknown provider. History и summary читаются без установленного definition. Новый запрос требует существующие definition/profile. Физическая запись v3 происходит при save/checkpoint/rename одной сессии; mass migration нет. Session index v1 игнорируется/rebuild в v2; project registry остаётся v1. Существующий перенос совсем старых sessions из config directory сохраняет originals. Session backup отдельно не создаётся; atomic writes не повреждают исходник при ошибке.
