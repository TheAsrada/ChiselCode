# Темы расширения

[Разработка расширений](README.md) · [Chat и UI](contributions.md) · [Архитектурный контракт](../architecture/themes.md) · [Пользовательская справка](../themes.md)

Начиная с поддержки тем в 0.6.26, linked extension и публичная `ExtensionDefinition` API v1 могут объявить optional `themes`. Это статические данные default factory, вне workspace `activate`. Старым пакетам поле не требуется; версия SDK остаётся 1. Если темы обязательны для пакета, укажите `chiselVersion: ">=0.6.26"` в manifest.

Используйте `import type { ExtensionFactory, ThemeContribution, ThemeToken } from "chiselcode/extension-sdk"`. Runtime по-прежнему получает injected SDK; self-contained `.mjs` не требует bare import SDK и не импортирует renderer.

```ts
import type { ExtensionFactory, ThemeContribution } from "chiselcode/extension-sdk";

const themes: readonly ThemeContribution[] = [{
  id: "north",
  name: "Север",
  description: "Спокойная тёмная тема с голубым акцентом.",
  variant: "dark",
  colors: {
    bg: "#101622", surface: "#192233", raised: "#263044",
    border: "#64738b", text: "#f3f6ff", muted: "#b7c3da",
    accent: "#9cbaff", green: "#92ddb8", red: "#ff9ea3",
    yellow: "#eed793",
  },
}];

const factory: ExtensionFactory = ({ manifest }) => ({
  id: manifest.id, version: manifest.version, apiVersion: 1,
  entry: manifest.entry, themes,
  activate(context) { /* Регистрации остальных возможностей. */ },
});
export default factory;
```

## Поля и проверка

| Поле | Контракт |
| --- | --- |
| `id` | Локальный ID: `[a-z][a-z0-9_-]*`, до 64 символов |
| `name` | Название, 1–120 символов |
| `description` | Описание, 1–2000 символов |
| `variant` | `light` либо `dark` |
| `colors` | Ровно десять обязательных семантических токенов, каждый `#RRGGBB` |

Токены: `bg`, `surface`, `raised`, `border`, `text`, `muted`, `accent`, `green`, `red`, `yellow`. Core проверяет полноту, unknown fields, управляющие символы и контраст: основной текст ≥4.5:1; muted, accent, success, error и warning ≥3:1 на каждой из `bg/surface/raised`. Светлый вариант имеет относительную яркость `bg` >0.5; тёмный ≤0.5. Для различимого выделения контраст `surface/raised` ≥1.05:1, а `border/surface` ≥1.5:1. Выделенные строки используют `raised`; кнопки и разрешения сохраняют core rendering и явные текстовые подписи.

До 16 тем на расширение и 256 тем расширений на приложение. Идентичность назначается core: `extension:<extensionId>:<themeId>`; `extensionId` определяется manifest/host. Одинаковые локальные IDs у разных расширений допустимы. Не задавайте source, CSS, размеры, JSX, callbacks или компоновку. Неверная тема не заменяет встроенную палитру и не публикуется.

Проверяются исходные цвета темы. Пользовательский accent override затем применяется отдельно и не изменяется расширением.

## Lifecycle и совместимость

Метаданные захватываются и замораживаются. Внешняя тема попадает в application catalog после successful workspace seal её расширения; optional activation failure не публикует новые темы. Закрытие workspace не удаляет уже принятые статические палитры. Project policy проверяется перед обычным import; каталог не обходит её ради предварительного просмотра.

Изменённый package требует нового exact digest trust и нового запуска. Не меняйте `themes` после factory и не рассчитывайте на hot reload. Выбор темы не вызывает activate/tools/model и не сохраняет snapshots в Session/context.

Тестовый пакет с двумя вариантами находится в [fixture source](../../tests/fixtures/extensions/themes/index.ts) и [manifest](../../tests/fixtures/extensions/themes/chisel-extension.json). Он не входит в production defaults, npm package или установщики. [Проверки распространения](testing.md) собирают автора вне checkout с declarations установленного SDK, а TUI fixture передаёт готовые файлы ordinary loader после build/compile.

Связанные темы: [Manifest и доверие](package.md) · [Быстрый старт автора](quickstart.md) · [Отчёт проверок](../contributors/reports/extension-themes.md).
