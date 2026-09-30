# Пользовательские провайдеры

Custom provider — declarative ProviderDefinition для существующего protocol driver. Каталог находится в ChiselCode Home/providers; `chisel providers path` показывает путь и создаёт пустой каталог.

## Быстрый старт

Создайте `providers/example-gateway/provider.json`:

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
chisel setup
```

Folder name не является provider identity: profile сохраняет manifest ID. Catalog загружается при startup; после изменений перезапустите приложение. Invalid package не мешает built-ins. Никакой JS из Home/providers не исполняется. Поддерживаются только протоколы openai-chat и anthropic-messages; новый wire protocol требует source driver и регистрации в DriverRegistry. Подробности profiles/UI добавляются в следующих этапах миграции.

## Profiles

После discovery provider доступен в setup и /settings без пересборки. Выберите его поиском, создайте профиль (например corp-ai), введите ключ или настройте EXAMPLE_API_KEY. Config хранит providerId="example/gateway" и apiKeyRef="corp-ai", а CredentialStore хранит секрет. «Новый профиль» создаёт независимый аккаунт; «Профиль» выбирает существующий.
