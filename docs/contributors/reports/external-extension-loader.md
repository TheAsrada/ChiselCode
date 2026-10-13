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
| Native capabilities | Собственный SDK process tool исполняет approved command один раз и отклоняется в Plan; SDK command port вызывает production worktree create/remove, background batch/read/status и coding child с настоящим файлом в owned копии; foreign task owner rejected |
| Lifetime/failure | Один module import при canonical root aliases, отдельный activate двух roots; partial rollback/cleanup failure, 10-second late activation, четыре admission slots и cancelled fifth import |
| Integrity | Altered asset, reserved/project-disabled identity, path/junction escape и snapshot mismatch не исполняют top-level код; Home ancestor alias не разрешает package links |
| TUI | Ordinary runOpenTuiAgent без injected definition: три slots, pages/details, Enter/Space, Ctrl+C isolation, ordinary approval/write, возврат draft и no model request |
| Distribution | Installed npm и compiled CLI выполняют внешний package; separate-process raw `process.exit(23)` после trust и recovery flag проверены без выполнения кода в test runner; packaging harness проверяет native external TUI и прежние /btw/LSP/worktree/subagent/background сценарии |

Fixture/example не входят в defaultExtensions, npm files или установщики. Release workflow поставляет SDK declarations в `chiselcode-0.6.25.tgz` рядом с четырьмя installers; npm registry upload не выполняется.

## Локальные проверки Linux

Финальный полный прогон: **1164 pass, 3 skips, 0 failures**, 1167 tests / 139 files, 10898 assertions, 218.55 s. Пропущены native OS clipboard и две Windows-only CMD/Python проверки; они не объявляются локально проверенными. Typecheck прошёл. Lint: **215 warnings, 25 infos, 0 errors**. Eval: **14/14**. Build, SDK declaration generation, installed и compiled standalone author/import/capability checks прошли; command packaging harness прошёл, включая installed/compiled native TUI старых и нового сценариев.

Полный npm tarball также установлен в отдельный temporary TypeScript project вне checkout, typecheck/build прошли без src imports. Это отдельный Linux proof; межплатформенная fixture использует public exports/declarations настоящего installed package.

Native captures: [docs/assets/external-extensions](../../assets/external-extensions/README.md), **88 TXT + 88 JSON + 88 PNG**, четыре темы × Unicode/ASCII, details 160×50/120×40/80×24/40×12/24×8, status/error/context/menu/approval/unavailable source/return draft. PNG экспортированы из настоящих captureSpans, вручную проверены все пять размеров, четыре темы, оба режима, error и approval. На малом экране при готовом списке второстепенные summary/attribution уступают место строкам; empty/unavailable сохраняет объяснение и readonly retry; «Назад» остаётся доступно.

## CI и Windows regression базы

Runtime source `0e4dbb84e923225c0b8465fca3e828f5f2b39e8b`: [CI 38373757540](https://github.com/TheAsrada/ChiselCode/actions/runs/38373757540). Linux/macOS Quality и три Real Auto LSP jobs успешны; Windows Quality ещё выполняется на shell step, его результат не подтверждён. Итоговый source/CI/Release будут записаны после фактического acceptance и публикации.

Прежний regression [docs HEAD CI 38302493372](https://github.com/TheAsrada/ChiselCode/actions/runs/38302493372), Windows job `114988541926`: installed child cancellation остановился на checkpoint. Релизный source 0.6.24 остаётся green. Точная причина прежнего прогона ретроспективно не установлена; acceptance assertions cancellation/cleanup сохранены.

На исходном HEAD воспроизведена contention race Session index: 20 readers при промежутке между atomic Session/index writes ставили 20 full repairs под один index lock (**expected 1, received 20**). Теперь одно in-flight repair разделяется между читателями, каждый получает отдельный clone. Checkpoints не пропускаются; пассивные storage lock diagnostics показывают queue/file lock/action/heartbeat/release. Этот barrier доказывает конкретную устранённую гонку, не автоматически причину старого Windows failure.

Новая матрица показала дополнительные реальные проблемы:

| Evidence | Исправление и сохранённая проверка |
| --- | --- |
| macOS `/var` → `/private/var`, Windows case-insensitive inherited Home env | Canonical ancestor identity inspector; package links всё ещё запрещены. Fixture использует canonical paths, удаляет env aliases и отключает Execa `extendEnv` merge |
| [Windows job 115168128949](https://github.com/TheAsrada/ChiselCode/actions/runs/38358891153/job/115168128949): `EPERM` atomic `index.json` rename при checkpoint второго child | Тот же rename повторяется только при Windows sharing errors, до 2 s, с lock ownership перед каждой попыткой. Destination не удаляется; real readers/checkpoints и fault barriers lease loss/permanent failure проверяют результат |
| [macOS job 115192934915](https://github.com/TheAsrada/ChiselCode/actions/runs/38366549450/job/115192934915): TERM-ignoring descendant ещё выходил после SIGKILL в момент single ps snapshot | Backend ждёт фактический group exit в прежнем total cleanup deadline 10 s, grace 2 s. Реальный group barrier не завершается при живой группе; missing/escaped proof остаётся false |
| [Windows retry 115207766399](https://github.com/TheAsrada/ChiselCode/actions/runs/38368615655/job/115207766399): short child batch с полным выводом и exit 0 попала в `cancelled` при child drain | После post-exit/EOF owned-tree proof Windows supervisor завершает fixed transport по его exit/pipe events. Повторный дорогой CIM scan этого handshake убран; pre-exit census не является доказательством cleanup. Drain/stop deadlines и terminal outcome assertions сохранены |

[Промежуточный CI 38363373798](https://github.com/TheAsrada/ChiselCode/actions/runs/38363373798) source `a6cb42557e1a` прошёл все шесть jobs, но не подменяет результат финального source. Промежуточные failures/retries не объявляются green.

## Ограничения

Runtime — trusted in-process JS; cooperative signals не прерывают sync hang/process.exit и не дают OS/CPU isolation. Exact digest не подтверждает publisher. Snapshot rechecks не исключают все атаки пользователя с теми же filesystem правами. Непроверенные платформы не объявляются успешными по Linux. Hot reload/reconnect/module unload, arbitrary native modules, npm registry publication и весь P3 не заявляются выполненными.
