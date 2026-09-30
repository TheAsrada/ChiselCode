# Пользовательские провайдеры

[Документация](README.md) · [Providers](providers.md) · [Архитектура](architecture.md)

## Что такое custom provider

Declarative definition конкретного сервиса на поддерживаемом API. Это данные для bundled protocol driver, а не plugin с исполняемым кодом. Новый gateway подключается без изменения source, rebuild или npm install.

## Где находится каталог providers

`ChiselCode Home/providers/` создаётся автоматически и пуст по умолчанию. Windows: %LOCALAPPDATA%/ChiselCode/providers; macOS/Linux: $XDG_DATA_HOME/chiselcode/providers или ~/.local/share/chiselcode/providers. Built-ins и credentials туда не копируются.

## chisel providers path

```bash
chisel providers path
```

Печатает реальный абсолютный путь и создаёт Home layout. Не вычисляйте XDG/AppData путь вручную.

## Поддерживаемые типы providers

OpenAI-compatible gateways, corporate proxies, local servers и Anthropic-compatible services. Если API не совместим с openai-chat или anthropic-messages, одного manifest недостаточно.

## Быстрый старт

Создайте example-gateway/provider.json в выведенном каталоге:

```json
{
  "schemaVersion": 1,
  "id": "example/gateway",
  "label": "Example Gateway",
  "driver": "openai-chat",
  "auth": { "required": true, "envVars": ["EXAMPLE_API_KEY"] },
  "endpoint": { "required": false, "defaultBaseUrl": "https://api.example.com/v1", "normalization": "openai-v1" },
  "defaults": { "model": "example-coder" },
  "capabilities": { "modelListing": true, "tokenCounting": "unsupported", "usageReporting": "unknown", "toolCalling": true, "thinking": false }
}
```

```bash
chisel providers validate
chisel providers list
chisel setup --provider example/gateway --profile example-work
chisel --profile example-work "Объясни проект"
```

example.com — placeholder: замените endpoint/model на реальные параметры своего API. В setup найдите provider по ID/label, введите ключ или используйте EXAMPLE_API_KEY, сохраните profile. После изменения manifests перезапустите ChiselCode.

## Структура provider package

```text
providers/
└── example-gateway/
    └── provider.json
```

Только immediate child directories. Recursive discovery нет. Folder name — deployment detail, manifest.id — persistent identity. Лишние файлы, включая index.js, не исполняются.

## provider.json

Обычный UTF-8 JSON до 256 KiB. Обязательная schemaVersion=1. Optional description, author, homepage, license информационные; network на homepage не выполняется. Unknown top-level fields отклоняются; driverOptions проверяется driver. Не помещайте секреты ни на верхний уровень, ни внутрь options.

## Manifest schema

| Поле | Contract |
| --- | --- |
| schemaVersion | Только 1 |
| id | Namespaced ID |
| label | Непустая строка до 100 символов |
| description | Optional, до 500 символов |
| driver | ID зарегистрированного protocol driver |
| auth | required boolean; envVars array до 10 имён |
| endpoint | required boolean; optional HTTP(S) defaultBaseUrl; normalization policy |
| defaults | Optional model в объекте |
| capabilities | modelListing, tokenCounting, usageReporting, toolCalling, thinking |
| driverOptions | Optional object, validated by selected driver |
| author/homepage/license | Optional informational strings; homepage URL |

## Provider ID и namespace

Формат `^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$`: acme/gateway, local/ollama. Не ../, не absolute path, не встроенные anthropic/openai/agentrouter. Namespace slash не означает вложенную папку.

## Driver

| Driver | API | Auth | Endpoint |
| --- | --- | --- | --- |
| openai-chat | POST /chat/completions, streaming; optional GET /models | Bearer token | Например https://api.example/v1 |
| anthropic-messages | POST /v1/messages; optional GET /v1/models и token count | x-api-key или bearer option | Корень сервера |

streamChat поддерживает tool calls, usage, thinking deltas и cancellation. OpenAI Responses API и произвольные protocols не реализованы. Реальный gateway должен поддерживать ожидаемые stream termination и tool formats.

### driverOptions

openai-chat:

- includeUsage boolean, default false: отправлять stream_options.include_usage.
- tokenLimitFallback boolean, default true для declarative driver: один retry с max_tokens после соответствующей 400 на max_completion_tokens. Official OpenAI definition явно отключает fallback.

anthropic-messages:

- authMode: api-key (default) или bearer.
- adaptiveThinking boolean, default false: adaptive thinking / high effort, только если сервер их понимает.
- nativeTokenCounting boolean: default из tokenCounting capability; true включает model metadata/count endpoint. Не заявляйте native там, где endpoints отсутствуют.

Другие options, включая fetch, headers, JS paths или arbitrary SDK flags, отклоняются. Options — данные, не способ загрузить код.

## OpenAI-compatible provider

Используйте quick-start example. Для локального сервера: defaultBaseUrl="http://localhost:11434/v1", auth.required=false, envVars=[], model — точный ID локальной модели. Если /models нет, modelListing=false; вводите model вручную. Передача tool schemas требует совместимой модели и сервера.

## Anthropic-compatible provider

```json
{
  "schemaVersion": 1,
  "id": "example/anthropic-proxy",
  "label": "Example Messages Proxy",
  "driver": "anthropic-messages",
  "auth": { "required": true, "envVars": ["EXAMPLE_AUTH_TOKEN"] },
  "endpoint": { "required": false, "defaultBaseUrl": "https://messages.example.com", "normalization": "anthropic-root" },
  "defaults": { "model": "proxy-coder" },
  "capabilities": { "modelListing": false, "tokenCounting": "unsupported", "usageReporting": "final", "toolCalling": true, "thinking": false },
  "driverOptions": { "authMode": "bearer" }
}
```

Anthropic-root убирает конечный /v1; SDK дописывает /v1/messages. Для x-api-key используйте authMode=api-key. Adaptive thinking не включается автоматически.

## Authentication

Manifest задаёт required/envVars, profile — apiKeyRef, CredentialStore — secret. При auth.required=false реальный ключ не обязателен; SDK использует служебное значение при отсутствии credential. Не используйте manifests как хранилище секретов.

## Environment variables

Только имена вида `^[A-Z_][A-Z0-9_]*$`, не значения. Resolver выбирает первую непустую переменную по порядку. Env credential имеет приоритет над сохранённым; transient key из текущей проверки выше env.

## Profiles

```json
{
  "schemaVersion": 2,
  "defaultProfileId": "corp-ai",
  "profiles": {
    "corp-ai": { "providerId": "example/gateway", "apiKeyRef": "corp-ai", "defaultModel": "example-coder" }
  }
}
```

Несколько profiles одного provider независимы. Создайте их через setup --profile или «Новый профиль» в /settings. Выберите через --profile или «Профиль». apiKeyRef не обязан совпадать с profile ID: старые ссылки сохраняются.

## Models

--model → profile.defaultModel → manifest.defaults.model → controlled error. Нет default model — выберите вручную; modelListing optional. Удалённый manifest не удаляет profile/history, но новые requests blocked provider unavailable.

## Endpoint normalization

none сохраняет путь после удаления trailing slash; openai-v1 добавляет /v1 голому host; anthropic-root убирает конечный /v1. Profile.baseUrl или --base-url переопределяет defaultBaseUrl. Без effective endpoint runtime возвращает controlled invalid_endpoint; укажите defaultBaseUrl или profile.baseUrl. Только HTTP(S), без embedded credentials/query/fragment. HTTP localhost допустим; remote HTTP получает warning и может раскрыть keys/prompts.

## Capabilities

modelListing boolean управляет availability списка. tokenCounting native/unsupported, usageReporting stream/final/unknown, toolCalling boolean и thinking boolean описывают сервис. Не заявляйте unsupported server features. Context window не угадывается по model name. Стоимость неизвестного provider — unknown, не zero.

## Проверка через chisel providers validate

Offline проверяет JSON/schema/namespace/duplicate IDs/drivers/options/URL/env vars/size/symlinks. Exit 0 при отсутствии errors, 1 при errors; warning remote HTTP не failure. Не проверяет доступность API или credential. Broken package пропускается, приложение с built-ins работает.

## Diagnostics

Structured severity/code/path/providerId/message: manifest_invalid, manifest_too_large, reserved_id, duplicate_id, unknown_driver, unsupported_schema, unsafe_symlink, invalid_driver_options; insecure_endpoint — warning. Values секрета и сырой JSON в diagnostics не выводятся. Missing provider.json диагностируется; исправьте файл и перезапустите.

## Duplicate IDs

Два packages с одним custom ID отключаются оба. Filesystem order не выбирает победителя. Built-in ID никогда не override.

## Manifest versioning

Поддерживается только schemaVersion=1. Будущая 2 получает unsupported_schema; формат не угадывается.

## Безопасность

Discovery не получает credentials, не делает network requests и не создаёт SDK clients. Regular manifest file до 256 KiB, package/manifest symlinks и junctions запрещены. ID не применяется как path. API key/token/secret/password/authorization fields запрещены рекурсивно. Manifest может направить будущие запросы к указанному API: проверяйте endpoint перед сохранением ключа.

## Ограничения v1

Нет filesystem watcher, remote manifests, marketplace, npm install, executable drivers, tools/hooks, shell или arbitrary file access. Catalog обновляется после restart. Совместимый protocol не гарантирует одинаковые model/tool capabilities.

## Почему произвольный JavaScript не запускается

Driver потенциально видит credentials/prompts/history и имеет network/process privileges. Наличие index.js не означает доверие. Будущие executable drivers потребуют explicit install/trust digest и отдельного security design; worker process не является автоматически sandbox.

## Как добавить новый protocol driver

Реализуйте ProviderDriver в src/providers/drivers/, validateDefinition для options, create(context) → ProviderAdapter. Зарегистрируйте в DriverRegistry, добавьте shared conformance tests и эту документацию. streamChat обязателен; остальные методы optional. SDK-specific ошибки должны стать ProviderError; signal отменяет stream. Generic config/sessions/UI/core не меняются. Новый bundled driver станет доступен manifests после обновления ChiselCode; arbitrary executable drivers из Home/providers сейчас не загружаются.

## Compatibility

Старые config v1 и sessions v2 читаются lazy. credentials.enc и apiKeyRef не мигрируют. Built-in IDs сохранены, --provider остаётся supported compatibility flag. После удаления manifest config/profile/session остаются читаемыми. [Migration notes](provider-migration.md) описывают backups и запись файлов.
