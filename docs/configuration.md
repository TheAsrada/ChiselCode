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
| `autoApprove` | `false` | Автоматическое разрешение изменяющих инструментов |

Указанный `ignorePatterns` **заменяет** стандартный список. Поэтому в примере сохранены стандартные исключения и добавлены `.env`. Секреты не исключаются автоматически одним только наличием `.env` в проекте.

Правило команды сравнивается с полной строкой: точное совпадение либо начало `правило + пробел`. Это не разбор shell-синтаксиса: правило `bun test` также совпадёт с составной строкой, начинающейся на `bun test `. Списки команд не являются песочницей; подробнее — [безопасность](security.md).

## Инструкции проекта: `CHISEL.md`

Markdown-файл `CHISEL.md` в корне проекта добавляется к инструкции агента. Например:

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
| Разговоры | `ChiselCode Home/sessions/` | `ChiselCode Home/sessions/` |
| Пользовательские навыки | `ChiselCode Home/skills/user/` | `ChiselCode Home/skills/user/` |
| Встроенные навыки | `ChiselCode Home/skills/bundled/` | `ChiselCode Home/skills/bundled/` |

В каталоге настроек находятся `config.json` и `credentials.enc`. Конфигурация содержит ссылки на ключи (`apiKeyRef`), а не их значения. Не путайте каталог настроек с каталогом данных. Таблица показывает обычное расположение при стандартных переменных окружения ОС.

## Параметры интерфейса

| Переменная | Действие |
| --- | --- |
| `CHISEL_ALT_SCREEN=0` или `CHISEL_NO_ALT_SCREEN=1` | Классический режим с историей прокрутки терминала |
| `CHISEL_NO_MOUSE=1` или `CHISEL_DISABLE_MOUSE=1` | Отключить захват мыши |
| `CHISEL_MOUSE_CAPTURE=1` | В Windows включить захват мыши для прокрутки ленты колёсиком; выделение текста — с Shift |
| `CHISEL_SCROLL_SPEED` | Скорость колеса: 1–20, по умолчанию 3 |
| `NO_COLOR` | Отключить цвет |
| `FORCE_COLOR=1` | Включить цвет, если не задан `NO_COLOR` |

Пример для PowerShell:

```powershell
$env:CHISEL_NO_MOUSE = "1"
chisel
```

Пример для bash/zsh:

```bash
CHISEL_NO_MOUSE=1 chisel
```

Переменные API-ключей перечислены в [справке провайдеров](providers.md). CLI-флаги провайдера и модели переопределяют выбор для запуска; при продолжении сессии без этих флагов сохраняются её провайдер и модель.
