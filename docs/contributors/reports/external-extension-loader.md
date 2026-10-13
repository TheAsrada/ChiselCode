# Внешний loader: реализация и проверки

[Материалы для участников](../README.md) · [Архитектура](../../architecture/external-extensions.md) · [SDK](../../extensions/README.md) · [Подключение](../../extensions.md)

База: `171905c1d16aa170cbc5a59f90b9d027a5334021`, package 0.6.24, OpenTUI 0.5.12, Zod 4.6.1. Работа прямо в main, без development branch/worktree/PR. Memory, installer/update/remove и Settings → Extensions не входят в этап. Кандидат 0.6.25; релиз пока не опубликован. Финальный source/tag/CI фиксируются после acceptance.

## Поставляемый контракт

Публичный entrypoint `chiselcode/extension-sdk`: standalone declarations, tooling `API_VERSION`, типы `ExtensionFactory/HostSdk/ActivationContext/ToolDefinition/EffectPlan/ToolResult/Command/ModelPort/UiContribution/UiDetailsView/ServiceToken`. Runtime factory получает frozen `{sdk, manifest}`, возвращает `id/version/apiVersion/entry/activate`. Helpers `sdk.defineTool` и `sdk.createServiceToken` приходят от host. Внутренний barrel не стал публичным SDK.

Manifest `chisel-extension.json`, schema/API 1, один self-contained `.mjs`. Production bootstrap: `extensions path`, `inspect`, `status` (alias `list`), `approve --id --digest --enable|--disabled`; noninteractive trust требует `--ack-process-access`. Recovery `--no-external-extensions` доступен до import. Inspection/trust/status/help/version не выполняют пакет.

Exact receipt включает canonical location и SHA-256 всех regular paths/bytes, manifest и assets. Verified private snapshot импортируется по canonical URL без query bust. Обычный CLI/TUI использует async application composition. Optional external activation транзакционна; ошибки снимают собственные contributions, обязательные linked/builtin failures остаются strict. Закрытая queued загрузка без live demand не начинает import; закрытый workspace не остаётся active в metadata.

## Реальные сценарии

| Сценарий | Доказательство |
| --- | --- |
| Независимый автор | TypeScript вне checkout typechecks с declarations packed npm package, затем собирается в `.mjs`; нет src imports/runtime bare SDK dependency |
| Ordinary import | Подготовленные файлы размещены после build/compile, реальный Home registry/trust, top-level sentinel отсутствует до trust |
| File tools | Реальные read/write, malformed schema/forged plan/Plan/stale approval refusal, undo/checkpoint; execute context не содержит Session/sandbox/private grants |
| Model/commands | Side-query через controlled HTTP adapter, separate accounting; autocomplete/view не вызывает модель; modified package не вызывает fallback paid request |
| Native capabilities | SDK command port вызывает production worktree create/remove, background batch/read/status и coding child с настоящим файлом в owned копии; foreign task owner rejected |
| Lifetime/failure | Один module import при canonical root aliases, отдельный activate двух roots; partial rollback/cleanup failure, 10-second late activation, четыре admission slots и cancelled fifth import |
| Integrity | Altered asset, reserved/project-disabled identity, path/junction escape и snapshot mismatch не исполняют top-level код; Home ancestor alias не разрешает package links |
| TUI | Ordinary runOpenTuiAgent без injected definition: три slots, pages/details, Enter/Space, Ctrl+C isolation, ordinary approval/write, возврат draft и no model request |
| Distribution | Installed npm и compiled CLI выполняют внешний package; packaging harness проверяет native external TUI и прежние /btw/LSP/worktree/subagent/background сценарии |

Fixture/example не входят в defaultExtensions, npm files или установщики. Release workflow поставляет SDK declarations в `chiselcode-0.6.25.tgz` рядом с четырьмя installers; npm registry upload не выполняется.

## Локальные проверки Linux

Финальный полный прогон: **1157 pass, 3 skips, 0 failures**, 1160 tests / 137 files, 10680 assertions, 217.73 s. Пропущены native OS clipboard и две Windows-only CMD/Python проверки; они не объявляются локально проверенными. Typecheck прошёл. Lint: **211 warnings, 25 infos, 0 errors**. Eval: **14/14**. Build, SDK declaration generation, installed и compiled standalone author/import/capability checks прошли; финальный command packaging harness прошёл, включая installed/compiled native TUI старых и нового сценариев.

Native captures: [docs/assets/external-extensions](../../assets/external-extensions/README.md), **80 TXT + 80 JSON + 80 PNG**, четыре темы × Unicode/ASCII, details 160×50/120×40/80×24/40×12/24×8, status/error/context/menu/approval/return draft. PNG экспортированы из настоящих captureSpans, вручную проверены все пять размеров, четыре темы, оба режима, error и approval. На малом экране второстепенные summary/attribution уступают место строкам списка; «Назад» остаётся доступно.

## CI и Windows regression базы

Первый implementation source `bb57120835abacdffcfa863e00b4da0771a781e8`: [CI 38342209766](https://github.com/TheAsrada/ChiselCode/actions/runs/38342209766). Linux Quality и три Real Auto LSP jobs прошли; macOS/Windows Quality остановились в новой standalone SDK CLI fixture на пути Home. macOS использовал system alias `/var` → `/private/var`; inspector исправлен для canonical ancestor identity, links внутри package по-прежнему запрещены. Windows fixture удаляет case-insensitive inherited Home env aliases и сверяет `extensions path` с realpath подготовленной папки. Финальный межплатформенный результат пока ожидается.

Отдельный прежний regression: [docs HEAD CI 38302493372](https://github.com/TheAsrada/ChiselCode/actions/runs/38302493372), Windows job `114988541926`, failed installed subagent cancellation на checkpoint. Релизный source 0.6.24 остаётся green.

Воспроизведена contention race Session index: 20 list-readers при промежутке между atomic Session/index writes ставили 20 full repairs под один index lock. Теперь одно in-flight repair разделяется между читателями, каждый получает отдельный clone; checkpoints не пропускаются. Реальный barrier regression: на исходном HEAD **expected 1, received 20**, на исправлении проходит. Storage lock diagnostics пассивно показывают local queue/file lock/action/heartbeat/release, assertion terminal cleanup сохранён, timeout не увеличен. Этот тест доказывает устранённую гонку, а не ретроспективно точную причину старого Windows failure. В первом новом CI early/installed/compiled Windows child cancellation прошли; требуется итоговый CI с исправлением.

## Ограничения

Runtime — trusted in-process JS; cooperative signals не прерывают sync hang/process.exit и не дают OS/CPU isolation. Exact digest не подтверждает publisher. Snapshot rechecks не исключают все атаки пользователя с теми же filesystem правами. Непроверенные платформы не объявляются успешными по Linux. Hot reload/reconnect/module unload, arbitrary native modules, npm registry publication и весь P3 не заявляются выполненными.
