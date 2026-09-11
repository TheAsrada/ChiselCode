# ChiselCode

ChiselCode — безопасный мультипровайдерный агентский CLI для задач разработки. Он работает с файлами и shell-командами проекта через LLM tool-use, но по умолчанию не выполняет изменяющие действия без подтверждения.

## Возможности MVP

- Anthropic, OpenAI и OpenAI-compatible провайдеры (Ollama, OpenRouter, Groq, LM Studio и другие).
- Интерактивный TUI (`chisel`) и one-shot режим (`chisel "задача"`).
- Чтение, поиск, запись, точечные правки, shell, `git diff` и `git commit`.
- Approval перед изменениями, diff-предпросмотр, allow/deny shell-политики и read-before-write.
- Проектные `.chiselrc` и `CHISEL.md`.
- JSON-сессии с resume, учётом токенов/стоимости и undo-историей.
- JSON-вывод для CI и кроссплатформенная standalone-сборка Bun.

## Требования

- Bun 1.2 или новее.
- `rg` (ripgrep) в `PATH` для инструмента `grep`.
- API-ключ нужного провайдера либо `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` в окружении.

## Установка и запуск

```bash
bun install --frozen-lockfile
bun run src/cli.ts "Покажи структуру проекта"
```

После сборки пакет предоставляет бинарник `chisel`:

```bash
bun run build
chisel "Проверь тесты" --provider anthropic --model claude-opus-5
```

Запуск без аргумента в TTY открывает TUI:

```bash
bun run src/cli.ts
```

## One-shot флаги

```text
--provider anthropic|openai|openai-compatible
--model <model-id>
--base-url <url>
--yes                         подтвердить все изменяющие действия
--allow read_file,run_shell   разрешить конкретные инструменты
--json                        вывести один JSON-объект
--resume <session-id>         продолжить сессию
--cwd <path>                  корень проекта
```

Без `--yes`, явного `--allow` или разрешающей политики `.chiselrc` one-shot запуск не зависает: при первой операции с approval он завершится с dry-run, кодом `2` и preview изменений.

## Конфигурация проекта

`.chiselrc` в корне проекта:

```json
{
  "allowedCommands": ["bun test", "bun run typecheck"],
  "deniedCommands": ["rm -rf", "git push --force"],
  "ignorePatterns": [".git/**", "node_modules/**", ".env"],
  "autoApprove": false
}
```

`CHISEL.md` — обычный Markdown с правилами кодовой базы. Он добавляется в системную инструкцию после статичного базового промпта и перед динамическим контекстом.

## Ключи

Переменные окружения имеют приоритет:

```bash
ANTHROPIC_API_KEY=... chisel "..."
OPENAI_API_KEY=... chisel --provider openai "..."
```

Также есть команды:

```bash
chisel auth set anthropic-default <API_KEY>
chisel auth get anthropic-default
```

API-ключи сохраняются в локальном зашифрованном fallback-файле в пользовательской конфигурационной директории. Переменные окружения остаются предпочтительным вариантом для автоматизации и CI.

## Проверка

```bash
bun run typecheck
bun test
bun run lint
bun run compile
```

## Разработка и вклад

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run lint
```

Пожалуйста, сначала ознакомьтесь с [руководством по вкладу](CONTRIBUTING.md), [политикой безопасности](SECURITY.md) и [историей изменений](CHANGELOG.md).

## Дистрибуция

```bash
npm publish
bun build ./src/cli.ts --compile --target=bun-windows-x64 --outfile chisel.exe
```

GitHub Actions выполняет проверки на Windows, macOS и Linux, а тег `v*` проверяет проект и создаёт GitHub Release со standalone-бинарниками для Windows, macOS и Linux.

## Безопасность

ChiselCode ограничивает все файловые пути корнем проекта, блокирует ignored paths и пытается предотвратить обходы через `..` и существующие симлинки. `edit_file` требует ровно одно совпадение `old_str`; существующий файл необходимо сначала прочесть перед записью или правкой. Shell, запись, удаление и commit защищены deny-by-default.

## Лицензия

[MIT](LICENSE).
