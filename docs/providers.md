# Провайдеры, profiles и API-ключи

[Документация](README.md) · [Главная](../README.md) · [Custom providers](custom-providers.md)

## Каталог и выбор

Provider — сервис; protocol driver — реализация API; profile — отдельный аккаунт и его настройки. Один driver обслуживает множество providers, один provider может иметь несколько profiles. Catalog включает встроенные definitions и пользовательские manifests. Актуальный каталог показывает `chisel providers list`; source of truth metadata — `src/providers/definitions/` и provider.json, а не UI/CLI lists.

Встроенные definitions версии 0.6.1:

| Provider ID | Label | Driver | Env var | Default model | Default endpoint |
| --- | --- | --- | --- | --- | --- |
| `anthropic` | Anthropic | `anthropic-messages` | `ANTHROPIC_API_KEY` | `claude-opus-5` | `https://api.anthropic.com` |
| `anthropic-compatible` | Anthropic-совместимый API | `anthropic-messages` | `ANTHROPIC_AUTH_TOKEN` | ручной выбор | требуется profile.baseUrl |
| `openai` | OpenAI | `openai-chat` | `OPENAI_API_KEY` | `gpt-5` | `https://api.openai.com/v1` |
| `openai-compatible` | OpenAI-совместимый API | `openai-chat` | `OPENAI_API_KEY` | ручной выбор | требуется profile.baseUrl |
| `agentrouter` | AgentRouter | `openai-chat` | `AGENTROUTER_API_KEY` | `claude-opus-5` | `https://agentrouter.org/v1` |

В setup/settings доступны поиск по id/label/description, ограниченное окно, ↑/↓, Enter, Escape. Custom provider автоматически появляется в том же selector. Никакого числового закрытого каталога нет.

## Profiles и models

```bash
chisel setup --provider openai --profile openai-work
chisel setup --provider openai --profile openai-personal
chisel --profile openai-work "Объясни проект"
```

«Профиль» в /settings выбирает аккаунт; «Новый профиль» запрашивает уникальный ID. apiKeyRef, defaultModel и baseUrl независимы. Смена provider сбрасывает несохранённый ключ и выбирает definition default model. Если profiles несколько, требуется явный выбор.

Модель новой сессии: --model → profile.defaultModel → definition.defaults.model → controlled error/manual selection. Имена берите из консоли или /model; доступность зависит от сервиса и аккаунта. При resume без overrides используются profile/model сессии. Старый --provider работает с единственным настроенным profile; при нескольких требует --profile, при отсутствии предлагает setup. Env key не заменяет profile configuration.

## Authentication

Приоритет: ключ, введённый для проверки текущих настроек → первая непустая definition env var → profile.apiKeyRef в CredentialStore. Definition/manifest не содержит секретов. Config/session migration не расшифровывает и не перемещает credentials.enc. Существующие apiKeyRef сохраняются.

Anthropic: console.anthropic.com; OpenAI: platform.openai.com/api-keys; AgentRouter: agentrouter.org/console/token. Совместимый сервер выдаёт свой ключ. Мастер маскирует ввод; auth set передаёт секрет в argv и не рекомендуется для ручного ввода. Env var имеет приоритет над сохранённым ключом, поэтому при замене ключа проверяйте окружение.

Все пять built-ins требуют ключ. Для локального сервера без auth можно использовать custom manifest с auth.required=false; тогда реального ключа не требуется. У compatible built-in остаётся прежняя поддержка непустого служебного ключа, если сервер это допускает.

## Endpoints

Profile.baseUrl и --base-url переопределяют definition endpoint, в том числе официальных APIs. Без effective endpoint — controlled invalid_endpoint, SDK defaults не выбирают чужой сервис. Endpoint должен быть HTTP(S), без userinfo, query и fragment. Policies:

| Policy | Поведение |
| --- | --- |
| none | Удалить trailing slashes, сохранить путь |
| openai-v1 | Голому хосту добавить /v1; существующий путь сохранить |
| anthropic-root | Удалить конечный /v1; SDK добавит /v1/messages |

Официальные Anthropic/OpenAI используют none; совместимые definitions — соответствующую policy; AgentRouter — openai-v1. Не указывайте полный URL /chat/completions или /messages. HTTP localhost разрешён; remote HTTP manifest получает warning о передаче key/prompts без TLS. ANTHROPIC_BASE_URL автоматически не читается: укажите адрес в profile/setup или --base-url.

## Drivers и AgentRouter

`openai-chat` использует Chat Completions, streaming, ordered tool calls и reasoning deltas. OpenAI Responses API не реализован. includeUsage включает stream_options.include_usage. tokenLimitFallback допускает один повтор при 400 о max_completion_tokens с max_tokens; official OpenAI выключает его, gateways включают. AgentRouter — definition поверх generic OpenAI driver, без собственного wire adapter.

`anthropic-messages` использует Messages API, tool translation, streaming и optional native token count. authMode=api-key использует x-api-key; bearer — Authorization. adaptiveThinking и nativeTokenCounting явно задаются options/capabilities. Совместимые шлюзы не получают adaptive thinking автоматически.

## Capabilities и health

Definition.capabilities: modelListing, tokenCounting(native/unsupported), usageReporting(stream/final/unknown), toolCalling, thinking. Все built-ins перечисляют модели и поддерживают tool calling; Anthropic-compatible не заявляет thinking. Native token counting — у official Anthropic; остальные unsupported. Usage Anthropic — final, OpenAI-compatible — stream. Model capabilities отдельно сообщают только известные contextWindow/maxOutputTokens: неизвестный window не выдумывается.

Health: checkConnection → listModels → unsupported. Последнее не означает failure. modelListing=false позволяет ручной выбор модели без /models. «Проверить подключение» не гарантирует tool compatibility или успешную генерацию; проверьте коротким запросом. doctor и /doctor проверяют локальную настройку без API-запросов.

## Стоимость

CostEstimate содержит optional usd и source(provider/estimated/unknown). Unknown pricing не считается $0. Сохранены ориентировочные rates старой 0.6.0 только для точных official Anthropic claude-opus-5 (5/25 USD за миллион input/output) и claude-sonnet-5 (2/10); это estimated, не billing API. Неизвестные модели и остальные providers показывают unknown. Эти оценки не учитывают все cache discounts и изменения тарифов.

Legacy totalCost хранит известный subtotal для compatibility. Когда цена хотя бы части запросов неизвестна, UI/JSON/evals не выдают subtotal за полный total. Старые ненулевые totals остаются estimated; legacy zero не становится доказательством бесплатного запроса.

## How to add a new provider

Для встроенного сервиса на существующем protocol: создайте ProviderDefinition в definitions/, зарегистрируйте в definitions/index.ts, добавьте contract/runtime test и обновите эту справку. Label, env vars, endpoint, default model, capabilities и options принадлежат definition. Не меняйте run-prompt, core, UI, config/session schemas или CLI validation. Для пользовательского сервиса достаточно [provider.json](custom-providers.md), без rebuild.

## How to add a new protocol driver

Реализуйте ProviderDriver(id, optional validateDefinition, create(context)) в drivers/, зарегистрируйте в createDriverRegistry, добавьте conformance tests и документацию. Adapter обязан иметь providerId и streamChat(request); listModels/countTokens/checkConnection/getCapabilities optional. Driver владеет SDK, request/response translation, cancellation и error normalization; не хранит пользовательский config. Проверьте text, multiple tools, malformed arguments, termination, refusal, usage, limits, abort и errors. После регистрации driver доступен и пользовательским manifests. Home/providers не загружает executable drivers.
