# CLI и автоматизация

[Документация](README.md) · [Главная](../README.md)

## Основные команды

```bash
chisel
chisel setup
chisel setup --provider openai
chisel doctor
chisel update
chisel update --json
chisel --help
chisel --version
```

Без задачи открывается интерактивный режим, которому нужен терминал. С задачей в аргументах выполняется один запрос:

```bash
chisel --cwd ./my-project "Объясни структуру проекта"
chisel --cwd ./my-project --resume <session-id> "Продолжи анализ"
```

## Флаги запроса

Для внешних инструментов доступны `chisel mcp list`, `add`, `remove`, `info`, `tools`, `enable`, `disable`, `doctor`, `logs` и `trust`. `chisel mcp` показывает список без запуска команд. Общие `--cwd` и `--json` поддерживаются. `mcp doctor` возвращает 0 при успешных проверках, 2 при ошибке сервера, необходимом доверии или авторизации; ошибка команды возвращает 1. Примеры и настройка без TUI: [MCP → CLI](mcp.md#cli).

| Флаг | Назначение |
| --- | --- |
| `--cwd <path>` | Корень проекта; по умолчанию текущая папка терминала |
| `--profile <profile-id>` | Конкретный аккаунт/profile |
| `--provider <provider>` | Compatibility выбор provider ID из `chisel providers list`; нужен единственный profile |
| `--model <model>` | ID модели выбранного сервиса |
| `--mode <build\|plan>` | Режим агента; новая сессия начинает в Build, resume без флага восстанавливает сохранённый режим |
| `--base-url <url>` | Адрес совместимого API |
| `--resume <session-id>` | Полный ID или однозначный префикс сессии текущего проекта |
| `--allow <tools>` | Разрешить перечисленные через запятую инструменты без вопроса |
| `--approval <режим>` | `default`, `acceptEdits`, `dontAsk` или `bypassPermissions`, независимо от Plan/Build; resume восстанавливает сохранённый выбор |
| `--yes` | Выбрать Accept edits; явный `--approval` имеет приоритет |
| `--json` | Вывести итог запроса одним JSON-объектом |
| `--pause` / `--no-pause` | Ждать / не ждать Enter перед выходом |

Одноразовый запуск использует обработчик без интерактивного подтверждения. В Manual и Accept edits действие, требующее разрешения, возвращает `approval_required`; в Dont ask оно отклоняется без ожидания подтверждения. Для изменения используйте интерактивный режим или заранее разрешите необходимые инструменты.

```bash
chisel --cwd ./my-project --allow edit_file "Исправь опечатку в README.md"
```

`--allow edit_file` не разрешает `write_file`, `run_shell` или другие инструменты. Для MCP используется полное имя, например `--allow github.comment_issue`; это не разрешение всему серверу. Явные MCP denies и Plan имеют приоритет. Отдельного CLI-флага для разрешения одной конкретной shell-команды нет: это настраивается в `.chiselrc`. Проверяйте [семантику правил](configuration.md) перед автоматизацией.

В Plan изменяющие инструменты и shell недоступны независимо от `--yes` и `--allow`. Результат — план в разговоре; для реализации продолжите ту же сессию в Build:

```bash
chisel --mode plan --cwd ./my-project "Изучи обработку ошибок и составь план исправления"
chisel --mode build --cwd ./my-project --resume <session-id> "Выполни предложенный план"
```

## JSON и коды завершения

`--approval acceptEdits` разрешает правки проекта, а shell и Git-запись проверяются отдельно. Старый `auto` — алиас Accept edits, `ask` и `manual` — алиасы `default`. Bypass доступен после включения в пользовательских Settings. Приоритет: `--approval` → `--yes` → сохранённый выбор → `.chiselrc.autoApprove` → Manual. Явные `--allow` и `allowedCommands` сохраняются; `deniedCommands` и ограничения Plan действуют во всех режимах. Подробнее: [разрешения](permissions.md).

```bash
chisel --cwd ./my-project --json "Объясни структуру проекта" > result.json
```

| Поле результата | Содержание |
| --- | --- |
| `status` | `completed`, `approval_required`, `failed`, `cancelled` |
| `text` | Итоговый текст |
| `sessionId` | ID сохранённой сессии |
| `mode` | `build` или `plan` для выполненного запроса |
| `approvalMode` | `default`, `acceptEdits`, `dontAsk` или `bypassPermissions` для выполненного запроса |
| `totalTokens` | Счётчики `inputTokens`, `outputTokens` и необязательные счётчики кэша |
| `totalCost` | Optional известная estimated стоимость; отсутствует при unknown pricing |
| `costEstimate` | source=provider/estimated/unknown, optional usd; не заменяет billing |
| `error` | Сообщение ошибки, если есть |
| `pendingApproval` | Инструмент и предпросмотр, если нужно разрешение |

Необязательные поля могут отсутствовать. JSON здесь — итоговый объект, не поток JSONL. Ошибки до запуска агентного цикла (например, конфигурация или отсутствие ключа) могут выводиться обычным текстом в stderr: проверяйте код завершения до разбора stdout.

| Код | Для результата агентного запроса |
| --- | --- |
| `0` | Завершено |
| `1` | Ошибка |
| `2` | Нужно подтверждение |
| `130` | Отменено |

У служебных команд свои результаты: `doctor` возвращает `2`, если ключ не настроен; `update --json` — `1` при ошибке проверки обновления, иначе `0`. Его JSON содержит `current` и необязательные `latest`, `latestUrl`, `updateAvailable`, `error`.

## Ключи в автоматизации

Передавайте ключ через секреты среды CI в [переменную своего провайдера](providers.md). Не включайте его в репозиторий, вывод команд или JSON-артефакты. Учитывайте, что сессии сохраняются локально и могут содержать исходный код.

Низкоуровневые команды `chisel auth set <name> <secret>` и `chisel auth get <name>` сохраняют ключ и проверяют его наличие. `get` не печатает значение; `set` передаёт секрет в аргументах и может оставить его в истории shell. Для обычной настройки используйте `chisel setup`.

## Пользовательский provider catalog

`chisel providers path` создаёт Home layout и печатает абсолютный путь. `chisel providers list` показывает IDs, sources, drivers и diagnostics. `chisel providers validate` проверяет manifests offline; exit 0 — нет errors, 1 — есть errors. Warnings, например remote HTTP, не делают validate failed. Catalog строится при запуске; после изменения manifests перезапустите приложение.

## Provider profiles

```bash
chisel setup --provider openai --profile openai-work
chisel --profile openai-work "Объясни проект"
chisel --provider openai --model gpt-5 "Объясни проект"
chisel --profile openai-work --resume <session-id> "Продолжи"
```

`--profile` выбирает точный profile. Старый `--provider` остаётся compatibility interface: один profile — выбрать его; ни одного — controlled not configured; несколько — требуется --profile. Вместе flags должны указывать на один provider. Model precedence: --model → profile.defaultModel → definition.defaults.model → controlled selection error. Resume без overrides сохраняет профиль и модель сессии; explicit profile/provider может их заменить. setup --profile создаёт/редактирует точный profile; «Профиль» и «Новый профиль» доступны в settings. doctor проверяет локальные metadata/key references, не вызывает API.
