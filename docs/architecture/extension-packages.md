# Управление пакетами расширений

[Архитектура](../architecture.md) · [Loader/SDK](external-extensions.md) · [Контракт автора](../extensions/package-management.md) · [Отчёт](../contributors/reports/extension-packages.md)

PackageManagementService — общий core service для production CLI и будущего Settings consumer. Loader сохраняет Home-only inspectPackage; новый source reader захватывает явно выбранную external directory/ZIP в private staging. Manifest и digest вычисляет прежний inspector, без второго алгоритма и import.

## Контракты

prepareInstall(source, options) / prepareUpdate(id, source, options) возвращают frozen PreparedPackage.preview. Commit authority — private WeakMap identity этого service instance, не operationId/JSON preview. commitCandidate(handle, {digest, acknowledgeProcessAccess, enabled, signal}) принимает captured bytes, exact trust acknowledgement и expected prior. abortCandidate освобождает только собственный staging до publication.

list/status, setEnabled(id, enabled, {digest, revision}), rollback(id, versionKey, expected, options), remove(id, expected) и recover используют immutable display/outcome DTO. inspectSource создаёт bounded capture без commit authority. Caller не выбирает destination/PID/kill/Session. Effects tools остаются в SDK/executor; installer не получает модель или approved EffectPlan.

## Транзакции и storage

Prepare создаёт durable preparing journal и атомарную reservation до capture. Ready фиксирует exact candidate, prior per-id revision/selected/enabled и expiration 30 минут. Copy/extract/confirmation идут без registry lock. Budget capture/verify — 60 секунд.

Commit под свежим registry lock перепроверяет capability, expiry, CAS и staging digest. Publishing journal записывается до same-filesystem rename. Полный ownership marker вне hashed tree связывает id/digest/operation/bytes/files. Existing destination не перезаписывается; он должен совпасть и иметь проверяемую ownership.

Registry schema 2 atomically сохраняет selected version, exact trust/enabled, per-id/global revision и bounded commit receipt. Receipt доказывает commit после crash даже если следующий update уже заменил selection. Затем journal становится committed, staging удаляется и reservation освобождается. Post-commit cancellation/error не превращает установку в отказ: outcome committed + deferred/warning.

Recovery различает committed receipts, abandoned pre-commit candidates и unknown outcomes. Оно убирает только owned staging и подтверждённо unreferenced owned publication. Tombstone remove блокирует новый import до physical GC; crash cleanup восстанавливается из сохранённых versions/markers. Legacy/future/unknown data не удаляются для quota.

Единый порядок locks: **registry lock → operation/version/runtime/use metadata**, без обратного захвата. Mutation и lease admission используют тот же withExtensionRegistry. Ownership recheck перед atomic replace/rename/delete — существующий assertOwned; Windows atomic metadata replace сохраняет destination и использует finite retry. Долгие copy/extract/user confirmation/import/activation не удерживают lock.

## Leases и restart

До snapshot/import loader atomically сравнивает frozen boot tuple с текущей committed desired identity и создаёт version use lease. Lease принадлежит application instance, а не view/workspace. Private composition provenance привязывает loader disposal к ExtensionHost; внешний DTO не может добавить application resource.

Lease удерживает installed/runtime bytes, в том числе после закрытия последнего root. Подтверждённый host shutdown отмечает shutdown_pending_exit; import/cleanup failure сохраняет recovery use. Imported module cache/raw effects не изображаются выгруженными пока OS process жив. Native birth identity (Linux boot/start ticks, Windows creation time, macOS process start) отличает PID reuse. Фактическая смерть без graceful shutdown остаётся unknown; PID/liveness alone не снимают recovery fence.

Manager GC под тем же lock исключает live/unknown use и selected/recovery versions, проверяет full digest и core sidecar ownership. Runtime marker появляется только для snapshot, созданного новым loader; unowned P3.1 caches автоматически не стираются. No arbitrary PID kill/reconnect, no query cache-busting/hot unload.

## Limits, races и темы

Budget managed packages/runtime/staging — 1 GiB. Capture резервирует до 128 MiB (ZIP + expanded bytes), snapshot — transient copy reservation; actual unknown bytes учитываются. Пакет 64 MiB/1024 files, archive ≤64 MiB/2048 entries. Metadata bounded: registry ≤2 MiB, journals ≤1024 по ≤32 KiB, use records ≤1024 по ≤8 KiB. Protected versions не вытесняются; невозможная admission возвращает quota error, сохраняя prior.

Different-id writers сохраняют чужие records; same-id stale candidate conflict-ит. Remove не удаляет чужие paths, conversations/artifacts/worktrees/results или config. Theme catalog остаётся у approved loaded version до restart; новая selection после startup публикует themes после successful seal. Desired ui.theme и ui.accent installer не меняет.

Trusted JS остаётся in-process: private snapshots/checks/guardrails уменьшают ошибки и races, но не являются защитой от намеренной concurrent modification того же user filesystem или arbitrary raw effects.
