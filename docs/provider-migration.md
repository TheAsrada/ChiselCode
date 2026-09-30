# Provider Architecture: migration и проверка

Исходная точка: HEAD `9efae37ad2dd9fe8782839ec91c6559fbd412533`, совпадает с последним опубликованным релизом **v0.6.0** (30 сентября 2026). Baseline: typecheck PASS; lint PASS (144 files); bun test **233 pass / 0 fail**. Исходный config не имеет schemaVersion, хранит defaultProvider/defaultModel и закрытый record providers. Session schemaVersion=2 хранит provider; session index schemaVersion=1. Credential storage — существующий credentials.enc, изменения формата не планируются.

Аудит обнаружил provider branches в app/run-prompt, CLI, setup-values, settings, opentui-agent, core/context-usage, sessions/store, URL helpers и adapters. SDK imports есть в app/run-prompt и adapters. Эти места переводятся на definitions/drivers по рабочим этапам.

Core Runtime v2 требует context_overflow/cancelled/transport/refusal: эти error categories сохраняются в расширенном generic ProviderError вместо удаления ради сокращённого примера ТЗ. AgentLoop — compatibility API над AgentRuntime; оба получают только adapter.
