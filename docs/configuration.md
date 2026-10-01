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
    "maxInlineToolResultTokens": 10000,
    "contextWindow": 128000,
    "maxOutputTokens": 4096
  },
  "tools": { "maxParallelReads": 4 },
  "editing": { "requireFreshRead": true }
}
```

`contextWindow` и `maxOutputTokens` в примере — явные overrides, а не универсальные свойства моделей. Без override runtime использует известную provider capability; неизвестный window остаётся неизвестным. Output reserve и buffer входят в общий budget. Большие tool outputs сохраняются как artifacts и доступны через `read_tool_result`. Отключение `requireFreshRead` снимает обязательность предварительного чтения, но не проверку уже наблюдавшейся revision или проверку между preflight и commit.

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
