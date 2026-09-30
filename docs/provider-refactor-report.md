# Provider Architecture v0.6.1: отчёт

База: последний опубликованный релиз **v0.6.0**, `9efae37ad2dd9fe8782839ec91c6559fbd412533`. Начальный HEAD полностью совпадал с релизом. Рабочая ветка provider-architecture-v2; изменения разделены на 11 рабочих этапов/коммитов. Core Runtime v2 сохранён.

## Выполненные этапы и проверки

| Этап | Commit | Typecheck / lint | Unit/integration tests |
| --- | --- | --- | --- |
| Contracts, Registry, definitions | 20952c7 | PASS | 235 PASS |
| Driver split | 1db39e1 | PASS | 235 PASS |
| Runtime/auth/errors/endpoint | 3507bae | PASS | 239 PASS |
| Config v2 / profiles / migration | 30baef5 | PASS | 247 PASS |
| Home/providers и safe manifests/catalog | ce179e8 | PASS | 262 PASS |
| Offline custom-provider CLI | 0f19f6e | PASS | 263 PASS |
| CLI profiles/model resolution | abba1ae | PASS | 263 PASS |
| Searchable/windowed UI и multiple profiles | f4754c4 | PASS | 266 PASS |
| Sessions v3 и index rebuild | 95ad9b5 | PASS | 271 PASS |
| Capabilities/health/cache/pricing | 9782db4 | PASS | 273 PASS |
| Cleanup/documentation/release preparation | final stage | PASS | 280 PASS |

Исходная точка: 233 tests PASS, typecheck PASS, lint PASS (144 files). Финальные проверки: **280 tests / 0 failures**, typecheck PASS, lint PASS (180 files), build PASS. CLI --version=0.6.1; help/setup/providers flags проверены. 21/21 scripted eval trials успешны; сравнение с runtime-v2-mock: 21 comparable, 0 regressions, input token deltas 0. Live API не запускался: реальных profile credentials для benchmark не настроено. Gateway/AgentRouter integration тесты используют настоящий HTTP/SSE transport к локальному fake server.

## Миграции и compatibility

Config v1→v2 lazy, unknown fields/providers/apiKeyRef/baseUrl сохраняются. Global model только в default profile. Первое настоящее save создаёт config.v1.backup.json и атомарно записывает v2. Credentials.enc физически не мигрирует, migration/discovery не decrypt store.

Sessions v2→v3 lazy providerId/profileId/model; unknown provider history/summary доступны, новый request controlled blocked. Нет mass rewrite. Index v1→v2 rebuild cache, project registry/metadata v1 сохранены. Save/checkpoint/rename переписывает один файл; отдельный session backup не создаётся.

--provider остаётся supported compatibility flag: 0 profiles → setup error, 1 → выбрать, несколько → --profile. Внутренние constructors, URL helpers, ProviderKind/Schema open-string aliases, legacy non-enumerable config accessors и session.provider deprecated и сохраняются. Persistent enum отсутствует. Env-only live eval использует isolated trial config; пользовательский config/credentials не меняются.

## Custom providers и безопасность

Home/providers пуст по умолчанию. Immediate child provider.json, namespace, size 256 KiB, schemaVersion 1, HTTP(S) endpoints/env format/options validation. Secret fields рекурсивно запрещены. Package/manifest/root symlinks и junctions отклоняются. Duplicate custom IDs отключаются все, built-in override невозможен. Diagnostics не печатают raw JSON/secrets и санитизируют terminal controls. Discovery не получает credentials, не создаёт SDK clients, не использует network и не исполняет JS. SDK defaults не направляют custom request к чужому endpoint: HTTP drivers требуют effective URL.

Проверены все пять legacy configs, apiKeyRefs, unknown fields, idempotence, два independent profiles, default model при provider switch, v2/v3 sessions/unknown providers/index rebuild, bad/duplicate/removed manifests, secret fields/symlinks/size/schema/options, 500 definitions и 500 manifests, реальный UI search/window/profile selector. Acceptance integration: myorg/gateway manifest → catalog → profile → CLI request через openai-chat без rebuild или provider-specific branch. AgentRouter generic-driver retry также проходит.

## Оставшиеся provider-specific места

В generic CLI/UI/core/config/sessions/app/runtime **нет branches по конкретному provider ID**, что проверяет static architecture test. SDK imports — только drivers/openai-chat.ts и drivers/anthropic-messages.ts.

- Definitions содержат service-specific metadata/defaults/env/options/pricing — это source of truth.
- Drivers ветвятся по protocol options и SDK errors (includeUsage/tokenLimitFallback/authMode/adaptiveThinking/nativeTokenCounting), без if(providerId===agentrouter).
- Compatibility wrappers providers/openai.ts, anthropic.ts, agentrouter.ts сохраняют старые names/kind union constructors и выбирают definition по metadata/driverId. Новый provider не требует их изменения.
- Legacy migrations ветвятся по schemaVersion/missing fields, а не по названиям providers.

## Документация

README: profiles/custom manifests, example --profile, links; rg fallback вместо устаревшего mandatory rg.

architecture: Profile→Definition→Driver→Adapter→Runtime diagram, Catalog/Registries/credentials dependencies, boundaries/invariants/trust, persistence and deprecated API.

providers: built-in metadata table с regression check against definitions, protocols/options/env/URLs/models/capabilities/health/pricing, multiple profiles, how to add provider/driver.

configuration: config v2 example, profile fields, Home/providers table, lazy migration/backups/forward compatibility. CLI: --profile/compatibility --provider, setup/doctor/model/resume, providers commands, optional costEstimate.

sessions: v3 identities, lazy migration/index rebuild/unknown history. security: manifests as data, secrets/symlinks/network/JS restrictions, HTTP/future trusted code.

Новые custom-providers.md и provider-migration.md — полные официальные guides с валидируемыми JSON examples, diagnostics/options/limitations/backup and credential behavior. docs/README links обновлены. getting-started/interactive/opentui-compatibility/troubleshooting/development актуализированы. CHANGELOG 0.6.1 добавлен. Release workflow example tag обновлён.

## Документы, намеренно не изменённые

- docs/installation.md: installer formats, OS paths и removal/update flow не изменились; ссылки ведут на latest release.
- docs/skills.md: skill contracts/storage/commands сохранены; ссылки на актуальный configuration корректны.
- docs/file-edit-ux.md: structured FileDiff, approvals/undo/editing behavior сохранены.
- docs/opentui-terminal-matrix.md: manual terminal verification procedure и probes не менялись.
- CONTRIBUTING.md и SECURITY.md: developer commands и vulnerability reporting не менялись.
- Исторические CHANGELOG sections и eval baselines: описывают прошлые версии, не переписываются как текущая документация.

## Известные ограничения

Custom drivers только bundled; executable extensions/marketplace/watcher вне scope. Catalog reload требует restart. Unsupported health — не failure; listing/counting optional. Неизвестные model windows/pricing не угадываются. Known Anthropic rates ориентировочные, не billing и не полная cache-cost модель. Live-service/model quality не подтверждена offline тестами. Windows/macOS/Linux release validation дополнительно выполняется в CI.

## Изменённые файлы

- `.github/workflows/release.yml`
- `CHANGELOG.md`
- `README.md`
- `docs/README.md`
- `docs/architecture.md`
- `docs/cli.md`
- `docs/configuration.md`
- `docs/custom-providers.md`
- `docs/development.md`
- `docs/getting-started.md`
- `docs/interactive.md`
- `docs/opentui-compatibility.md`
- `docs/provider-migration.md`
- `docs/provider-refactor-report.md`
- `docs/providers.md`
- `docs/security.md`
- `docs/sessions.md`
- `docs/troubleshooting.md`
- `evals/baselines/providers-v061-comparison.json`
- `evals/baselines/providers-v061-mock-summary.json`
- `evals/harness.ts`
- `evals/provider-profile.ts`
- `evals/runner.ts`
- `evals/trial.ts`
- `package-lock.json`
- `package.json`
- `src/app/run-prompt.ts`
- `src/cli.ts`
- `src/config/load.ts`
- `src/config/migrate.ts`
- `src/config/schema.ts`
- `src/core/context-usage.ts`
- `src/paths/home.ts`
- `src/providers/agentrouter.ts`
- `src/providers/anthropic.ts`
- `src/providers/auth.ts`
- `src/providers/base-url.ts`
- `src/providers/catalog.ts`
- `src/providers/contracts.ts`
- `src/providers/cost.ts`
- `src/providers/custom/diagnostics.ts`
- `src/providers/custom/discover.ts`
- `src/providers/custom/load.ts`
- `src/providers/custom/schema.ts`
- `src/providers/definitions/agentrouter.ts`
- `src/providers/definitions/anthropic-compatible.ts`
- `src/providers/definitions/anthropic.ts`
- `src/providers/definitions/index.ts`
- `src/providers/definitions/openai-compatible.ts`
- `src/providers/definitions/openai.ts`
- `src/providers/drivers/anthropic-messages.ts`
- `src/providers/drivers/index.ts`
- `src/providers/drivers/openai-chat.ts`
- `src/providers/endpoint.ts`
- `src/providers/errors.ts`
- `src/providers/openai.ts`
- `src/providers/profiles.ts`
- `src/providers/registry.ts`
- `src/providers/runtime.ts`
- `src/sessions/checkpoints.ts`
- `src/sessions/migrate.ts`
- `src/sessions/project-store.ts`
- `src/sessions/schema.ts`
- `src/sessions/store.ts`
- `src/types/domain.ts`
- `src/ui/context-sidebar.tsx`
- `src/ui/one-shot.ts`
- `src/ui/opentui-agent.tsx`
- `src/ui/opentui-sessions.tsx`
- `src/ui/opentui-settings.tsx`
- `src/ui/provider-settings.ts`
- `src/ui/session-filter.ts`
- `src/ui/settings-values.ts`
- `src/ui/setup-values.ts`
- `src/ui/tui-controller.ts`
- `src/version.ts`
- `tests/fixtures/tui-agent-navigation.ts`
- `tests/integration/agent-loop.test.ts`
- `tests/unit/context-usage.test.ts`
- `tests/unit/custom-providers.test.ts`
- `tests/unit/eval-provider-profile.test.ts`
- `tests/unit/opentui-sessions.test.tsx`
- `tests/unit/opentui-settings.test.tsx`
- `tests/unit/provider-architecture.test.ts`
- `tests/unit/provider-capabilities.test.ts`
- `tests/unit/provider-cli.test.ts`
- `tests/unit/provider-config.test.ts`
- `tests/unit/provider-registry.test.ts`
- `tests/unit/provider-runtime.test.ts`
- `tests/unit/provider-sessions.test.ts`
- `tests/unit/provider-settings.test.ts`
- `tests/unit/runtime-v2.test.ts`
- `tests/unit/sessions.test.ts`
- `tests/unit/tools.test.ts`
