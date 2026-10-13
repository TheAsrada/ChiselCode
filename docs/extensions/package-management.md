# Пакеты, версии и локальные источники

[Разработка расширений](README.md) · [Формат manifest](package.md) · [Пользовательские команды](../extensions.md) · [Транзакции и leases](../architecture/extension-packages.md)

Собирайте пакет вне исходников приложения с packed SDK declarations. Runtime получает injected SDK v1; managed layout не требует bare import chiselcode рядом с package. Базовый API требует 0.6.25+, optional themes — 0.6.26+. Для последующих additions используйте актуальные declarations и подходящий chiselVersion.

## Подготовка папки и ZIP

В root находятся chisel-extension.json, self-contained index.mjs и assets. Не включайте enclosing package/ в архив, node_modules, install scripts или соседний source checkout. Runtime dependencies bundled. Для обычной папки достаточно передать её путь в extensions install.

Пример author-side ZIP generation через pinned fflate API; этот script не выполняется установщиком:

```js
import {zipSync} from "fflate";
import {readFile, writeFile} from "node:fs/promises";
const files = {};
for (const name of ["chisel-extension.json", "index.mjs", "assets/example.txt"])
  files[name] = new Uint8Array(await readFile(`package/${name}`));
await writeFile("extension.zip", zipSync(files, {level: 6}));
```

Reader ChiselCode использует bounded streaming inflate, проверяет central/local metadata, CRC и фактический output. Поддерживаются STORE/DEFLATE, UTF-8 либо ASCII filenames; encryption, ZIP64, ambiguous encoding, links/special files, duplicates/case collisions, ADS/absolute/drive/UNC/traversal запрещены. Modes/ACL/owner не применяются.

| Ограничение | Максимум |
| --- | --- |
| Compressed ZIP / expanded package | 64 MiB каждый |
| Manifest / entry | 64 KiB / 8 MiB |
| Regular files / все entries | 1024 / 2048 |
| Path / глубина | 512 символов / 32 |
| Capture/extract/verify | 60 секунд, cooperative cancellation |
| Managed packages/runtime/staging | 1 GiB с reservation |
| Неиспользуемые предыдущие версии | 4 на id; protected versions не вытесняются |

ZIP упаковка не входит в digest: одинаковые relative files дают прежний [package digest](package.md), независимо от compression level. Source можно удалить после captured commit. Installer не читает его повторно для исполнения.

## Managed ownership и доверие

Canonical Home/extensions содержит packages/&lt;id&gt;/&lt;digest&gt;, .staging/&lt;operationId&gt; и .runtime/&lt;digest&gt;. Version metadata/ownership markers/journals/use records находятся отдельно в .management, вне hashed tree. Directory names назначает core; displayName/version не являются destination path.

Install без trust создаёт disabled/untrusted selection без approvedAt. Trust относится к final installed location и exact tuple. Update не переносит source receipt и не выбирает новый digest без подтверждения. Enable не создаёт новый receipt. Rollback перепроверяет сохранённый location/digest/receipt; при утрате trust нужно новое exact acknowledgement.

Imported module принадлежит frozen application boot identity. Update/disable/remove не hot-replace-ят его, themes или actions. Следующий startup использует новую committed selection. Удаление active/unknown bytes deferred; trusted raw timers/processes не считаются выгруженными.

## Миграция и ошибки

Registry schema 1 читается без выдачи нового trust и без изменения manual location. Первая успешная mutation atomically сохраняет schema 2. Legacy directories не становятся managed и не удаляются. Для явного переноса в store используйте candidate/update с подтверждением final identity.

Stale revision/current digest даёт conflict и новое preview. Unknown/future schema не reset-ится. Publication без registry commit не выбирает пакет; commit с cleanup error остаётся committed с warning/deferred. Recover не import-ит JS и не переподтверждает доверие.

CLI --json содержит operationId/outcome, digest, enabled/trusted, location, restartRequired, retainedBytes/deferred и warning. Invalid/denied/conflict/error дают exit 1. Committed с cleanup warning даёт exit 0: данные уже применены, cleanup отдельно. Status пассивен; uses описывает application version lease, а не workspace activation.

Связанные темы: [author typecheck и tests](testing.md), [tools/permissions](tools-commands.md), [темы](themes.md), [report](../contributors/reports/extension-packages.md).
