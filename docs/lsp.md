# Анализ кода (LSP)

[Документация](README.md) · [Конфигурация проекта](configuration.md) · [Решение проблем](troubleshooting.md#тайм-аут-подготовки-lsp)

> Руководство описывает текущие исходники (`main`), включая новый способ включения LSP. Для CLI 0.6.55, где по умолчанию действует Auto, используйте [справку выпущенной версии](https://github.com/TheAsrada/ChiselCode/blob/v0.6.55/docs/configuration.md#анализ-кода-lsp). Выполните `chisel --version`, чтобы узнать свою версию.

## Включить анализ

1. На чистом запуске LSP выключен. Откройте `/settings` → **Расширения** → **Анализ кода (LSP)** и выберите **Включить**.
2. Откройте **Настройки → Инструменты → Анализ кода · LSP**. При включённом анализе меню также доступно из панели и из списка состояний по F9.
3. Выберите **Все проекты** или **Этот проект**. Без открытой папки доступны **Все проекты** и действие **Выбрать проект**. **Стратегия** определяет, будет ли ChiselCode выбирать сервер автоматически (**Auto**) или использовать **Свою настройку**.

Включение без сохранённой стратегии выбирает Auto. ChiselCode готовит и запускает сервер при первом запросе диагностики или навигации. Просмотр меню, поиск и сохранение параметров сами по себе серверы не запускают.

При общем выключении ChiselCode закрывает серверы, убирает раздел из навигации и поиска Settings и исключает инструменты LSP из новых запросов к модели. Карточка в **Расширениях** остаётся доступна для повторного включения. Стратегия, пути, аргументы и доверие сохраняются. Если LSP разрешён глобально и выключен только в текущем проекте, **Включить** в карточке возвращает наследование.

В глобальной конфигурации переключатель записывает `lsp.enabled`. Без секции `lsp` или сохранённого выбора действует Off. Прежний `mode: "off"` по-прежнему выключает анализ. Если `enabled` отсутствует, сохранённые `mode: "auto"`, `mode: "custom"` и старые записи с непустым `servers` продолжают действовать. Минимальная запись для включения — `"lsp": { "enabled": true }`. При включении из старого режима Off выбирается Custom при наличии ручных записей, иначе Auto.

## Выбрать сервер и посмотреть диагностику

- Сначала показаны использованные серверы, ручные записи и исключения. **Все поддерживаемые серверы** раскрывает каталог. **Ctrl+F** в содержимом LSP ищет по названию и языку. Для поиска по всем Settings переключите фокус в навигацию через Shift+Tab и нажмите Ctrl+F.
- Стрелки выбирают строку, Enter открывает карточку или действие, Space меняет разрешение сервера. PgUp/PgDn листают список, Tab и Shift+Tab меняют область фокуса, Esc возвращает на предыдущий уровень.
- В карточке видны состояния по корням проекта. **Ждёт запроса** означает, что сервер разрешён, а **Работает** означает, что процесс запущен. **Запустить сейчас** и **Перезапустить** используют очередь инструментов и разрешения Build. Модель и API-ключ для них не нужны. В Plan доступна автоматическая навигация в режиме чтения. Перезапуск и выключение сервера затрагивают его экземпляры во всех вкладках проекта.
- Диагностика показывает файл, строку, колонку и свежесть результата. Координаты отображаются с единицы, колонка соответствует UTF-16 LSP. Статусы `current`, `observed`, `pending`, `stale` и `unavailable` различают подтверждённый, наблюдаемый, ожидаемый, устаревший и недоступный результат. Только пустой подтверждённый результат показывает отсутствие ошибок. TypeScript присылает результаты без версии документа, поэтому они остаются `observed`.

LSP анализирует отслеживаемые документы. Для проверки изменений также запускайте подходящие тесты или компилятор. Переименование, форматирование, code actions и workspace edits через LSP недоступны. Пользовательские команды `/lsp-status` и `/lsp-restart` заменены меню.

## Сохранение настроек

Переключатели сохраняются сразу. Валидные изменения ручной формы сохраняются автоматически после короткой задержки. При выходе из формы ChiselCode завершает запись. Если запись не удалась, ввод остаётся в форме. После конфликта выберите **Обновить данные** и проверьте сохранённый ввод перед повторной записью.

Если Off записан, а завершение сервера не подтверждено, новые запросы запрещены. В меню доступно действие **Повторить завершение процессов**. Изменение параметров запуска может показать **Нужен перезапуск**. Следующий явный запуск использует новые параметры.

## Серверы Auto

Auto выбирает язык по имени файла и ближайший разрешённый корень проекта по маркерам. Сервер и SDK должны находиться вне анализируемого проекта. Если выбранная папка включает служебные данные ChiselCode, откройте нужный каталог через `/cwd <путь>` или `chisel --cwd <путь>`.

| Языки | Auto backend | Условия |
| --- | --- | --- |
| TypeScript/JavaScript, TSX/JSX, MTS/CTS/MJS/CJS | TLS 6.0.1 + TS 6.0.3 | Встроены в npm package/binary; собственный Bun |
| Python | Pyright 1.1.414 | Node 24.19.0 готовится автоматически |
| Go | gopls 0.23.0 | Go 1.27.1 готовится; project dependencies не скачиваются |
| Rust | rust-analyzer 2026-10-05 | Rust 1.99.0 готовится; native experimental diagnostics включены; build scripts/proc macros/check-on-save и скачивание crates выключены |
| C/C++, Objective-C/C++ | clangd 23.1.0 | compile_commands.json/compile_flags.txt для project flags; Linux ARM64 пакета нет |
| C# | OmniSharp 2.0.0 | .NET 10.0.401 готовится; NuGet restore/analyzers выключены; project dependencies должны быть доступны |
| Java | JDT LS 1.61.0 | Temurin JRE 21.0.12.1 готовится; Maven/Gradle import выключен |
| Kotlin | Kotlin Language Server 1.3.13 | Standalone tracked files без Gradle/Maven/classpath scripts; полный проект через custom LSP |
| PHP | Intelephense 1.18.5 | Бесплатные функции; premium features не обещаются |
| Ruby | Solargraph 0.61.0 | Установленный Ruby ≥3.2/RubyGems SDK с headers/build tools/libyaml; фиксированные gems готовятся вне проекта |
| Swift | SourceKit-LSP | Установленный Swift toolchain/Xcode обнаруживается вне проекта; без него unavailable |
| Lua | LuaLS 3.19.1 | Native пакет готовится автоматически; Windows ARM64 пакета нет |
| Dart | Dart 3.13.5 language server | SDK определяется либо готовится; версия найденного SDK не выдаётся за проверенную; Flutter требует Flutter SDK, pub get не запускается |
| HTML/CSS/SCSS/Less/JSON/JSONC | vscode-langservers-extracted 4.10.0 | Node готовится; remote JSON schemas выключены |
| YAML | yaml-language-server 1.24.0 | SchemaStore выключен |
| Shell/Bash | bash-language-server 5.8.1 | ShellCheck/shfmt/explainshell автоматически не выполняются |
| Dockerfile/Containerfile | dockerfile-language-server 0.15.0 | Node готовится |

Для встроенного TypeScript не нужны отдельный Node и сеть. Для других языков первый запрос может скачать закреплённый сервер или SDK. Подготовленные файлы хранятся в `chiselHomeDir()/lsp/servers` и проверяются перед запуском. При сбое загрузки проверьте сеть и повторите запрос. Список функций зависит от сервера и его настроек. Например, при начальной индексации Rust повторите диагностику после загрузки проекта, если сервер отклонил запрос. Подробнее о загрузке и проверках — в [архитектуре LSP](architecture/lsp.md).

## Подключить свой сервер

**Своя настройка** предназначена для опытных пользователей: сервер устанавливается отдельно, вне анализируемого репозитория, например:

```bash
npm install --prefix /absolute/user/lsp-runtime --ignore-scripts typescript-language-server@6.0.1 typescript@6.0.3
```

Для своей настройки поддерживается **typescript-language-server 6.0.1**, **TypeScript 6.x** (tests: **6.0.3**), **Node ≥22.22.2** (CI: **24.19.0**). Dev dependency TypeScript 7 и workspace `node_modules/typescript` не заменяют backend скрыто. Проверка путей проверяет metadata server/TypeScript, но не выполняет Node `--version`.

Global config сохраняет schemaVersion 2:

```json
{
  "lsp": {
    "mode": "custom",
    "servers": {
      "typescript": {
        "enabled": true,
        "backend": "typescript",
        "command": "/absolute/path/to/node",
        "args": ["/absolute/user/lsp-runtime/node_modules/typescript-language-server/lib/cli.mjs", "--stdio"],
        "typescriptPath": "/absolute/user/lsp-runtime/node_modules/typescript/lib/tsserver.js",
        "trustedWorkspaces": ["/canonical/project/root"]
      }
    }
  }
}
```

На Linux/macOS используйте реальный абсолютный путь `node` и установленные JS/TypeScript файлы; на Windows — например `C:\Program Files\nodejs\node.exe` и абсолютные пути `cli.mjs`/`tsserver.js` (в JSON обратный слеш экранируется). Friendly UI принимает пробелы и Windows drives без JSON escaping. Путь `typescriptPath` может указывать на `lib`; client разрешит `tsserver.js`. Реальные canonical пути runtime/server/TypeScript должны находиться вне target repository. Никакого PATH lookup из проекта, `.cmd`, shell, `npx`/`bunx`, install scripts, env overrides или произвольных initialization options. Допустимый дополнительный argv — одна пара `--log-level` и `1`–`4`; trace/file logging и ATA отключены, дополнительные plugins не включаются.

Для любого совместимого stdio сервера UI предлагает «Подключить совместимый LSP»: абсолютный executable, argv (одна строка = один аргумент), language IDs и дополнительные расширения. Advanced JSON options/settings ограничены 64 KiB каждый. Не выполняются shell expansion, произвольный LSP method или server-returned command. Пример ручного Python:

```json
{
  "lsp": {
    "mode": "custom",
    "servers": {
      "python": {
        "backend": "generic", "enabled": true,
        "command": "/absolute/user/node",
        "args": ["/absolute/user/pyright/langserver.index.js", "--stdio"],
        "languageIds": ["python"], "extensions": [".py", ".pyi"],
        "trustedWorkspaces": ["/absolute/project"],
        "settings": {"python": {"analysis": {"diagnosticMode": "openFilesOnly"}}}
      }
    }
  }
}
```

Для **пользовательских исполняемых файлов** доверие проверяется по точному canonical root, включая symlink aliases. Родитель, потомок, соседний project и wildcard доверие не наследуют. `enabled` без `trustedWorkspaces` не запускает custom сервер. Auto использует только стандартный проверенный payload, ему не нужно отдельное подтверждение каждого root. Оба backend анализируют imports/configs/dependencies с правами пользователя: это не sandbox и не enforced network isolation. Model/API credentials в environment сервера не передаются.

## Настройки проекта и наследование

Экран «Этот проект» позволяет наследовать global режим, выбрать Auto, custom сервер или выключить анализ. Project `.chiselrc` разрешает `mode`, выбор существующего global ID через `serverId`, `enabled` и индивидуальные `serverOverrides`:

```json
{ "lsp": { "mode": "custom", "serverId": "typescript" } }
```

При включённом анализе для всех проектов выберите Auto для отдельного проекта: `"lsp": { "mode": "auto" }`, для отключения только этого проекта: `"lsp": { "enabled": false }`; `{}` наследует общий выбор. Global Off имеет приоритет над любыми проектными разрешениями. При нескольких enabled/trusted custom записях без ID выводится ошибка неоднозначности. Выбор custom и индивидуальное разрешение не выдают доверие; проектные launch/trust/args/runtime/initializationOptions отклоняются.

Индивидуальное разрешение вычисляется в порядке **project `serverOverrides` → global `serverOverrides` → ручной `servers[id].enabled` или `true` для встроенного сервера**. Затем действуют общий Off, стратегия, язык и доверие. Например, выключить Python для всех проектов:

```json
{ "lsp": { "mode": "auto", "serverOverrides": { "auto-python": { "enabled": false } } } }
```

Разрешить его только в текущем `.chiselrc`:

```json
{ "lsp": { "serverOverrides": { "auto-python": { "enabled": true } } } }
```

Общий `enabled:false` блокирует и это исключение. Включение встроенного сервера в custom-стратегии не делает его применимым. Неизвестный ID остаётся видимым как недоступная запись; удалите его исключение или настройте ручной сервер с допустимым ID. Overrides принимают только `enabled:boolean`, до 128 записей с проверенными ID. `auto` и `auto-*` нельзя использовать как ручные executable-записи.

«Наследовать включение анализа» удаляет только project `enabled` и старый `mode:off`, сохраняя обычную стратегию, `serverId` и индивидуальные значения. «Наследовать значение сервера» удаляет только выбранное project исключение. Удаление ручной записи очищает её global override; проектные ссылки сохраняются как недоступные.
