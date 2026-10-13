# Внешний loader: реализация и проверки

[Материалы для участников](../README.md) · [Архитектура](../../architecture/external-extensions.md) · [SDK](../../extensions/README.md) · [Подключение](../../extensions.md)

База: `171905c1d16aa170cbc5a59f90b9d027a5334021`, package 0.6.24, OpenTUI 0.5.12, Zod 4.6.1. Работа прямо в main, без development branch/worktree/PR. Memory, installer/update/remove и Settings → Extensions не входят в этап. Реализовано и выпущено в [v0.6.25](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.25) 13.10.2026, 11:03 UTC. Tag/runtime source: `558a2b7061b9c5407b734d747509f62deaaa9019`. Последующие workflow/docs commits в main не меняют runtime тега; весь P3 не закрыт.

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

Финальный полный прогон: **1165 pass, 3 skips, 0 failures**, 1168 tests / 139 files, 10899 assertions, 194.41 s. Пропущены native OS clipboard и две Windows-only CMD/Python проверки; они не объявляются локально проверенными. Typecheck прошёл. Lint: **215 warnings, 25 infos, 0 errors**. Eval: **14/14**. Build, SDK declaration generation, installed и compiled standalone author/import/capability checks прошли; command packaging harness прошёл, включая installed/compiled native TUI старых и нового сценариев.

Полный npm tarball также установлен в отдельный temporary TypeScript project вне checkout, typecheck/build прошли без src imports. Это отдельный Linux proof; межплатформенная fixture использует public exports/declarations настоящего installed package.

Native captures: [docs/assets/external-extensions](../../assets/external-extensions/README.md), **88 TXT + 88 JSON + 88 PNG**, четыре темы × Unicode/ASCII, details 160×50/120×40/80×24/40×12/24×8, status/error/context/menu/approval/unavailable source/return draft. PNG экспортированы из настоящих captureSpans, вручную проверены все пять размеров, четыре темы, оба режима, error и approval. На малом экране при готовом списке второстепенные summary/attribution уступают место строкам; empty/unavailable сохраняет объяснение и readonly retry; «Назад» остаётся доступно.

## CI и Windows regression базы

Финальный release source `558a2b7061b9c5407b734d747509f62deaaa9019`: [CI 38378693802](https://github.com/TheAsrada/ChiselCode/actions/runs/38378693802), attempt 2 — **success, все шесть Quality / Real Auto LSP jobs Windows/macOS/Linux**. Повторился только macOS Real Auto LSP после retryable `WEB_TIMEOUT` при загрузке Lua backend; повтор прошёл весь catalog и Swift на том же SHA. Windows full suite: 1166 pass, 2 skips, 0 failures; `/btw` OpenAI 12.16 s и Anthropic 11.35 s, каждый с прежним deadline 30 s. Installed/compiled external import, SDK authoring, настоящее UI action/write, child/background/worktree и прежние regressions прошли на всех трёх ОС.

[Release 38385429803](https://github.com/TheAsrada/ChiselCode/actions/runs/38385429803) подтвердил source tests и собрал четыре установщика. Его новый SDK step отказал на `tar | grep -q` при `pipefail`: declarations присутствовали, но раннее закрытие pipe дало tar write error. Проверка в main исправлена на полный список в файл и exact lookup. [Recovery 38387484219](https://github.com/TheAsrada/ChiselCode/actions/runs/38387484219) — **success**: SDK построен из неизменного тега, установщики взяты из успешных jobs того же source, все пять assets проверены перед публикацией. Первое recovery creation с explicit target SHA получило HTTP 403; `--verify-tag` опубликовал существующий тег без изменения refs. Ordinary Release теперь тоже собирает указанный tag и проверяет его перед публикацией. Одноразовый recovery workflow удалён после успеха.

Публичный release `411580377`, draft=false, prerelease=false, опубликован 13.10.2026 в 11:03:10 UTC. Проверены uploaded state, ненулевые размеры и GitHub SHA-256:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `chiselcode-0.6.25.tgz` | 5729850 | `85302aae9f7b564715cd7fa41d08ba0e43a0e773cd509451a43380d60ae38c9d` |
| `ChiselCode-Setup-0.6.25.exe` | 38640746 | `c4b89476a71c4c6e4ff8837f601ed7085fb635dd856340e73f8b884ce7469211` |
| `ChiselCode-Setup-0.6.25-macos-arm64.pkg` | 33230996 | `29169f18a4202c72d12b90a973ea7bb0e399a0f1eb478fc52f5f4087283f8b7b` |
| `ChiselCode-Setup-0.6.25-macos-x64.pkg` | 35821122 | `aa48274b1d6db29a2cb3358442e6198961c34d5713c40b337408fe4e72c098e9` |
| `ChiselCode-Setup-0.6.25-linux-amd64.deb` | 36907280 | `441e1d308d0ec97dfe53b09e114a375713b846ae89ae0dbdb7819e29afefdcc6` |

Эти шесть green jobs относятся к source релиза, не автоматически к последующим документационным commits. Промежуточный [CI 38373757540](https://github.com/TheAsrada/ChiselCode/actions/runs/38373757540) имел пять успешных jobs; Windows завис на shell step и завершился cancelled без доступного лога. Причина того runner отказа не установлена; тот же runtime прошёл shell/child/background paths в новой матрице.

Прежний regression [docs HEAD CI 38302493372](https://github.com/TheAsrada/ChiselCode/actions/runs/38302493372), Windows job `114988541926`: installed child cancellation остановился на checkpoint. Релизный source 0.6.24 остаётся green. Точная причина прежнего прогона ретроспективно не установлена; acceptance assertions cancellation/cleanup сохранены.

На исходном HEAD воспроизведена contention race Session index: 20 readers при промежутке между atomic Session/index writes ставили 20 full repairs под один index lock (**expected 1, received 20**). Теперь одно in-flight repair разделяется между читателями, каждый получает отдельный clone. Checkpoints не пропускаются; пассивные storage lock diagnostics показывают queue/file lock/action/heartbeat/release. Этот barrier доказывает конкретную устранённую гонку, не автоматически причину старого Windows failure.

Новая матрица показала дополнительные реальные проблемы:

| Evidence | Исправление и сохранённая проверка |
| --- | --- |
| macOS `/var` → `/private/var`, Windows case-insensitive inherited Home env | Canonical ancestor identity inspector; package links всё ещё запрещены. Fixture использует canonical paths, удаляет env aliases и отключает Execa `extendEnv` merge |
| [Windows job 115168128949](https://github.com/TheAsrada/ChiselCode/actions/runs/38358891153/job/115168128949): `EPERM` atomic `index.json` rename при checkpoint второго child | Тот же rename повторяется только при Windows sharing errors, до 2 s, с lock ownership перед каждой попыткой. Destination не удаляется; real readers/checkpoints и fault barriers lease loss/permanent failure проверяют результат |
| [macOS job 115192934915](https://github.com/TheAsrada/ChiselCode/actions/runs/38366549450/job/115192934915): TERM-ignoring descendant ещё выходил после SIGKILL в момент single ps snapshot | Backend ждёт фактический group exit в прежнем total cleanup deadline 10 s, grace 2 s. Реальный group barrier не завершается при живой группе; missing/escaped proof остаётся false |
| [Windows retry 115207766399](https://github.com/TheAsrada/ChiselCode/actions/runs/38368615655/job/115207766399): short child batch с полным выводом и exit 0 попала в `cancelled` при child drain | После post-exit/EOF owned-tree proof Windows supervisor завершает fixed transport по его exit/pipe events. Повторный дорогой CIM scan этого handshake убран; pre-exit census не является доказательством cleanup. Drain/stop deadlines и terminal outcome assertions сохранены |

[CI 38375969128](https://github.com/TheAsrada/ChiselCode/actions/runs/38375969128), docs source `088b885ff2aa`, подтвердил Linux/macOS Quality, три Real Auto LSP и early Windows shell/child/background paths. Windows full suite имел один timeout: прежний `/btw` smoke объединял 14 последовательных source CLI startups и реальные retries в один 30-second case. В успешном Windows source `a6cb425` тот же case занимал 21.84 s; здесь suite занял 616.61 s и aggregate case вышел за 30 s. Проверка разделена по двум протоколам, deadline каждого остаётся 30 s, CLI timeout 20 s сохранён. Все семь outcome cases на protocol остаются; exact HTTP count усилен до 9 на protocol вместо aggregate lower bound. Live fixture progress показывает mode/start/end/HTTP count; production `/btw` и runtime limits не изменены. Installed/compiled fixture по умолчанию продолжает проверять оба протокола. Оба отдельных protocol cases прошли в финальном CI; installed/compiled fixture сохранила полную двухпротокольную матрицу.

[Промежуточный CI 38363373798](https://github.com/TheAsrada/ChiselCode/actions/runs/38363373798) source `a6cb42557e1a` прошёл все шесть jobs, но не подменяет результат финального source. Промежуточные failures/retries не объявляются green.

## Ограничения

Runtime — trusted in-process JS; cooperative signals не прерывают sync hang/process.exit и не дают OS/CPU isolation. Exact digest не подтверждает publisher. Snapshot rechecks не исключают все атаки пользователя с теми же filesystem правами. Непроверенные платформы не объявляются успешными по Linux. Hot reload/reconnect/module unload, arbitrary native modules, npm registry publication и весь P3 не заявляются выполненными.
