# Разработка и проверки

[Документация](README.md) · [Главная](../README.md)

## Навигация

[Окружение](#окружение) · [Проверки](#проверки) · [Сборка](#сборка-самостоятельного-исполняемого-файла) · [Выпуск](#релизы) · [Документация](#изменения-документации) · [Сценарии отдельных возможностей](contributors/feature-checks.md)

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
bun run docs:check
bun run test:fast
bun run typecheck
bun run lint
bun run build
```

| Команда | Что проверяет или создаёт |
| --- | --- |
| `bun run docs:check` | Ссылки, якоря, изображения и доступность страниц документации |
| `bun run typecheck` | Типы TypeScript без генерации файлов |
| `bun run test` / `bun run test:fast` | Быстрый профиль логики без серверов и GUI |
| `bun test` / `bun run test:full` | Все unit- и integration-тесты; предварительно `bun scripts/prepare-lsp-tests.ts` |
| `bun run lint` | Biome для `src`, `tests`, `evals` и проверяющего документацию скрипта |
| `bun run eval --category all` | Все deterministic offline runtime evals |
| `bun run build` | JS-сборку в `dist/` для Bun |
| `bun run compile` | Исполняемый файл `dist/chisel` для текущей платформы |
| `bun run format` | Переформатирует `src` и `tests`; изменяет файлы |

[Quick CI](../.github/workflows/quick.yml) выполняет быстрый профиль, typecheck, lint и JS/SDK build при изменении кода в main/PR; правки только Markdown его не запускают. [Native validation](../.github/workflows/ci.yml) запускается вручную перед релизом или при изменении платформенного поведения: полный source-набор один раз на Linux и короткие native smoke на Windows/macOS/Linux. Полный [каталог LSP](../.github/workflows/lsp-catalog.yml) проверяется отдельно при изменении backends/provisioning. Локально начинайте с затронутых тестов; успешный неизменный сценарий не повторяйте без новой причины. Подробности и карта покрытия — [порядок проверок](contributors/testing.md). Документацию проверяет отдельный [Docs CI](../.github/workflows/docs.yml); локальная команда — `bun run docs:check`. Biome проверяет исходники, а содержание примеров нужно сверять с реальным поведением.

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

[Сценарии и команды проверки](contributors/feature-checks.md#внутренние-linked-extensions).

## Проверка создания навыков

[Сценарии и команды проверки](contributors/feature-checks.md#проверка-создания-навыков).

## Проверка сводок действий

[Сценарии и команды проверки](contributors/feature-checks.md#проверка-сводок-действий).

## Проверка владельца фоновых задач

[Сценарии и команды проверки](contributors/feature-checks.md#проверка-владельца-фоновых-задач).

## Проверка помощников

[Сценарии и команды проверки](contributors/feature-checks.md#проверка-помощников).

## Релизы

Перед созданием тега обновите версию в `package.json`, `package-lock.json` и `src/version.ts`, подготовьте секцию `CHANGELOG.md` и отправьте release source commit в `main`. Запустите Native validation вручную и дождитесь успешного Full source и трёх Native smoke jobs на этом точном коммите по [порядку проверок](contributors/testing.md). Затем создайте свободный тег `v<версия>` на проверенном source; опубликованные теги и файлы выпусков не заменяются.

[Release workflow](../.github/workflows/release.yml) запускается по push тега `v*` или вручную из `main` с параметром `tag`:

1. Сверяет тег с версией `package.json` и требует успешную native CI-матрицу на точном SHA checkout тега через GitHub API. Повторный полный source-набор не запускается.
2. В сборочных jobs устанавливает зависимости через `npm ci`; проверяет запуск и версию собранных бинарников на ОС runner и наличие SDK declarations.
3. Отдельными заданиями собирает EXE, два PKG, DEB и npm-пакет CLI с SDK расширений.
4. Создаёт черновик GitHub Release и загружает четыре установщика и `chiselcode-<версия>.tgz`. Заметки берёт из секции версии в `CHANGELOG.md`, а при её отсутствии генерирует автоматически.
5. Проверяет наличие всех пяти файлов и публикует готовый релиз. Отдельные engine binaries и служебные архивы концепта Desktop не собираются и не загружаются этим workflow.

Изменение только документации не требует нового тега или публикации новой версии приложения.

Заметки к релизу и секцию версии в `CHANGELOG.md` пишите по-русски. Сохраняйте технические имена команд и API; описывайте изменения для пользователя, а сведения о реализации и доказательства проверок выносите в материалы для участников.

## Изменения документации

Держите полные инструкции в `docs`, а корневой README — короткой входной страницей. Пишите по-русски, используйте относительные ссылки и проверяйте названия команд по исходникам. Пользовательская справка объясняет действия и ограничения; внутренние API описываются в архитектуре и руководстве разработчика. Отчёты о реализации, результаты проверок и кадры интерфейса размещайте отдельно в `docs/contributors/reports`, указывая коммит и версию. В пользовательском оглавлении используйте названия возможностей, а не номера этапов или формулировки отчёта. Не представляйте планы как уже реализованные функции и не обещайте проверок, которые не запускались.

По поручению владельца работайте прямо в main без новых веток, worktrees для разработки и PR. Общие правила участия: [руководство участника](../CONTRIBUTING.md). Для ориентации в исходниках: [архитектура](architecture.md).

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

<a id="многоязычный-lsp-каталог"></a>

## Проверки LSP и Settings

[Сценарии и команды проверки](contributors/feature-checks.md#проверки-lsp-и-settings).

<a id="воспроизведение-проверок"></a>

## Внутренний API запросов модели

[Сценарии и команды проверки](contributors/feature-checks.md#внутренний-api-запросов-модели).

## Рабочие копии: разработка и проверки

[Сценарии и команды проверки](contributors/feature-checks.md#рабочие-копии-разработка-и-проверки).

## UI-композиция и создание расширений

[Сценарии и команды проверки](contributors/feature-checks.md#ui-композиция-и-создание-расширений).

## Единое графическое оформление OpenTUI

[Сценарии и команды проверки](contributors/feature-checks.md#единое-графическое-оформление-opentui).
