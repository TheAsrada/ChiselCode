# Manifest и содержимое

[Разработка расширений](README.md) · [Первый пакет](quickstart.md) · [Проверки](testing.md)

Единственное имя manifest — **`chisel-extension.json`**:

```json
{
  "schemaVersion": 1,
  "id": "author.feature",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.mjs",
  "displayName": "Название возможности",
  "description": "Краткое назначение",
  "chiselVersion": ">=0.6.25 <0.7.0",
  "platforms": ["linux", "darwin", "win32"]
}
```

Первые шесть полей обязательны, остальные опциональны. Unknown fields отклоняются. `id` — lowercase dotted namespace до 128 символов; `builtin.*` и `core.*` запрещены. Factory definition должна вернуть те же `id/version/apiVersion/entry`.

Опциональный `settings` с CLI 0.6.30 описывает общие поля формы. [Контракт параметров и SDK](settings.md). Для пакета с этой схемой задайте минимальную совместимую версию 0.6.30.

`chiselVersion` поддерживает точную `a.b.c`, `^a.b.c`, `~a.b.c` и до четырёх сравнений `>=`, `<=`, `>`, `<`, `=` через пробел. Альтернативы `||`, wildcard и remote resolution не поддерживаются. Будущие schema/API versions не исполняются.

Один готовый self-contained `.mjs` — entry. Node/Bun builtins доступны согласно модели доверия; сторонние dependencies bundled. Assets — regular files внутри пакета. Runtime TS/JSX и `.node` не входят в поддерживаемый формат. Ограничение arbitrary imports является контрактом пакета, а не OS sandbox для доверенного JS.

| Ограничение | Максимум |
| --- | --- |
| Manifest | 64 KiB |
| Entry | 8 MiB |
| Пакет | 64 MiB / 1024 regular files |
| Все каталоги и файлы | 2048, глубина 32 |
| Relative path | 512 символов |
| Display name / description | 120 / 2000 символов |
| External boot records | 32 |

Paths относительные: без drive/UNC/URL/absolute/`..`/NUL. Symlinks, junctions, hard links, special files и case collisions запрещены. Loader не выбирает entry по порядку файлов и не сканирует cwd/node_modules/repository.

Digest: SHA-256 начинается с UTF-8 `ChiselCode extension package v1` + NUL. Файлы упорядочены сравнением UTF-8 relative paths с `/`. Для каждого идут uint32 big-endian длины пути, uint64 big-endian размера bytes, UTF-8 путь и сами bytes. Manifest входит в digest; hash receipt хранится вне пакета. Пустые директории не являются regular files и не вносят bytes.

[Упаковка ZIP, версии и migration](package-management.md) · [Пользовательские операции](../extensions.md).
