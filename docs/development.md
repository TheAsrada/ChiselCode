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

## Внутренние linked extensions

Контракт services/context/guards/tools и рабочий пример — в [архитектуре](architecture.md#границы-расширений). `ctx.tools.register(defineTool(...))` работает только во время activation; core присваивает `ext:<extensionId>:<localName>` и source. Contributions исполняются общим executor с Plan/permissions/EditingService/artifacts. Регистрация автоматически принадлежит workspace; вручную добавлять её в `ctx.add` не нужно. `ctx.add` применяется к ресурсам/service cleanup. Prompt binding временный, borrowed workspace переживает prompts.

Production composition включает `defaultExtensions()` с manifest consumer; custom linked definitions объединяйте явно через `defaultExtensions([example])`. Для изолированных tests можно использовать точный список или пустой `ExtensionHost([])`. Пользовательский JS loader/SDK пока отсутствует; trusted code работает с правами процесса, callbacks обязаны соблюдать signal и не выполнять mutations в prepare.

Acceptance tests используют реальные host/catalog/executor/policy/coordinator/storage и deterministic providers. Packaging harness поднимает локальный тестовый model endpoint, отправляет обычный Plan prompt и проверяет цикл model → manifest → model → checkpoint; production test flags/autoload fixtures отсутствуют:

```bash
bun tests/fixtures/manifest-cli.ts bun ./dist/cli.js
bun tests/fixtures/manifest-cli.ts bun ./dist/install-smoke/node_modules/chiselcode/dist/cli.js
bun tests/fixtures/manifest-cli.ts ./dist/chisel
```

Последние две команды запускаются после `npm pack`/установки и `bun run compile`. Windows compiled binary — `dist/chisel.exe`. CI matrix выполняет тот же manifest smoke для установленного пакета и compiled CLI на Windows/macOS/Linux; `--version`/`doctor` остаются отдельными проверками запуска. Harness не обращается к live LLM и не изменяет пользовательские credentials/config.

## Релизы

[Release workflow](../.github/workflows/release.yml) запускается по push тега `v*` или вручную из `main` с параметром `tag`:

1. Устанавливает зависимости через `npm ci`, проверяет типы, тесты и lint.
2. Сверяет тег с версией `package.json`.
3. Отдельными заданиями собирает EXE, два PKG и DEB.
4. Создаёт черновик GitHub Release и загружает четыре установщика. Заметки берёт из секции версии в `CHANGELOG.md`, а при её отсутствии генерирует автоматически.
5. Проверяет наличие всех четырёх файлов и публикует готовый релиз.

Изменение только документации не требует нового тега или публикации новой версии приложения.

## Изменения документации

Держите полные инструкции в `docs`, а корневой README — короткой входной страницей. Пишите по-русски, используйте относительные ссылки и проверяйте названия команд по исходникам. Не представляйте планы как уже реализованные функции и не обещайте проверок, которые не запускались. Разовые отчёты об аудите, исследованиях и выполненной работе оставляйте в сообщении или описании изменения; в `docs` нужны инструкции, которые пригодятся при использовании и разработке проекта.

Перед PR: [руководство участника](../CONTRIBUTING.md). Для ориентации в исходниках: [архитектура](architecture.md).

## Agent evaluation

```bash
bun run eval --category all
bun run eval --category web
bun run eval --category coding --trials 3 --baseline evals/baselines/runtime-v1-mock.json
bun run eval --live --category coding --model <exact-model-id> --provider anthropic --trials 3
```

Fixture копируется в отдельный temporary directory на каждый trial и удаляется после grading. Setup failures, runner timeout и исключения инфраструктуры отмечаются `infra_error`. Команды и filesystem graders измеряют итоговое состояние; trajectory grader использует общий RuntimeEvent stream. Отчёты JSON/Markdown создаются в `evals/results/`, baseline хранится отдельно. Точное содержимое fixture фиксируется hash, окружение — commit/platform/Bun/timeout/resource/network metadata. Host harness не ограничивает CPU/RAM и не является sandbox.

Mock trials используют scripted provider: success означает корректность сценария, а не качество реальной модели. Live run требует настроенного profile и ключа обычным способом, выполняет approved команды в fixture с правами пользователя и может расходовать API budget. Не запускайте недоверенные fixtures. Manual workflow `Agent evaluation` использует secrets провайдера; PR CI не вызывает live API.

Web cases проверяют общий runtime с реальным локальным HTTP fixture через test-only transport: миграцию API по документации, prompt injection, блокировку private destination и offloading больших документов. Они помечены `mockOnly` и пропускаются при `--live`; их результат не подтверждает поведение реальной LLM или доступность Brave. `tool_result` grader проверяет error code, artifact, trust label и размер model-visible preview. `failure` означает невыполнение задачи/сценария, `infra_error` — сбой окружения или протокола, `safety_violation` — изменение запрещённых файлов или провал safety grader; safety имеет приоритет перед сопутствующим infrastructure error.

Conformance cases находятся в `tests/unit/runtime-v2.test.ts` и `provider-conformance.test.ts`. Перед изменением runtime добавьте соответствующий case и сравните одинаковый fixture/model/settings с baseline. Не представляйте mock token counters как сравнение стоимости реальных моделей.

Provider conformance/migration/security/scale coverage: provider-registry, provider-runtime, provider-config, custom-providers, provider-cli, provider-settings, provider-sessions, provider-capabilities и provider-conformance tests. Новый сервис существующего protocol — definition/registration/tests/docs; новый protocol — driver/registration/tests/docs. SDK imports вне drivers запрещены architecture test.

Live harness создаёт config v2 только в isolated fixture/.chisel, не меняя пользовательский config. При одном настроенном profile копирует его параметры/apiKeyRef; несколько profiles требуют --profile. При отсутствии profiles trial использует definition endpoint и env key в отдельном eval-trial profile. Так manual CI с env secrets продолжает работать. Пример: `bun run eval --live --provider openai --profile openai-work --model gpt-5 --trials 3`.

Сравнение provider refactor с runtime-v2 baseline: `evals/baselines/providers-v061-mock-summary.json` содержит 21 scripted trial и metrics/environment, без raw trace для компактности; `providers-v061-comparison.json` — 21 comparable case, 0 regressions, input token delta 0. Это conformance evidence, не live-model quality benchmark. Исторические baselines не переписаны.
