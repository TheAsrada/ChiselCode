# Разработка и проверки

[Документация](README.md) · [Главная](../README.md)

## Окружение

Нужны Git и Bun **1.3+** (минимум из `package.json`). Текущий CI использует Bun **1.4.2**. Ripgrep ускоряет поиск, но имеет встроенный fallback. Для `npm ci` нужен Node.js с npm.

```bash
git clone https://github.com/TheAsrada/ChiselCode.git
cd ChiselCode
npm ci
bun run dev
```

`npm ci` использует существующий `package-lock.json` и применяется в release workflow. Основной CI также использует `npm ci`. Не обновляйте зависимости и lockfile случайно вместе с правкой документации.

Для работы с реальной моделью понадобится [настройка провайдера](providers.md). Не добавляйте свои ключи и сессии в репозиторий.

## Проверки

```bash
bun run typecheck
bun test
bun run lint
bun run build
```

| Команда | Что проверяет или создаёт |
| --- | --- |
| `bun run typecheck` | Типы TypeScript без генерации файлов |
| `bun test` | Unit- и integration-тесты |
| `bun run lint` | Biome для `src`, `tests` и `evals` |
| `bun run build` | JS-сборку в `dist/` для Bun |
| `bun run compile` | Исполняемый файл `dist/chisel` для текущей платформы |
| `bun run format` | Переформатирует `src` и `tests`; изменяет файлы |

Основной [CI](../.github/workflows/ci.yml) запускается для push в `main` и PR в `main`, с матрицей Windows, macOS и Linux. Biome в текущем скрипте не проверяет Markdown: ссылки и примеры документации проверяйте отдельно.

## Сборка самостоятельного исполняемого файла

```bash
bun run compile
```

Пример сборки Windows x64:

```bash
bun build ./src/cli.ts --compile --target=bun-windows-x64 --outfile=dist/chisel.exe
```

Другие targets, используемые релизами: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`. Отдельная компиляция не создаёт установщик, ярлыки или PATH. Встроенные навыки также нужно учитывать при упаковке: workflow копирует `skills/bundled` рядом с установленным приложением.

## Релизы

[Release workflow](../.github/workflows/release.yml) запускается по push тега `v*`:

1. Устанавливает зависимости через `npm ci`, проверяет типы, тесты и lint.
2. Сверяет тег с версией `package.json`.
3. Создаёт GitHub Release; заметки берёт из секции версии в `CHANGELOG.md`, а при её отсутствии генерирует автоматически.
4. Отдельными заданиями собирает и загружает EXE, два PKG и DEB.

Релиз может появиться до окончания загрузки всех установщиков. Изменение только документации не требует нового тега или публикации новой версии приложения.

## Изменения документации

Держите полные инструкции в `docs`, а корневой README — короткой входной страницей. Пишите по-русски, используйте относительные ссылки и проверяйте названия команд по исходникам. Не представляйте планы как уже реализованные функции и не обещайте проверок, которые не запускались.

Перед PR: [руководство участника](../CONTRIBUTING.md). Для ориентации в исходниках: [архитектура](architecture.md).

## Agent evaluation

```bash
bun run eval --category all
bun run eval --category coding --trials 3 --baseline evals/baselines/runtime-v1-mock.json
bun run eval --live --category coding --model <exact-model-id> --provider anthropic --trials 3
```

Fixture копируется в отдельный temporary directory на каждый trial и удаляется после grading. Setup failures, runner timeout и исключения инфраструктуры отмечаются `infra_error`. Команды и filesystem graders измеряют итоговое состояние; trajectory grader использует общий RuntimeEvent stream. Отчёты JSON/Markdown создаются в `evals/results/`, baseline хранится отдельно. Точное содержимое fixture фиксируется hash, окружение — commit/platform/Bun/timeout/resource/network metadata. Host harness не ограничивает CPU/RAM и не является sandbox.

Mock trials используют scripted provider: success означает корректность сценария, а не качество реальной модели. Live run требует ключа обычным способом, выполняет approved команды в fixture с правами пользователя и может расходовать API budget. Не запускайте недоверенные fixtures. Manual workflow `Agent evaluation` использует secrets провайдера; PR CI не вызывает live API.

Conformance cases находятся в `tests/unit/runtime-v2.test.ts` и `provider-conformance.test.ts`. Перед изменением runtime добавьте соответствующий case и сравните одинаковый fixture/model/settings с baseline. Не представляйте mock token counters как сравнение стоимости реальных моделей.
