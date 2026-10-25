<a id="что-такое-custom-provider"></a>
<a id="поддерживаемые-типы-providers"></a>

# Пользовательские провайдеры

[Документация](README.md) · [Подключение сервиса](providers.md) · [Контракт manifest](architecture/providers.md)

Пользовательский провайдер подключает свой сервис к одному из установленных протоколов: OpenAI Chat Completions или Anthropic Messages. Настройки описываются в `provider.json`; изменение исходников и сборка приложения не нужны.

<a id="где-находится-каталог-providers"></a>
<a id="chisel-providers-path"></a>
<a id="структура-provider-package"></a>

## Найти каталог

```bash
chisel providers path
```

Команда создаёт пользовательскую структуру данных и показывает абсолютный путь `Home/providers`. Внутри создайте отдельную папку, например `example-gateway`, с файлом `provider.json`. Читаются только непосредственные подпапки. Имя папки и ID сервиса независимы: `/` в ID не означает вложенную папку.

<a id="быстрый-старт"></a>
<a id="openai-compatible-provider"></a>

## Подключить OpenAI-совместимый API

Создайте `example-gateway/provider.json`:

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

Замените адрес и модель на реальные параметры сервиса. `EXAMPLE_API_KEY` — имя переменной окружения, а не сам ключ. Ключ также можно сохранить в мастере подключения.

## Локальный сервер без ключа

Для сервера с OpenAI-совместимым API на порту 11434 создайте `local-ollama/provider.json`:

```json
{
  "schemaVersion": 1,
  "id": "local/ollama",
  "label": "Local Ollama",
  "driver": "openai-chat",
  "auth": { "required": false, "envVars": [] },
  "endpoint": { "required": false, "defaultBaseUrl": "http://localhost:11434/v1", "normalization": "openai-v1" },
  "defaults": { "model": "your-local-model" },
  "capabilities": { "modelListing": true, "tokenCounting": "unsupported", "usageReporting": "unknown", "toolCalling": true, "thinking": false }
}
```

Запустите сервер и загрузите модель. Вместо `your-local-model` укажите её точный ID. Ключ при `auth.required: false` необязателен. Если сервер не поддерживает список моделей, задайте `modelListing: false` и выбирайте ID вручную. Возможности вызова инструментов должны поддерживаться и сервером, и самой моделью.

<a id="проверка-через-chisel-providers-validate"></a>

## Проверить и сохранить профиль

```bash
chisel providers validate
chisel providers list
chisel setup --provider example/gateway --profile example-work
chisel --profile example-work "Объясни проект"
```

Для локального примера замените ID на `local/ollama`, а профиль — на `local-work`. В мастере сохраните ключ, если он требуется, и выберите модель. После изменения manifest перезапустите ChiselCode.

`validate` работает без сети и не проверяет ключ или доступность API. Код завершения 0 означает отсутствие ошибок, 1 — ошибки. Предупреждение об удалённом HTTP не делает проверку неуспешной. После сохранения выполните короткий запрос через обычный runtime.

<a id="anthropic-compatible-provider"></a>

## Подключить Anthropic-совместимый API

Используйте `driver: "anthropic-messages"`, базовый адрес корня сервера и `normalization: "anthropic-root"`. Пример с Bearer-токеном:

```json
{
  "schemaVersion": 1,
  "id": "example/anthropic-proxy",
  "label": "Messages Proxy",
  "driver": "anthropic-messages",
  "auth": { "required": true, "envVars": ["EXAMPLE_AUTH_TOKEN"] },
  "endpoint": { "required": false, "defaultBaseUrl": "https://messages.example.com", "normalization": "anthropic-root" },
  "defaults": { "model": "proxy-coder" },
  "capabilities": { "modelListing": false, "tokenCounting": "unsupported", "usageReporting": "final", "toolCalling": true, "thinking": false },
  "driverOptions": { "authMode": "bearer" }
}
```

Для `x-api-key` задайте `authMode: "api-key"`. Драйвер сам добавляет `/v1/messages`; конечный `/v1` у корня удаляется. Не объявляйте поддержку рассуждений или подсчёта токенов, если сервер их не предоставляет.

<a id="providerjson"></a>
<a id="manifest-schema"></a>
<a id="provider-id-и-namespace"></a>
<a id="authentication"></a>
<a id="environment-variables"></a>
<a id="endpoint-normalization"></a>
<a id="capabilities"></a>
<a id="manifest-versioning"></a>

## Поля provider.json

Это обычный UTF-8 JSON размером до 256 КиБ. Поддерживается `schemaVersion: 1`; неизвестные поля отклоняются.

| Поле | Значение |
| --- | --- |
| `id` | Имя вида `acme/gateway`: две части из строчных букв, цифр, `.`, `_`, `-`, разделённые `/`; части начинаются с буквы или цифры |
| `label` | Название до 100 символов |
| `driver` | `openai-chat` или `anthropic-messages` |
| `auth` | `required` и до 10 имён `envVars`; только имена переменных, без значений секретов |
| `endpoint` | `required`, необязательный HTTP(S) `defaultBaseUrl` и правило `normalization` |
| `defaults` | Объект с необязательным ID `model` |
| `capabilities` | Поддержка списка, подсчёта токенов, статистики, инструментов и рассуждений |
| `driverOptions` | Необязательные настройки выбранного драйвера из раздела ниже |
| `description` | Необязательное описание до 500 символов |
| `author`, `homepage`, `license` | Необязательные сведения об авторе, URL и лицензии; сами по себе не вызывают сетевого запроса |

`tokenCounting` принимает `native` или `unsupported`, `usageReporting` — `stream`, `final` или `unknown`. `modelListing`, `toolCalling` и `thinking` — логические значения. Окно модели не угадывается по имени. Неизвестная стоимость не считается нулевой.

Адрес профиля и `--base-url` имеют приоритет над `defaultBaseUrl`. Допустимы только HTTP(S) без логина, пароля, query и fragment. Правила `none`, `openai-v1` и `anthropic-root` описаны в [настройке адреса](providers.md#адрес-api).

<a id="driver"></a>
<a id="driveroptions"></a>

## Настройки драйвера

Для `openai-chat`:

- `includeUsage` — отправлять `stream_options.include_usage`, по умолчанию включено. Повтор без поля возможен только при HTTP 400, явно указывающем на его неподдерживаемость.
- `tokenLimitFallback` — разрешить один повтор с `max_tokens` после соответствующего отказа для `max_completion_tokens`. По умолчанию включён у декларативного драйвера; официальное определение OpenAI выключает его.

Для `anthropic-messages`:

- `authMode` — `api-key` по умолчанию либо `bearer`.
- `adaptiveThinking` — расширенные рассуждения, по умолчанию выключены; включайте только для совместимого сервера.
- `nativeTokenCounting` — использовать API подсчёта токенов; по умолчанию определяется `tokenCounting`.

Другие настройки, включая `fetch`, произвольные `headers` и пути JavaScript, не принимаются. OpenAI Responses API не поддерживается. [Технический контракт драйверов](architecture/providers.md).

<a id="diagnostics"></a>
<a id="duplicate-ids"></a>
<a id="безопасность"></a>
<a id="ограничения-v1"></a>
<a id="почему-произвольный-javascript-не-запускается"></a>

## Ошибки и безопасность

Проверка сообщает код, путь файла и ID провайдера. Типовые причины: `manifest_invalid`, `manifest_too_large`, `reserved_id`, `duplicate_id`, `unknown_driver`, `unsupported_schema`, `unsafe_symlink`, `invalid_driver_options`. Сырые ключи и содержимое JSON в диагностику не выводятся.

Два пользовательских пакета с одинаковым ID отключаются оба. Встроенные ID нельзя переопределить. Некорректный пакет не отключает встроенные сервисы.

Manifest и его папка не могут быть симлинками или junctions. Поля ключей, токенов, паролей и авторизации запрещены рекурсивно. Секреты сохраняются через профиль и хранилище ключей. Проверяйте адрес до ввода ключа: будущие запросы будут отправляться именно ему. Удалённый HTTP передаёт данные без TLS.

Чтение каталога не запускает JavaScript, shell, сетевые запросы или установку npm. Пользовательские исполняемые драйверы, удалённые manifests и автоматическое слежение за файлами не реализованы. Протокол провайдера не является системной песочницей.

<a id="profiles"></a>
<a id="models"></a>
<a id="compatibility"></a>

## Профили и совместимость

Профили одного сервиса независимы. Создавайте их через `setup --profile` или «Новый профиль» в настройках; выбирайте через `--profile` или окно выбора модели. Ссылка `apiKeyRef` не обязана совпадать с ID профиля.

После удаления manifest профиль и история остаются читаемыми, но новые запросы к этому сервису недоступны до его восстановления или смены подключения. [Перенос старых настроек](provider-migration.md).

<a id="как-добавить-новый-protocol-driver"></a>

Добавление нового протокола в исходники описано в [архитектуре провайдеров](architecture/providers.md#добавить-протокольный-драйвер).
