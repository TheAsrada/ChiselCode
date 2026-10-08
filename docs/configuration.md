# Конфигурация проекта и данные

[Документация](README.md) · [Главная](../README.md)

## Правила проекта: `.chiselrc`

Создайте JSON-файл `.chiselrc` в корне выбранного проекта:

```json
{
  "allowedCommands": ["bun test", "bun run typecheck"],
  "deniedCommands": ["rm -rf", "git push --force"],
  "ignorePatterns": [".git/**", "node_modules/**", ".chisel/**", ".env", ".env.*"],
  "autoApprove": false
}
```

| Поле | По умолчанию | Значение |
| --- | --- | --- |
| `allowedCommands` | `[]` | Shell-команды, которые можно выполнять без вопроса |
| `deniedCommands` | `[]` | Shell-команды, которые отклоняются даже при `--yes` |
| `ignorePatterns` | `[".git/**", "node_modules/**", ".chisel/**"]` | Пути, исключённые из файловых инструментов |
| `autoApprove` | `false` | Совместимый default Accept edits для новой/legacy сессии без выбранного approvalMode; не включает Bypass |

Указанный `ignorePatterns` **заменяет** стандартный список. Поэтому в примере сохранены стандартные исключения и добавлены `.env`. Секреты не исключаются автоматически одним только наличием `.env` в проекте.

Shell allow rules сопоставляются с нормализованными аргументами простой команды. Операторы, redirection, substitutions и неизвестные expansions требуют отдельного approval, если пользователь явно не включил общее разрешение. Deny rules имеют приоритет. Это permission policy, а не системная песочница.

## Параметры Core Runtime v2

Явный `--approval default` и сохранённый Manual заменяют общий `autoApprove`; `--yes` выбирает Accept edits, если нет явного `--approval`. Bypass доступен только при `permissions.allowBypassPermissions: true` в пользовательском config; настройка управляется в Settings → Разрешения. Точечные `allowedCommands`/`--allow` и запреты сохраняются. [Приоритеты разрешений](permissions.md).

Необязательные настройки `.chiselrc`:

```json
{
  "context": {
    "autoCompact": true,
    "bufferRatio": 0.1,
    "keepRecentTokens": 16000,
    "maxInlineToolResultTokens": 10000
  },
  "tools": { "maxParallelReads": 4 },
  "editing": { "requireFreshRead": true }
}
```

Размер окна и максимальный ответ берутся из API выбранной модели; если API не сообщает лимиты, используется встроенный каталог точных ID моделей. Общего лимита ответа в 4096 токенов нет: runtime допускает максимум модели с учётом текущего запроса и buffer. Для неизвестной модели OpenAI лимит ответа не отправляется, его выбирает сервер.

Необязательные `context.contextWindow` и `context.maxOutputTokens` позволяют задать лимиты вручную. Первый ограничивает рабочий budget или задаёт неизвестное окно; второй ограничивает ответ. Они не увеличивают известные пределы модели. Для неизвестной модели Anthropic нужен `maxOutputTokens`, если API и каталог не сообщают его: протокол требует `max_tokens`. Панель отличает ручное окно от параметров API/каталога.

Большие tool outputs сохраняются как artifacts и доступны через `read_tool_result`. Отключение `requireFreshRead` снимает обязательность предварительного чтения, но не проверку уже наблюдавшейся revision или проверку между preflight и commit.

`autoCompact` по умолчанию включён. Перед исчерпанием рабочего budget выбранная модель составляет краткое резюме старой истории без вызова инструментов; текущий запрос и недавние сообщения сохраняются. При недоступности резюме используется извлечение наблюдаемых фактов. Новое резюме применяется только если освобождает место; полная история и карточки сжатия сохраняются в сессии. Вспомогательный запрос учитывается в расходе токенов. При `autoCompact: false` сжатие и повтор после переполнения отключены.

## MCP

Обычный способ настройки — `/mcp`: URL или команда, тест, обнаруженные tools и разрешения перед сохранением. Глобальный сервер хранится в пользовательском config v2; проектный — в `.chiselrc` и требует доверия. Оба используют вложенный `mcp.schemaVersion: 1`. Старые config без `mcp` продолжают работать и мигрируют прежним способом.

```json
{
  "mcp": {
    "schemaVersion": 1,
    "servers": {
      "github": {
        "enabled": true,
        "transport": { "type": "http", "url": "https://example.com/mcp" },
        "auth": { "token": { "envRef": "GITHUB_MCP_TOKEN" } },
        "permissions": {
          "categories": { "read": "allow", "write": "ask", "destructive": "ask", "unknown": "ask" },
          "tools": { "merge_pull_request": "deny" }
        },
        "pinnedTools": ["search_code"]
      },
      "database": {
        "transport": { "type": "stdio", "command": "node", "args": ["/opt/mcp/database-server.js"], "cwd": "/home/me/project" },
        "env": {
          "DATABASE_URL": { "secretRef": "mcp/database/url" },
          "API_TOKEN": { "envRef": "DATABASE_API_TOKEN" },
          "REGION": { "literal": "eu-west-1" }
        },
        "startupTimeoutMs": 15000,
        "callTimeoutMs": 120000
      }
    }
  }
}
```

Поля MCP строгие: неизвестные настройки отклоняются. До 64 серверов, до 64 env/header entries, до 32 закреплённых tools на сервер. HTTP headers используют те же `secretRef`/`envRef`/несекретный `literal`, что stdio env. Bearer token задаётся в `auth.token`. Credentials в URL, аргументах с secret flags и literal в чувствительных env/header полях запрещены. Таймаут запуска — 100–120000 мс, вызова — 100–600000 мс.

Отсутствующие permissions означают `ask`; мастер и CLI add предлагают read allow, остальные ask. Проектные allows не предоставляют пользовательские права. Невалидный сервер отключается и показывается в `/mcp`/`mcp doctor`; валидные серверы остаются доступными. Исправьте ошибки перед сохранением нового сервера: приложение не перезаписывает повреждённую конфигурацию исправленной частичной копией.

Доверие хранится рядом с пользовательским config в `mcp-trust.json`; секреты — в `credentials.enc`, независимо от `.chiselrc`. Рабочая папка stdio по умолчанию — корень выбранного проекта. [Подключение MCP и диагностика](mcp.md).

## Инструкции проекта

Корневые `CLAUDE.md`, `AGENTS.md` и `CHISEL.md` добавляются к инструкции агента; при конфликте `CHISEL.md` имеет приоритет. Например:

```markdown
# Правила проекта

- Отвечай по-русски.
- Перед изменением публичного API опиши план.
- Для проверки типов используй bun run typecheck.
- Не редактируй сгенерированные файлы.
```

Инструкции помогают выбрать способ работы, но не заменяют технические ограничения доступа.

## Где лежат настройки и данные

| Данные | Windows | macOS / Linux |
| --- | --- | --- |
| Настройки и зашифрованные ключи | `%APPDATA%\chiselcode` | `$XDG_CONFIG_HOME/chiselcode` или `~/.config/chiselcode` |
| ChiselCode Home | `%LOCALAPPDATA%\ChiselCode` | `$XDG_DATA_HOME/chiselcode` или `~/.local/share/chiselcode` |
| Пользовательские providers | `ChiselCode Home/providers/` | `ChiselCode Home/providers/` |
| Разговоры | `ChiselCode Home/sessions/` | `ChiselCode Home/sessions/` |
| Пользовательские навыки | `ChiselCode Home/skills/user/` | `ChiselCode Home/skills/user/` |
| Встроенные навыки | `ChiselCode Home/skills/bundled/` | `ChiselCode Home/skills/bundled/` |

В каталоге настроек находятся `config.json` и `credentials.enc`. Конфигурация содержит ссылки на ключи (`apiKeyRef`), а не их значения. Не путайте каталог настроек с каталогом данных. Таблица показывает обычное расположение при стандартных переменных окружения ОС.

## Параметры интерфейса

По умолчанию рамки и логотип используют совместимые ASCII-символы.
В `/settings` → «Оформление» переключатель «Графика» (`Ctrl+G` внутри раздела)
включает исходный логотип Coder Mini, округлые рамки и графический ползунок.
Настройка `ui.unicodeDecorations` сохраняется сразу, по умолчанию `false`.
Если вместо значков появляются квадраты, выключите «Графику» и используйте
моноширинный шрифт с поддержкой языка ваших сообщений.

| Переменная | Действие |
| --- | --- |
| `CHISEL_ALT_SCREEN=0` или `CHISEL_NO_ALT_SCREEN=1` | Режим split-footer с нативной историей терминала |

Например, `CHISEL_NO_ALT_SCREEN=1 chisel` в bash/zsh или `$env:CHISEL_NO_ALT_SCREEN = "1"; chisel` в PowerShell.

Переменные API-ключей перечислены в [справке провайдеров](providers.md). CLI-флаги провайдера и модели переопределяют выбор для запуска; при продолжении сессии без этих флагов сохраняются её провайдер и модель.

## Глобальный config v2 и profiles

```json
{
  "schemaVersion": 2,
  "defaultProfileId": "openai-work",
  "profiles": {
    "openai-work": {
      "providerId": "openai",
      "apiKeyRef": "openai-work",
      "defaultModel": "gpt-5"
    }
  }
}
```

Provider — сервис из каталога; profile — отдельный аккаунт/настройки этого сервиса. Несколько profiles имеют независимые apiKeyRef, baseUrl, defaultModel и optional label. defaultProfileId выбирает профиль запуска. apiKeyRef — имя записи в прежнем CredentialStore, не секрет. baseUrl переопределяет definition endpoint; defaultModel переопределяет definition model. Unknown provider profiles и unknown fields сохраняются.

Старый config читается и мигрирует в памяти: `openai` → `openai-default`. Глобальный defaultModel переносится только в выбранный default profile, если там нет собственного. Файл переписывается при настоящем сохранении настроек; перед первым v2 save создаётся config.v1.backup.json. credentials.enc не мигрирует и не расшифровывается при миграции config. Подробности: [migration notes](provider-migration.md).

## Home/providers

`ChiselCode Home/providers/` создаётся вместе с directories сессий и skills, остаётся пустым по умолчанию. Built-ins, credentials, cache, examples и README туда не копируются. Реальный абсолютный путь показывает `chisel providers path`. Каталог содержит только пользовательские `*/provider.json`.

Profile ID — 1–128 символов, буквы/цифры/точка/дефис/underscore, первый символ буква или цифра. Provider ID остаётся открытой строкой; для custom definition требуется namespace. Новые profiles создаются через setup --profile или /settings. config v2 сохраняет unknown fields для forward compatibility; недоступные providers не удаляются автоматически.

## Native Web

Настройте `/settings` → Web или `chisel web configure`. В user config v2 добавляется versioned `web`, старые config не требуют ручной миграции:

```json
{
  "web": {
    "schemaVersion": 1,
    "enabled": true,
    "search": { "provider": "auto" },
    "permissions": {
      "search": "allow", "fetch": "allow",
      "allowDomains": [],
      "denyDomains": ["*.internal.example.com"]
    },
    "cacheTtlMs": 300000,
    "limits": {
      "connectTimeoutMs": 8000, "requestTimeoutMs": 30000,
      "maxRedirects": 5, "maxResponseBytes": 2097152,
      "maxDecompressedBytes": 4194304, "maxExtractedChars": 100000,
      "maxConcurrent": 3, "maxRequestsPerTurn": 24
    }
  }
}
```

Отсутствующие `permissions.search` и `permissions.fetch` означают `allow`: все безопасные публичные домены доступны без approval, в том числе в Plan и headless. Сохранённые явные `ask`/`deny` сохраняются. `allowDomains` относится к исключениям при `fetch: ask`, а не ограничивает домены при `fetch: allow`. `denyDomains` и project deny проверяются раньше разрешений и снова перед redirects/чтением кеша. Allow не отключает SSRF.

`search.provider` принимает `auto`, `exa`, `parallel`, `brave`. По умолчанию стоит `auto`: Exa → Parallel, а при наличии ключа Brave — Brave → Exa → Parallel. Авто обращается к следующему разрешённому сервису только при недоступности, ошибке авторизации или квоте текущего; успешный пустой результат не запускает другой движок. При Ask сервисы показываются перед approval; denied endpoints исключаются во всех режимах, отмена и общие network/turn limits останавливают цепочку. У всей попытки один общий timeout. Явные `exa` и `parallel` используют официальные MCP без обязательного ключа и имеют лимиты бесплатного доступа; другой сервис при ошибке не вызывается. Явный `brave` использует `search.apiKey: { "envRef": "BRAVE_SEARCH_API_KEY" }` или `{ "secretRef": "web/brave-search" }`, сохранённый через скрытое поле Settings. Старые Brave config и secret references остаются совместимыми. Raw API keys и неизвестные поля Web отклоняются. `cacheTtlMs: 0` отключает cache. Все пределы проверяются строгой схемой; они не могут быть бесконечными. Search возвращает максимум 10 результатов, fetch принимает `maxChars` и дополнительно ограничен `maxExtractedChars`.

Репозиторий может только ужесточать `.chiselrc`: `"web": { "enabled": false, "denyDomains": ["example.com"], "maxRequestsPerTurn": 8 }`. Project config не принимает allow rules, credentials, custom transport или отключение SSRF. Deny имеет приоритет над domain/tool/session grants и Bypass. `*.example.com` разрешает/запрещает поддомены, apex добавляется отдельным правилом.

Private network всегда заблокирован. JavaScript/browser automation не поддерживаются. Корпоративные proxy, дополнительные CA и scoped mTLS задаются только в окружении пользователя: [корпоративная сеть](network.md). Для полного отключения user config — `"web": { "enabled": false }`. [Workflow, данные и troubleshooting](web.md).

## Анализ кода (LSP)

Основной экран — `/settings` → Инструменты → Анализ кода. По умолчанию **Auto**: язык определяется по имени файла, проект — по ближайшим разрешённым маркерам; сервер лениво готовится и запускается при первом diagnostics/navigation запросе. Ручные пути и отдельное разрешение каждого проекта для стандартного каталога не нужны. Settings/status/search/context/save ничего не устанавливают и не запускают.

| Языки | Auto backend | Условия |
| --- | --- | --- |
| TypeScript/JavaScript, TSX/JSX, MTS/CTS/MJS/CJS | TLS 6.0.1 + TS 6.0.3 | Встроены в npm package/binary; собственный Bun |
| Python | Pyright 1.1.414 | Node 24.19.0 готовится автоматически |
| Go | gopls 0.23.0 | Go 1.27.1 готовится; project dependencies не скачиваются |
| Rust | rust-analyzer 2026-10-05 | Rust 1.99.0 готовится; build scripts/proc macros/check-on-save и скачивание crates выключены |
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

Первый запрос может скачать значительный SDK; нужен интернет к закреплённым официальным delivery endpoints. Subsequent runs используют private versioned cache под `chiselHomeDir()/lsp/servers`. Версии, URL и SHA-256/SHA-512/dependency lock включены в приложение; npm/npx/bunx, shell install scripts и repository executables не используются. Подготовка Go использует fixed module с Go checksum database; Ruby устанавливает фиксированные проверенные `.gem` локально. Загрузка проходит public-address/redirect checks существующего HTTP client; это внутренний ограниченный канал доставки, а не новое разрешение агенту на arbitrary network. Offline cold cache даёт честную ошибку с возможностью повторить; встроенный TS работает offline. Cache проверяется перед запуском. Процесс получает минимальное окружение без model/API credentials.

Неизвестные языки и неподходящие OS/SDK не отображаются как работающие. Совместимый stdio LSP можно добавить в **Своя настройка**. Серверные capabilities определяют доступные функции; handshake не доказывает наличие diagnostics для конкретного файла. Для Kotlin и проектов с отсутствующими dependencies отдельные проверки могут оставаться unavailable — используйте компилятор/тесты. OmniSharp 2 присылает diagnostics с нулевой version: client честно маркирует такие результаты observed. Linux native recipes рассчитаны на glibc; если соответствующего SDK/artifact нет, используйте custom server.

Агент получает guidance применять definitions/references/symbols и diagnostics после изменения исходников вместе с обычными тестами. Backend и ближайший проект выбираются внутри shared workspace service; разные языки/subprojects имеют отдельные entries. Запуск/restart никогда не означает выдачу прав на редактирование. В одном workspace не более 16 entries, общий cache 64 документов/16 MiB; preparation до 5 минут, fixed build до 4 минут. Один artifact ограничен 384 MiB, extraction 1 GiB/30000 файлов/256 MiB на файл. Эти лимиты включают Windows .NET SDK; actual language requests сохраняют бюджет 10 секунд.

Три режима: **Auto**, **Своя настройка**, **Выключено**. Отключение завершает работающие серверы и запрещает новые requests. Минимальный advanced JSON — `"lsp": { "mode": "auto" }` или `"lsp": { "mode": "off" }`. Отсутствие секции означает Auto; существующая конфигурация с непустым `servers` без `mode` сохраняет прежний custom/trust режим. ID `auto` и `auto-*` зарезервированы за стандартным каталогом.

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

Экран «Этот проект» позволяет наследовать global режим, выбрать Auto, custom сервер или выключить анализ. Project `.chiselrc` разрешает только mode, выбор существующего global ID и прежний enabled flag:

```json
{ "lsp": { "mode": "custom", "serverId": "typescript" } }
```

Для Auto в проекте: `"lsp": { "mode": "auto" }`, для отключения: `"lsp": { "mode": "off" }` (старое `enabled:false` также действует); `{}` наследует global выбор. Global off имеет приоритет над проектом. При нескольких enabled/trusted custom записях без ID выводится ошибка неоднозначности. Выбор custom не выдаёт доверия. Project launch/trust/args/runtime/initializationOptions отклоняются. Settings сохраняет только project `lsp`, оставляет остальные и unknown поля; concurrent edit/invalid JSON не перезаписывается. Global panels сериализуют patches принадлежащих им полей, LSP draft проверяет revision своей секции. Config-path override используется и UI, и configured definition.

Смена режима / отзыв custom trust / disable применяется к открытым scopes без повторной activation и завершает affected servers. Изменённые custom launch fields дают «Нужен перезапуск»; новые явные calls применяют новый launch, старые requests/results не продолжают скрыто прежнюю generation. Status/list/search/context не запускают сервер. Явный «Запустить/Перезапустить» использует обычный process tool/queue/approval и Build; read-анализ в Auto доступен также в Plan.
