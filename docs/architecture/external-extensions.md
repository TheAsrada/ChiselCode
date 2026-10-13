# External loader и SDK v1

[Архитектура](../architecture.md) · [Developer SDK](../extensions/README.md) · [User trust](../extensions.md) · [Отчёт](../contributors/reports/external-extension-loader.md)

`applicationExtensions` — async ordinary composition для CLI/TUI/slash/resume. Explicit `ExtensionHost([])`, borrowed scope/host и custom linked definitions не autoload-ят внешнее code. Builtins идут первыми. Frozen user registry snapshot находится в canonical Home/extensions, project policy только сужает его до import.

Pipeline: registry/enabled → project narrowing → manifest/paths/compatibility/conflicts → exact trust receipt → verified snapshot → canonical dynamic import → default factory с injected SDK → public adapter → optional activation transaction → seal → active metadata. Inspect/trust/status/help/version/doctor/recovery не проходят import path.

## Integrity и snapshot

Receipt связывает id/version/apiVersion/entry/location/digest и enabled. Atomic file writes + existing storage lock сохраняют чужие global settings: bootstrap registry отдельный. Все regular paths/bytes, включая manifest/assets, входят в deterministic digest [описанного формата](../extensions/package.md). Ссылки/junctions/case collisions и специальные файлы отклоняются.

Loader captures bounded bytes, проверяет digest against receipt, создаёт частный `.runtime/<digest>` snapshot и rechecks его после atomic publication. Import получает canonical file URL этих bytes без cache-busting query. Config/registry lock не удерживается при import/activation/tools. Это защита от случайной подмены и часть trusted user-filesystem contract, не абсолютный запрет concurrent hostile modification тем же OS user.

## Module и workspace lifetimes

Import/factory dedupe по approved canonical identity/digest в process lifetime, до четырёх concurrent loader операций; queued загрузка без живого workspace отменяется до import; import/factory/optional activation waits до 10 секунд. Failed promise не replay-ится на каждом prompt. Новый digest не hot-replace-ит definition живого host. Restart обязателен для code/trust/enabled changes.

Factory helpers принадлежат host SDK; tokens и plans определяются WeakMap identity, не diagnostic strings/JSON/instanceof из чужой копии. Activation создаёт новый workspace state. Canonical aliases reuse прежний scope; соседняя conversation не закрывает frame, пока root ещё используется.

Optional provenance приватная. Frame имеет собственный AbortController, registrations/resources; timeout/failure закрывает регистрацию, abort-ит signal, reverse cleanup снимает только его contributions. Cleanup продолжает остальные ресурсы после ошибки, ожидание optional frame ограничено 10 секундами, outcome честный. Закрытый workspace удаляется из active metadata; cleanup failure сохраняется отдельно. Builtin/explicit required linked failure по-прежнему откатывает scope. External DTO не может пометить builtin optional.

## Узкие adapters

Public barrel не экспортирует host/scopes/executor/controller/registry/credentials/private constructors. Generated SDK declarations не ссылаются на `../src`. Runtime entry лишь tooling API_VERSION; helpers injected, поэтому compiled executable не требует plugin-side bare SDK import.

Tool callback получает заново созданный объект. Prepare helpers используют native file/EditingService/shell planners под текущей preparation lease. Opaque EffectPlan захватывает native plan/root/session/invocation. Execute port не принимает новый path/command; эффект идёт через существующий approved execution context без второго nested acquire. Начатый effect drain-ится до lease release даже при ошибке callback.

Command tools идут обычным owner runtime и whitelist own/documented native/builtin operations. Model port invocation-bound, возвращает original core result по private identity для side-query accounting. Activation/UI/context/autocomplete capabilities отсутствуют. P2.5 own-tool UI actions сохраняют очередь, live revision, permissions/checkpoint и captured owner.

## Ошибки и дисплей

Safe bounded diagnostics разделяют loaded module и workspace active. Optional failures не запускают fallback model. TUI показывает один startup notice на package/root/controller, без раскрытия окна или изменения draft. Slot snapshots ephemeral, не новая память. Saved chat receipts читаются без runtime package; unavailable view не replay-ится.

Trusted code исполняется в процессе: raw fs/network/process вызовы возможны и не ограничиваются SDK permissions. Cooperative signal не прерывает sync hang и не откатывает module-level effects. Recovery bootstrap доступен до первого external import. Installer/update/remove и полноценные Settings — отдельные следующие этапы.
