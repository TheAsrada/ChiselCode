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
