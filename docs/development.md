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
bun run test:fast
bun run typecheck
bun run lint
bun run build
```

| Команда | Что проверяет или создаёт |
| --- | --- |
| `bun run typecheck` | Типы TypeScript без генерации файлов |
| `bun run test` / `bun run test:fast` | Быстрый профиль логики без серверов и GUI |
| `bun test` / `bun run test:full` | Все unit- и integration-тесты; предварительно `bun scripts/prepare-lsp-tests.ts` |
| `bun run lint` | Biome для `src`, `tests` и `evals` |
| `bun run eval --category all` | Все deterministic offline runtime evals |
| `bun run build` | JS-сборку в `dist/` для Bun |
| `bun run compile` | Исполняемый файл `dist/chisel` для текущей платформы |
| `bun run format` | Переформатирует `src` и `tests`; изменяет файлы |

[Quick CI](../.github/workflows/quick.yml) выполняет быстрый профиль, typecheck, lint и JS/SDK build при изменении кода в main/PR; правки только Markdown его не запускают. [Native validation](../.github/workflows/ci.yml) запускается вручную перед релизом или при изменении платформенного поведения: полный source-набор один раз на Linux и короткие native smoke на Windows/macOS/Linux. Полный [каталог LSP](../.github/workflows/lsp-catalog.yml) проверяется отдельно при изменении backends/provisioning. Локально начинайте с затронутых тестов; успешный неизменный сценарий не повторяйте без новой причины. Подробности и карта покрытия — [порядок проверок](contributors/testing.md). Biome не проверяет Markdown: ссылки и примеры документации проверяйте отдельно.

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

Контракт services/context/guards/tools/commands и рабочий пример — в [архитектуре](architecture.md#границы-расширений). `ctx.tools.register(defineTool(...))` и `ctx.commands.register({ name, description, usage, parse, execute })` работают только во время activation. Для tools core присваивает `ext:<extensionId>:<localName>` и source. Slash head имеет отдельную identity `{ type: "extension", extensionId, name }`, без wire namespace. Built-in/skill/extension name conflicts отклоняются явно. Contributions исполняются общим executor с Plan/permissions/EditingService/artifacts. Регистрации автоматически принадлежат workspace; вручную добавлять их в `ctx.add` не нужно. `ctx.add` применяется к ресурсам/service cleanup. Prompt/command tool binding временный, borrowed workspace переживает операции.

Production composition включает `defaultExtensions([], { configPath })` с manifest, LSP, побочными вопросами, рабочими копиями и помощниками; custom linked definitions объединяйте явно через `defaultExtensions([example])`. Для изолированных tests можно использовать точный список или пустой `ExtensionHost([])`. Command example в архитектуре показывает регистрацию, parse без shell evaluation и `invocation.tools.execute` с canonical именем. Этот port сохраняет policy/checkpoints, не требует model API key и не даёт callback доступ к Session/catalog/approval resolver/UI. Command output не становится model message; ToolExecutionResult с error/pending/artifact следует возвращать без потери этих полей. Для пользовательских JS-пакетов используйте [публичный SDK и loader](extensions/README.md). Trusted code работает с правами процесса, callbacks обязаны соблюдать signal и не выполнять mutations в prepare. builtin.lsp предоставляет настоящие status/restart contributions.

Acceptance tests используют реальные host/catalog/executor/policy/coordinator/storage и deterministic providers. Packaging harness поднимает локальный тестовый model endpoint, отправляет обычный Plan prompt и проверяет цикл model → manifest → model → checkpoint; production test flags/autoload fixtures отсутствуют:

```bash
bun tests/fixtures/manifest-cli.ts bun ./dist/cli.js
bun tests/fixtures/manifest-cli.ts bun ./dist/install-smoke/node_modules/chiselcode/dist/cli.js
bun tests/fixtures/manifest-cli.ts ./dist/chisel
```

Последние две команды запускаются после `npm pack`/установки и `bun run compile`. Windows compiled binary — `dist/chisel.exe`. Native smoke выполняет manifest smoke для установленного пакета на Windows/macOS/Linux; compiled CLI проходит отдельные download/LSP/child/worktree/background smoke; `--version`/`doctor` остаются отдельными проверками запуска. Harness не обращается к live LLM и не изменяет пользовательские credentials/config.

Command acceptance fixture явно передаёт linked extension настоящему TUI application, использует OpenTUI test renderer и реальные files/executor/store. Проверяются welcome/autocomplete, exactly-once dispatch без ключа модели, approvals/Plan/guards, очередь commands/prompts, соседние вкладки, Ctrl+C, artifact и checkpoint. Один специально queued ordinary prompt использует локальный deterministic model endpoint; commands не вызывают chat. Fixture запускается из исходников и может быть собрана тем же Bun pipeline:

```bash
bun tests/fixtures/tui-command-contributions.ts
bun build tests/fixtures/tui-command-contributions.ts --outdir ./dist/command-smoke --target bun --external '@opentui/core-*'
bun ./dist/command-smoke/tui-command-contributions.js
bun build tests/fixtures/tui-command-contributions.ts --compile --outfile ./dist/command-smoke/linked-tui
./dist/command-smoke/linked-tui
```

Это test-only linked build, не loader установленного CLI. Не включайте `dist/command-smoke` в публикуемый package. После `bun run build` команда `bun tests/fixtures/command-packaging.ts` собирает fixture в отдельный staging package, выполняет `npm pack`/install и тот же TUI сценарий из установленного bundle, затем из compiled binary. Этот расширенный harness запускайте отдельно при изменении TUI bundling или SDK; обычный CI и каждый релиз его не повторяют. Он не меняет production package или lockfile. На Windows compiled fixture имеет суффикс `.exe`. Command feedback остаётся UI projection; restart не запускает callback заново.

## Проверка создания навыков

`bun test tests/unit/skills.test.ts tests/unit/tools.test.ts tests/unit/opentui-skills.test.tsx tests/integration/skill-creator-runtime.test.ts` проверяет каталог, независимые настройки ручного/автоматического вызова, безопасную запись и production OpenTUI. Fixture `tests/fixtures/tui-skill-creator.ts` проходит автоматический `load_skill`, создание русского навыка, `/skill-creator` с отдельными аргументами и создание английского навыка с реальными файлами и checkpoints. Provider в fixture сценарный: это проверка передачи инструкций и записи Unicode, а не оценка выбора языка настоящей моделью. `CHISEL_CAPTURE_DIR` сохраняет реальные кадры.

При проверке npm-поставки убедитесь, что `npm pack` включает `skills/bundled/*/SKILL.md`: JS bundle ищет навыки относительно пакета, исходники — относительно `src/skills`, compiled CLI — рядом с executable. Для compiled UI-fixture сохраните имя `chisel-creator-smoke` (на Windows с `.exe`) и скопируйте `skills/bundled` в `skills/bundled` рядом с ним, как в установщике. Не добавляйте test-only fixture в production archive.

Первичная проверка skill-creator на source `cd41869` выполнена локально на Linux: 356 быстрых тестов, 53 профильных unit/UI-теста, два integration-сценария, typecheck/lint/build; полный creator UI-сценарий прошёл из исходников, JS bundle установленного npm-пакета и compiled fixture. Проверка упаковки входит в integration-файл: настоящий `npm pack --dry-run` и загрузка обоих навыков из bundle в изолированном `node_modules/chiselcode`. Кадр [OpenTUI](assets/skill-creator/skill-creator.png) получен через production renderer, TXT/JSON сохранены рядом. В этой первичной проверке Windows/macOS не запускались; более поздние проверки общего source и поставки описаны в [отчёте UI-композиции](contributors/reports/ui-composition.md).

## Проверка сводок действий

Сводки действий проверяются через `bun test tests/unit/tool-actions.test.ts` и `bun test tests/integration/tool-actions-tui.test.ts`. Первый файл входит в быстрый профиль, второй — в полный source-набор с настоящим OpenTUI/executor. Для кадров задайте `CHISEL_CAPTURE_DIR=dist/tool-actions-captures`; [сценарии и кадры](contributors/reports/tool-actions.md). Дорогой UI-fixture не добавляется в быстрый профиль. Затронутые unit/UI-файлы также входят в платформенные проверки Native validation на Windows/macOS; Linux выполняет их в общем source-наборе.

Перед платформенными тестами Native validation подготавливает закреплённые внешние зависимости LSP на Windows/macOS, как и полный source job на Linux. Проверки transport не полагаются на запуск более позднего compiled smoke.

## Проверка владельца фоновых задач

```bash
bun test tests/unit/background-owner.test.ts
bun test tests/integration/background-runtime.test.ts
CHISEL_CAPTURE_DIR=dist/background-owner-captures bun tests/fixtures/tui-background-owner.ts
```

Быстрый тест проверяет канонический root, поколение controls, конфликт одновременных подключений и отмену при чтении записей. Интеграционный файл дополнительно запускает настоящий процесс, проверяет сохранение его вывода и resource fence при подключении через ссылку, затем продолжает восстановленную сессию в OpenTUI двумя запросами к локальному model endpoint. Команда из истории запускается ровно один раз. В Windows fixture использует junction и путь в другом регистре. TXT/JSON кадр последнего ответа сохраняется в `CHISEL_CAPTURE_DIR`.

Этот unit-файл входит в быстрый профиль и в платформенные проверки Native validation на Windows/macOS; интеграционный сценарий входит в полный source-набор. Проверки установленного и compiled CLI с настоящей shell-командой доступны через `bun tests/fixtures/background-cli.ts bun dist/cli.js` и `bun tests/fixtures/background-cli.ts ./dist/chisel` после соответствующей сборки. Linux-прогон не подтверждает поведение Windows: для него выполните затронутые тестовые файлы на Windows по [порядку проверок](contributors/testing.md#выбор-основной-ос-и-границы-покрытия).

Диагностика shell проверяется отдельно командой `bun test tests/unit/shell-runtime.test.ts`. Файл запускает настоящий fallback executor с упавшей проверкой и сверяет полный traceback и exit code; pure-проверки CMD воспроизводят `;`, Unix pipeline и нечитаемый текст ошибки без подмены оболочки. Windows-only сценарии CMD/Python и UTF-8 выполняются только на Windows и уже входят в её Native validation.

## Проверка помощников

[Внутренний контракт помощников](architecture/subagents.md) описывает привязанные к владельцу порты, дочерний runtime, ограничения и независимые записи расходов. Это внутренний linked-code API, а не внешний SDK.

Контролируемые HTTP endpoints используют настоящие OpenAI/Anthropic drivers; Git, инструменты, разрешения и хранилища остаются production. Основной запрос удерживается барьером, пока помощники выполняют чтение и изменения в независимых копиях. Native TUI проверяет адресованные разрешения, дерево, остановку и просмотр после открытия сохранённого разговора:

```bash
bun test tests/unit/subagent-budget.test.ts tests/unit/subagent-storage-policy.test.ts
bun test tests/unit/subagent-lifecycle.test.ts tests/unit/opentui-subagents.test.tsx
bun test tests/unit/runtime-v2.test.ts tests/integration/conversation-diagnostics.test.ts
CHISEL_CAPTURE_DIR=/absolute/captures bun tests/fixtures/tui-subagents.ts
bun tests/fixtures/subagents-runtime.ts
bun tests/fixtures/subagents-cli.ts bun dist/cli.js
bun tests/fixtures/subagents-cli.ts ./dist/chisel
bun tests/fixtures/command-packaging.ts
```

Последняя команда включает установленный тестовый bundle и compiled native TUI. Обычный npm package и compiled CLI проверяются отдельно через их production entrypoint; тестовые страницы и flags не включаются в выпуск. TXT/JSON кадры реального renderer сохраняются в `CHISEL_CAPTURE_DIR`. Результаты и изображения — в [материалах проверки](contributors/reports/subagents.md).

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

Сравнение provider refactor с runtime-v2 baseline: `evals/baselines/providers-v061-mock-summary.json` содержит 21 scripted trial и metrics/environment, без raw trace для компактности; `providers-v061-comparison.json` — 21 comparable case, 0 regressions, input token delta 0. Это conformance evidence, не live-model quality benchmark. Исторические baselines не переписаны.

## Проверки LSP и Settings

`bun scripts/prepare-lsp-tests.ts` явно устанавливает test-only server 6.0.1/TypeScript 6.0.3 во внешний temporary runtime. Node 24.19.0 используется CI; local Node должен соответствовать >=22.22.2. При отсутствии installation real tests завершаются setup error, не skip. `CHISEL_TEST_LSP_ROOT` и `CHISEL_TEST_LSP_NODE` меняют только test harness; production не импортирует эти helpers и не выдаёт fixture trust.

`lsp-runtime.test.ts` проверяет и bundled Auto без paths/trust/Node setup, и custom backend через ordinary composition/executor/permissions/EditingService/store: TS error → read observation → valid edit → observed update, navigation, shared generation, Plan/deny/restart/revocation. Protocol peer используется отдельно для byte framing, old/versionless pushes, provisional empty, Full/Incremental, cancellation/EOF/crash/caps/cache и process-tree cleanup. Его metadata fixture и installation не попадают в release.

`lsp-tui.test.ts` выполняет default Auto → lazy diagnostics без paths/trust → Off/child cleanup, затем custom friendly form → read-only check → typed save → explicit trust → normal approval/start → diagnostics/edit → revoke через настоящие OpenTUI inputs. Model chat/key не нужен. Native captures можно получить test-only переменной, без production autoload/flags:

```bash
CHISEL_TEST_LSP_CAPTURES=/absolute/capture-directory bun tests/fixtures/tui-lsp-settings.ts
bun tests/fixtures/lsp-cli.ts bun ./dist/cli.js
bun tests/fixtures/command-packaging.ts
```

CLI smoke использует локальный scripted provider endpoint, real Auto LSP schemas/wire history/tool/result/context/checkpoint без LSP section в config. Расширенный packaging harness проверяет linked commands и Auto/custom Settings scenario в installed staging package и compiled binary. Native smoke выполняет `lsp-cli.ts` для compiled CLI на трёх ОС; installed пакет проверяется более короткими runtime/SDK smoke. `--version`/doctor недостаточно для доказательства contribution.

Стандартный payload содержит official TLS 6.0.1, TS 6.0.3 и их licenses/notices; воспроизводимое обновление описано в `src/lsp/backend/README.md`. Это единственный bundled backend asset (~3.6 MB gzip). Многоязычная preparation использует pinned `fflate`/`tar-stream` для bounded archives; dev TypeScript не заменяет runtime backend. Проверяйте assets при `npm pack`, работу из произвольного cwd и Bun `BUN_BE_BUN` в compiled executable. Auto не импортирует test installation.

`lsp-auto-check-changes` в `eval --category all`/`coding` использует закреплённый настоящий Auto backend и scripted model: definition → references → symbols → diagnostics → EditingService edit → diagnostics → tests. Model network и LSP setup не нужны. Fixture получает isolated config через тот же default extension host/provider binding; providers/context и cleanup остаются настоящими.

Settings visual review: реальные OpenTUI frames при 120×40, 100×30, 80×24, 60×20, 40×12, 24×8; native cursor сохраняется при resize длинного path. Reference patterns — категории/filter и focus zones из [OpenTUI example browser](https://github.com/anomalyco/opentui/blob/main/packages/examples/src/index.ts), installed-compatible [layout](https://opentui.com/docs/core-concepts/layout/) и [interaction](https://opentui.com/docs/core-concepts/interaction/). Routes/search/drafts не зависят от labels или secret values. OpenCode URLs из design brief могут быть недоступны; их configuration model не переносится. OpenTUI/React версии не обновлены.

### Многоязычный LSP каталог

`src/lsp/catalog.ts` связывает language IDs/extensions/project markers с reviewed installation recipe. Добавление стандартного сервера требует фиксированных URL/integrity в `release-assets.json` или npm/gem lock, license review и real-server test. Runtime не запрашивает latest version. Обновление locks выполняет maintainer, приложение не выполняет package discovery/import из проекта.

`bun scripts/prepare-lsp-tests.ts` заранее готовит pinned external TS и Auto Pyright/Lua. `bun test tests/integration/lsp-multilingual.test.ts` запускает настоящий core executor, сохранение session/source, real Pyright/Lua, navigation, EditingService и revocation; fake stdio peer проверяет generic language/trust/cancellation локально. `bun tests/fixtures/multi-lsp-probe.ts python go rust cpp csharp java kotlin php lua dart html css json yaml bash docker ruby` проверяет реальные backend; Ruby нужен SDK/build prerequisites, Swift проверяется на macOS/Xcode. Failure не скрывается skip; unavailable provenance не подменяется error-free.

`tests/fixtures/lsp-cli.ts` вызывает ordinary npm/compiled CLI с локальным deterministic model endpoint и настоящими TS/Pyright через production default composition. Test fixture не импортируется release entry point и не требует production test flags. Packaging/TUI smoke остаётся `bun tests/fixtures/command-packaging.ts`.

Отдельный ручной workflow `LSP catalog` по умолчанию выполняет `bun tests/fixtures/multi-lsp-probe.ts python go rust cpp csharp java kotlin php ruby lua dart html css json yaml bash docker` на Linux/macOS/Windows; опция `sourcekit` дополнительно проверяет настоящий SourceKit-LSP из Xcode на macOS. Ruby 3.4.11 SDK устанавливается только test setup. Probe требует настоящий initialize и symbols; проверяет diagnostics для заданных errors и definitions у поддерживающих их backends, затем закрывает service. Kotlin diagnostics без evidence остаются unavailable, а не фиктивным success. Для локальной проверки конкретного backend передайте его fixture name. Standard preparation не читает latest metadata: все используемые package bytes закреплены locks/integrity.

Во время первоначальной загрузки crates/VFS rust-analyzer может отклонить read request при замене snapshot. Native harness допускает не более двух повторов такого чтения с паузой 250 ms. Он сохраняет проверки настоящих diagnostics/symbols/definitions; повторные ошибки завершают job failure. Cancellation, unsupported capabilities, malformed reports и другие ошибки не получают этот retry. Runtime tool failure остаётся настоящим terminal result; harness не меняет production execution, не перезапускает сервер и не повторяет mutations.

## Внутренний API запросов модели

Пример программно подключённой команды; регистрация разрешена только во время activation:

```ts
ctx.commands.register({
  name: "explain",
  description: "Отдельный текстовый вопрос",
  usage: "/explain <вопрос>",
  executionPolicy: "side_query",
  parse(args) {
    const question = args.trim();
    if (!question) throw new Error("Нужен вопрос");
    return question;
  },
  execute(invocation, question) {
    return invocation.model.request({
      text: question,
      context: "conversation",
      limits: { outputTokens: 512 },
    });
  },
});
```

Core выдаёт неизменяемые identity/signal и порт model без tools, ключей, SDK, Session и renderer. Наблюдатель получает только очищенные типизированные события текста, статуса и завершения с владельцем, заданным core; перенаправить вывод нельзя. Запрос модели не выдаёт права на инструменты. Команда без `executionPolicy` продолжает идти через очередь разговора и может использовать ленивый порт model вместе с tools; локальные callbacks не требуют модели. Это низкоуровневый API программных definitions. Внешние пакеты используют [публичный SDK и загрузчик](extensions/README.md); статусы и панели описаны в [руководстве UI contributions](interface-contributions.md).

### Воспроизведение проверок

```sh
bun test tests/unit/model-requests.test.ts tests/unit/side-query-storage.test.ts
bun test tests/unit/opentui-side-query.test.tsx tests/integration/side-query-tui.test.ts tests/integration/side-query-cli.test.ts
bun tests/fixtures/side-query-cli.ts bun ./dist/cli.js
bun tests/fixtures/command-packaging.ts
```

Используются штатное приложение, встроенная команда, HTTP-драйверы и хранилище сессий; локальные endpoints изолируют платную модель. Результаты конкретного выпуска, сценарии и команды получения кадров находятся в [отчёте о побочных вопросах](contributors/reports/model-requests.md). Внутренние контракты и бюджеты описаны в [архитектуре](architecture.md#запросы-модели-и-побочные-вопросы).

## Рабочие копии: разработка и проверки

Работайте непосредственно в main. Управляемые detached worktrees — функция приложения; интеграционные тесты создают Git-репозитории только во временных каталогах, вне checkout ChiselCode.

```sh
bun test tests/integration/worktrees-runtime.test.ts tests/integration/worktrees-tui.test.ts
bun tests/fixtures/worktree-cli.ts bun src/cli.ts
bun tests/fixtures/command-packaging.ts
```

Для установленного пакета или скомпилированного бинарника замените executable/prefix в тестовом запуске CLI. Git, файлы, EditingService и executor в этих сценариях настоящие; модель изолирована локальным endpoint. Результаты, барьеры аварийных проверок, пределы и команды получения кадров находятся в [отчёте о рабочих копиях](contributors/reports/worktrees.md).

Внутренний service token предоставляет порт, привязанный к root; invocation получает identity/signal и узкие порты tools/open. Core определяет идентичность репозитория, управляемый путь, base, разрешение изменения, блокировки, реестр, prepare/execute, откат и удержанные ссылки. Подробности — [контракт сервиса](architecture.md#сервис-рабочих-копий). Дочерний runtime и делегирование описаны в [руководстве помощников](subagents.md), а внешние пакеты — в [SDK и загрузчике](extensions/README.md).

## UI-композиция и создание расширений

[Публичный контракт](extensions/ui-composition.md) и [архитектурное решение](architecture/ui-contributions.md#композиция-и-live-ui) доступны начиная с 0.6.33. Пример `examples/extensions/workbench` не требует сборки. `bun tests/fixtures/tui-extension-creator.ts` проверяет scripted-provider → load_skill/create_extension → managed install → реальный Settings trust/live enable → UI actions/permissions → settings/disable. Это проверка runtime и поставки, не оценка качества произвольной модели. [Кадры и фактические проверки](contributors/reports/ui-composition.md).

## Единое графическое оформление OpenTUI

Начиная с CLI 0.6.34 удалены ASCII-ветки, context переключения оформления и соответствующая настройка. `TerminalScrollbox` задаёт общие defaults нативного ползунка. `GlobalConfigV2Schema` отбрасывает прежнее поле `ui.unicodeDecorations`, сохраняя неизвестные поля и остальные настройки. Alternate-screen и split-footer используют один renderer и это оформление.

`bun test tests/integration/graphics-runtime.test.ts` запускает production `runOpenTuiAgent` с прежним `false`, проверяет тёмную/светлую темы, настройки, черновик, фокус и resize до 24×8. Для кадров: `CHISEL_GRAPHICS_CAPTURES=docs/assets/opentui-graphics bun tests/fixtures/tui-graphics.ts`; для Paper добавьте `CHISEL_CAPTURE_THEME=paper`. [Решение, кадры и фактические проверки](contributors/reports/opentui-graphics.md).
