# OpenTUI после рефакторинга модулей

[Документация](../../README.md) · [Границы модулей](../../architecture/module-boundaries.md)

Кадры получены 10 ноября 2026 года на Linux из настоящего OpenTUI 0.5.12 через `testRender`/`captureSpans`. PNG экспортированы штатным скриптом из исходных JSON; TXT сохраняет текст ячеек. Это headless renderer, не снимки физических терминалов.

| Сценарий | Кадр |
| --- | --- |
| Главная production application | [120×36](obsidian-home-120x36.png) |
| Завершённый разговор | [120×36](obsidian-chat-120x36.png) |
| Редактирование профиля после ошибки и задержанной записи | [120×40](connections-120x40.png) · [80×24](connections-80x24.png) · [40×16](connections-40x16.png) · [24×8](connections-24x8.png) |

Для встроенных меню отдельно сравнены все 16 `captureSpans` JSON до/после выделения UI-модулей: модели, навыки, история и Settings на четырёх размерах. Текст, цвета, атрибуты и размеры совпали. Autosave fixture проверил сохранение нового ввода и курсора при задержке, resize, ошибку записи, закрытие и повторное открытие. Production design fixture проверил главную, чат, Unicode, resize, поиск и отсутствие model calls от меню.

Воспроизведение из корня репозитория:

```bash
CHISEL_AUTOSAVE_CAPTURES=/tmp/chisel-captures bun test tests/unit/settings-autosave-runtime.test.tsx
CHISEL_DESIGN_CAPTURES=/tmp/chisel-captures bun tests/fixtures/tui-ui-design.ts
python scripts/render-terminal-captures.py /tmp/chisel-captures
bun tests/fixtures/menu-captures.tsx /tmp/chisel-menus before
```

Для сравнения меню выполните последнюю команду до и после изменения с разными каталогами и одинаковым аргументом `before`, затем сравните JSON. Fixture использует только изолированные демонстрационные данные.
