# Параметры внешнего расширения

[Разработка расширений](README.md) · [Формат пакета](package.md) · [Установка и настройки](../extensions.md)

С CLI 0.6.30 manifest может содержать `settings`. Схема читается без import/factory и обслуживает одинаковые формы OpenTUI и Desktop. Укажите `chiselVersion: ">=0.6.30 <0.7.0"`, если используете этот контракт. `schemaVersion` и `apiVersion` остаются 1; старые пакеты совместимы с новым host.

```json
{
  "settings": {
    "fields": [
      {"name":"message","type":"string","label":"Сообщение","default":"Привет","minLength":1,"maxLength":120},
      {"name":"count","type":"number","label":"Повторения","default":2,"integer":true,"min":1,"max":5},
      {"name":"enabled","type":"boolean","label":"Дополнительный вывод","default":false},
      {"name":"style","type":"enum","label":"Формат","default":"short","options":[{"value":"short","label":"Кратко"},{"value":"long","label":"С версией"}]},
      {"name":"access","type":"string","label":"Секрет","secret":true}
    ]
  }
}
```

Допустимы до 64 полей с уникальными ASCII `name`: буква, затем буквы/цифры/`_`, до 64 символов; служебные object keys запрещены. `label` ограничен 120 символами, `description` — 1000. `required` обозначает обязательное значение. `default` проходит ту же validation. Number поддерживает `min/max/integer`, string — `minLength/maxLength` до 8192, enum — 1–64 уникальных options с подписями. Произвольных validation callbacks, regex, HTML и исполняемых форм нет.

Секрет — только string без default. Ядро хранит его через существующий `CredentialStore`; DTO возвращает `secretSet`, но не значение или credential reference. Значения secret не передаются в каталог, review и логи ядра. Доверенный in-process JavaScript всё равно обладает правами процесса; декларация не создаёт OS sandbox.

Стандартная factory получает snapshot параметров текущего запуска. Начиная с 0.6.33 UI-пакет с `kind: "ui"` получает новую factory/settings revision при live remount; параметры применяются после сохранения без перезапуска core. Для UI-пакетов читайте настройки внутри activation, храните изменяемое состояние там же.

Factory получает snapshot через injected SDK:

```js
export default async ({sdk, manifest}) => {
  const values = await sdk.settings.read();
  const access = await sdk.settings.secret("access");
  return {
    id: manifest.id, version: manifest.version, apiVersion: 1, entry: manifest.entry,
    activate(ctx) { /* values доступны инструментам и командам этого запуска */ }
  };
};
```

`read()` возвращает frozen значения только объявленных несекретных полей. `secret(name)` разрешает только секретное поле этого ID. Настройки глобальны, привязаны к ID и сохраняются при update/rollback/disable/remove. Внешний код не получает API записи конфигурации через этот контракт. Изменение формы действует после restart; уже загруженный snapshot не меняется.

Обновление схемы не удаляет неизвестные значения. UI перечисляет оставшиеся ключи; SDK не отдаёт их как объявленные параметры. Несовместимое сохранённое значение требует исправления в форме. Сброс очищает только известные поля и применяет defaults; обязательное поле без default снова нужно заполнить. Если обязательные значения отсутствуют или сохранённые параметры не подходят схеме, activation не объявляется успешной.

Самостоятельный пакет с параметрами, tool и `/demo-settings`: [manifest](../../tests/fixtures/extensions/settings-demo/chisel-extension.json) и [готовый ESM](../../tests/fixtures/extensions/settings-demo/index.mjs). Он использует публичный injected SDK без внутренних импортов ChiselCode.
