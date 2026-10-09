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
bun scripts/prepare-lsp-tests.ts
bun run typecheck
bun test
bun run lint
bun run eval --category all
bun run build
```

| Команда | Что проверяет или создаёт |
| --- | --- |
| `bun run typecheck` | Типы TypeScript без генерации файлов |
| `bun test` | Unit- и integration-тесты |
| `bun run lint` | Biome для `src`, `tests` и `evals` |
| `bun run eval --category all` | Все deterministic offline runtime evals |
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

Контракт services/context/guards/tools/commands и рабочий пример — в [архитектуре](architecture.md#границы-расширений). `ctx.tools.register(defineTool(...))` и `ctx.commands.register({ name, description, usage, parse, execute })` работают только во время activation. Для tools core присваивает `ext:<extensionId>:<localName>` и source. Slash head имеет отдельную identity `{ type: "extension", extensionId, name }`, без wire namespace. Built-in/skill/extension name conflicts отклоняются явно. Contributions исполняются общим executor с Plan/permissions/EditingService/artifacts. Регистрации автоматически принадлежат workspace; вручную добавлять их в `ctx.add` не нужно. `ctx.add` применяется к ресурсам/service cleanup. Prompt/command tool binding временный, borrowed workspace переживает операции.

Production composition включает `defaultExtensions([], { configPath })` с manifest, LSP и /btw consumers; custom linked definitions объединяйте явно через `defaultExtensions([example])`. Для изолированных tests можно использовать точный список или пустой `ExtensionHost([])`. Command example в архитектуре показывает регистрацию, parse без shell evaluation и `invocation.tools.execute` с canonical именем. Этот port сохраняет policy/checkpoints, не требует model API key и не даёт callback доступ к Session/catalog/approval resolver/UI. Command output не становится model message; ToolExecutionResult с error/pending/artifact следует возвращать без потери этих полей. Пользовательский JS loader/SDK пока отсутствует; trusted code работает с правами процесса, callbacks обязаны соблюдать signal и не выполнять mutations в prepare. P1.3 добавляет настоящие status/restart contributions builtin.lsp; пользовательский loader по-прежнему отсутствует.

Acceptance tests используют реальные host/catalog/executor/policy/coordinator/storage и deterministic providers. Packaging harness поднимает локальный тестовый model endpoint, отправляет обычный Plan prompt и проверяет цикл model → manifest → model → checkpoint; production test flags/autoload fixtures отсутствуют:

```bash
bun tests/fixtures/manifest-cli.ts bun ./dist/cli.js
bun tests/fixtures/manifest-cli.ts bun ./dist/install-smoke/node_modules/chiselcode/dist/cli.js
bun tests/fixtures/manifest-cli.ts ./dist/chisel
```

Последние две команды запускаются после `npm pack`/установки и `bun run compile`. Windows compiled binary — `dist/chisel.exe`. CI matrix выполняет тот же manifest smoke для установленного пакета и compiled CLI на Windows/macOS/Linux; `--version`/`doctor` остаются отдельными проверками запуска. Harness не обращается к live LLM и не изменяет пользовательские credentials/config.

Command acceptance fixture явно передаёт linked extension настоящему TUI application, использует OpenTUI test renderer и реальные files/executor/store. Проверяются welcome/autocomplete, exactly-once dispatch без ключа модели, approvals/Plan/guards, очередь commands/prompts, соседние вкладки, Ctrl+C, artifact и checkpoint. Один специально queued ordinary prompt использует локальный deterministic model endpoint; commands не вызывают chat. Fixture запускается из исходников и может быть собрана тем же Bun pipeline:

```bash
bun tests/fixtures/tui-command-contributions.ts
bun build tests/fixtures/tui-command-contributions.ts --outdir ./dist/command-smoke --target bun --external '@opentui/core-*'
bun ./dist/command-smoke/tui-command-contributions.js
bun build tests/fixtures/tui-command-contributions.ts --compile --outfile ./dist/command-smoke/linked-tui
./dist/command-smoke/linked-tui
```

Это test-only linked build, не loader установленного CLI. Не включайте `dist/command-smoke` в публикуемый package. После `bun run build` команда `bun tests/fixtures/command-packaging.ts` собирает fixture в отдельный staging package, выполняет `npm pack`/install и тот же TUI сценарий из установленного bundle, затем из compiled binary. CI запускает этот harness на Windows/macOS/Linux; он не меняет production package или lockfile. На Windows compiled fixture имеет суффикс `.exe`. Command feedback остаётся UI projection; restart не запускает callback заново.

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

## Проверки LSP и Settings

`bun scripts/prepare-lsp-tests.ts` явно устанавливает test-only server 6.0.1/TypeScript 6.0.3 во внешний temporary runtime. Node 24.19.0 используется CI; local Node должен соответствовать >=22.22.2. При отсутствии installation real tests завершаются setup error, не skip. `CHISEL_TEST_LSP_ROOT` и `CHISEL_TEST_LSP_NODE` меняют только test harness; production не импортирует эти helpers и не выдаёт fixture trust.

`lsp-runtime.test.ts` проверяет и bundled Auto без paths/trust/Node setup, и custom backend через ordinary composition/executor/permissions/EditingService/store: TS error → read observation → valid edit → observed update, navigation, shared generation, Plan/deny/restart/revocation. Protocol peer используется отдельно для byte framing, old/versionless pushes, provisional empty, Full/Incremental, cancellation/EOF/crash/caps/cache и process-tree cleanup. Его metadata fixture и installation не попадают в release.

`lsp-tui.test.ts` выполняет default Auto → lazy diagnostics без paths/trust → Off/child cleanup, затем custom friendly form → read-only check → typed save → explicit trust → normal approval/start → diagnostics/edit → revoke через настоящие OpenTUI inputs. Model chat/key не нужен. Native captures можно получить test-only переменной, без production autoload/flags:

```bash
CHISEL_TEST_LSP_CAPTURES=/absolute/capture-directory bun tests/fixtures/tui-lsp-settings.ts
bun tests/fixtures/lsp-cli.ts bun ./dist/cli.js
bun tests/fixtures/command-packaging.ts
```

CLI smoke использует локальный scripted provider endpoint, real Auto LSP schemas/wire history/tool/result/context/checkpoint без LSP section в config. Packaging harness проверяет linked commands и Auto/custom Settings scenario в installed staging package и compiled binary. Ordinary installed/compiled CLI выполняет `lsp-cli.ts` в CI на трёх OS без внешнего Node/server для Auto. `--version`/doctor недостаточно для доказательства contribution.

Стандартный payload содержит official TLS 6.0.1, TS 6.0.3 и их licenses/notices; воспроизводимое обновление описано в `src/lsp/backend/README.md`. Это единственный bundled backend asset (~3.6 MB gzip). Многоязычная preparation использует pinned `fflate`/`tar-stream` для bounded archives; dev TypeScript не заменяет runtime backend. Проверяйте assets при `npm pack`, работу из произвольного cwd и Bun `BUN_BE_BUN` в compiled executable. Auto не импортирует test installation.

`lsp-auto-check-changes` в `eval --category all`/`coding` использует закреплённый настоящий Auto backend и scripted model: definition → references → symbols → diagnostics → EditingService edit → diagnostics → tests. Model network и LSP setup не нужны. Fixture получает isolated config через тот же default extension host/provider binding; providers/context и cleanup остаются настоящими.

Settings visual review: реальные OpenTUI frames при 120×40, 100×30, 80×24, 60×20, 40×12, 24×8; native cursor сохраняется при resize длинного path. Reference patterns — категории/filter и focus zones из [OpenTUI example browser](https://github.com/anomalyco/opentui/blob/main/packages/examples/src/index.ts), installed-compatible [layout](https://opentui.com/docs/core-concepts/layout/) и [interaction](https://opentui.com/docs/core-concepts/interaction/). Routes/search/drafts не зависят от labels или secret values. OpenCode URLs из design brief могут быть недоступны; их configuration model не переносится. OpenTUI/React версии не обновлены.

### Многоязычный LSP каталог

`src/lsp/catalog.ts` связывает language IDs/extensions/project markers с reviewed installation recipe. Добавление стандартного сервера требует фиксированных URL/integrity в `release-assets.json` или npm/gem lock, license review и real-server test. Runtime не запрашивает latest version. Обновление locks выполняет maintainer, приложение не выполняет package discovery/import из проекта.

`bun scripts/prepare-lsp-tests.ts` заранее готовит pinned external TS и Auto Pyright/Lua. `bun test tests/integration/lsp-multilingual.test.ts` запускает настоящий core executor, сохранение session/source, real Pyright/Lua, navigation, EditingService и revocation; fake stdio peer проверяет generic language/trust/cancellation локально. `bun tests/fixtures/multi-lsp-probe.ts python go rust cpp csharp java kotlin php lua dart html css json yaml bash docker ruby` проверяет реальные backend; Ruby нужен SDK/build prerequisites, Swift проверяется на macOS/Xcode. Failure не скрывается skip; unavailable provenance не подменяется error-free.

`tests/fixtures/lsp-cli.ts` вызывает ordinary npm/compiled CLI с локальным deterministic model endpoint и настоящими TS/Pyright через production default composition. Test fixture не импортируется release entry point и не требует production test flags. Packaging/TUI smoke остаётся `bun tests/fixtures/command-packaging.ts`.

CI job `Real Auto LSP` выполняет `bun tests/fixtures/multi-lsp-probe.ts python go rust cpp csharp java kotlin php ruby lua dart html css json yaml bash docker` на Linux/macOS/Windows; macOS также проверяет настоящий SourceKit-LSP из Xcode. Ruby 3.4.11 SDK устанавливается только test setup. Probe требует настоящий initialize и symbols; проверяет diagnostics для заданных errors и definitions у поддерживающих их backends, затем закрывает service. Kotlin diagnostics без evidence остаются unavailable, а не фиктивным success. Для локальной проверки конкретного backend передайте его fixture name. Standard preparation не читает latest metadata: все используемые package bytes закреплены locks/integrity.

Во время первоначальной загрузки crates/VFS rust-analyzer может отклонить read request при замене snapshot. Native harness допускает не более двух повторов такого чтения с паузой 250 ms. Он сохраняет проверки настоящих diagnostics/symbols/definitions; повторные ошибки завершают job failure. Cancellation, unsupported capabilities, malformed reports и другие ошибки не получают этот retry. Runtime tool failure остаётся настоящим terminal result; harness не меняет production execution, не перезапускает сервер и не повторяет mutations.

## P1.4: внутренние model requests

Пример linked contribution (registration только в activation):

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

Core выдаёт readonly identity/signal/model port без tools, credentials/SDK, Session и renderer. Observer получает только sanitized typed text/status/terminal events с core owner; он не перенаправляет вывод. Права tools не появляются из model request. Foreground contribution без `executionPolicy` продолжает идти через conversation queue и может использовать lazy model port наряду с tools port; чистые local callbacks не требуют модели. API linked/internal, внешний SDK/loader и UI slots здесь не появляются.

Проверки P1.4 используют настоящее приложение, builtin consumer, оба HTTP protocol drivers, session storage и OpenTUI renderer. Main endpoint barrier и approval остаются активными, пока /btw завершается; hide/reopen/resume не делают requests. Offline tests проверяют actual HTTP attempts (SDK retry layer выключен), no-auth custom definitions, protocol/partial/auth failures, limits, late usage, split credentials, concurrent checkpoint merge и interrupted retention.

```sh
bun test tests/unit/model-requests.test.ts tests/unit/side-query-storage.test.ts
bun test tests/unit/opentui-side-query.test.tsx tests/integration/side-query-tui.test.ts tests/integration/side-query-cli.test.ts
CHISEL_CAPTURE_DIR=/absolute/captures bun tests/fixtures/tui-side-query.ts
CHISEL_CAPTURE_DIR=/absolute/captures bun test tests/unit/opentui-side-query.test.tsx
bun tests/fixtures/side-query-cli.ts bun ./dist/cli.js
bun tests/fixtures/command-packaging.ts
```

Capture variables относятся только к test fixtures, не к production flags/autoload. Captures — реальные `captureCharFrame` и `captureSpans` с RGBA/геометрией, размеры 120×40, 100×30, 80×24, 60×20, 40×12, 24×8; dark/Paper, Unicode/ASCII, receiving/completed/error/draft/focused/hidden/approval. Packaging harness запускает default builtin /btw view в installed staging package и compiled runtime; обычные npm/compiled CLI smoke используют тот же command dispatch без source imports/fixtures внутри production. CI matrix сохраняет Windows/macOS/Linux и real pinned LSP regressions.

UI reuse: shared OpenTuiDialog/DialogAction/Palette, native textarea, FormattedMessage и TerminalScrollbox; explicit keyboard-owner capture перед global listeners дополнен focus props. Installed OpenTUI 0.5.12 `KeyHandler.emitWithPriority`, `preventDefault/stopPropagation` и `prependListener` проверены напрямую. Ориентиры: [official interaction/focus](https://opentui.com/docs/core-concepts/interaction/), [layout](https://opentui.com/docs/core-concepts/layout/); яркие debug colors/отдельная дизайн-система не переносились.
