# Провайдеры и API-ключи

[Документация](README.md) · [Главная](../README.md)

## Выбор сервиса

Запустите `chisel setup` или откройте `/settings`. В мастере доступны пять вариантов:

| № | Сервис | Значение `--provider` | Ключ из окружения |
| --- | --- | --- | --- |
| 1 | Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| 2 | OpenAI | `openai` | `OPENAI_API_KEY` |
| 3 | OpenAI-совместимый API | `openai-compatible` | `OPENAI_API_KEY` |
| 4 | Anthropic-совместимый прокси | `anthropic-compatible` | `ANTHROPIC_AUTH_TOKEN` |
| 5 | AgentRouter | `agentrouter` | `AGENTROUTER_API_KEY` |

Имена моделей берите из консоли вашего сервиса или списка в `/model`: доступность зависит от аккаунта и шлюза. Не используйте название модели другого провайдера без проверки.

## Где получить ключ

- Anthropic: [консоль Anthropic](https://console.anthropic.com/).
- OpenAI: [API-ключи OpenAI Platform](https://platform.openai.com/api-keys).
- AgentRouter: [консоль токенов](https://agentrouter.org/console/token).
- Совместимый API: ключ или токен выдаёт оператор сервера.

Ключ из соответствующей переменной окружения имеет приоритет над сохранённым ключом. Если замена ключа в мастере не помогает, проверьте окружение терминала. Для ввода секрета предпочтителен мастер: он не помещает ключ в аргументы командной строки.

## Адрес API

| Режим | Пример базового адреса | Протокол |
| --- | --- | --- |
| OpenAI-compatible | `https://proxy.example.com/v1` | Chat Completions |
| Локальный OpenAI-compatible | `http://localhost:11434/v1` | Chat Completions |
| Anthropic-compatible | `https://proxy.example.com` | Anthropic Messages (`/v1/messages`) |
| AgentRouter | `https://agentrouter.org/v1` | OpenAI-совместимый адаптер |

Для OpenAI-совместимого адреса без пути приложение добавляет `/v1`; произвольный путь сохраняет. Для Anthropic-совместимого адреса убирает конечный `/v1`, чтобы SDK не продублировал его. Не вставляйте полный URL конкретного endpoint вместо базового адреса.

Anthropic-compatible передаёт токен через `Authorization: Bearer …`. Если прокси уже используется в другом клиенте с `ANTHROPIC_BASE_URL`, перенесите адрес в мастер ChiselCode или `--base-url`: автоматическое чтение этой переменной здесь не является интерфейсом настройки.

## Локальные модели

Выберите `openai-compatible`, запустите локальный сервер и укажите точный ID загруженной модели. Сервер должен поддерживать нужный API, а модель — работу с инструментами для агентных задач. Текущая реализация требует непустой ключ и для совместимого API; для сервера без аутентификации используйте непустое служебное значение, если это допускает сам сервер.

## Проверка подключения

- `chisel doctor` и `/doctor` проверяют локальную настройку и наличие ключа; это не тест реального запроса к модели.
- «Проверить подключение» в `/settings` запрашивает список моделей. Успех подтверждает доступ к этому endpoint, но не гарантирует поддержку всех инструментов или успешную генерацию.
- Завершите проверку коротким запросом в чате.

При 401 проверьте ключ; при 404 — режим и адрес API; при ошибке модели — её ID. Подробнее — [решение проблем](troubleshooting.md).

## Каталог definitions

Metadata встроенных сервисов хранится в `src/providers/definitions/`: labels, env vars, endpoints, default models и capabilities. `ProviderRegistry` поддерживает открытые string IDs и поиск по ID, label и description. Новые protocol drivers регистрируются отдельно в DriverRegistry. До миграции CLI/config прежние команды и формат настроек сохраняются.

AgentRouter использует generic `openai-chat` driver с `tokenLimitFallback=true`; отдельной реализации протокола нет. Официальный OpenAI задаёт includeUsage; официальный Anthropic — adaptiveThinking и nativeTokenCounting. Compatible definitions отключают неподдерживаемые расширения.

Runtime использует endpoint policies `none`, `openai-v1`, `anthropic-root`. Profile baseUrl переопределяет definition default. Значение должно быть HTTP(S) без userinfo, query и fragment. Необязательный health API имеет приоритет над model listing; отсутствие обоих означает unsupported, а не failure.

Profile IDs отделены от provider IDs. CLI runtime выбирает --profile или единственный profile по compatibility --provider. Глобальная модель другого provider больше не применяется. Для первоначального запуска настройте профиль через setup; одного env key без profile недостаточно для новой сессии.

Setup/settings получают весь каталог из ProviderRegistry, включая custom definitions. Selector ищет по id/label/description, показывает ограниченное окно, поддерживает ↑/↓, Enter, Escape. Пункт «Профиль» переключает аккаунты; «Новый профиль» запрашивает уникальный ID. `chisel setup --provider openai --profile openai-work` создаёт/редактирует именно этот профиль. Смена провайдера сбрасывает несохранённый ключ и выбирает definition default model. Несколько profiles требуют явного выбора; credentials сохраняются отдельно по apiKeyRef.

## Capabilities и стоимость

Definition описывает modelListing, tokenCounting(native/unsupported), usageReporting(stream/final/unknown), toolCalling и thinking. Model capabilities отдельно сообщают только известный context window/output limit. Отсутствие metadata не создаёт выдуманный window. Custom definitions с modelListing=false не требуют /models; модель вводится вручную. Health: checkConnection → listModels → unsupported, последнее не является failure.

Unknown pricing означает `{source:"unknown"}` без usd. Прежний эвристический расчёт по substring модели удалён. Официальный Anthropic сохраняет ориентировочные rates v0.6.0 только для точных claude-opus-5 (5/25 USD за миллион input/output) и claude-sonnet-5 (2/10); source=estimated, это не billing API. Остальные providers/models unknown. Сессия сохраняет старый known subtotal для совместимости, но UI/JSON/evals не показывают его как полный $0, если total неизвестен.
