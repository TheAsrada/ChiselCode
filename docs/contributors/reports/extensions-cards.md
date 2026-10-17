# Каталог и карточки расширений OpenTUI 0.6.34

[Материалы для участников](../README.md) · [Управление расширениями](../../extensions.md) · [Архитектурное решение](../../architecture/extension-settings.md#каталог-opentui-и-карточка-расширения)

Подготовка CLI 0.6.34 ведётся в `main`. Общая оболочка Settings сохранена. Каталог расширений отделён от карточки: нажатие или Enter открывает описание, состояние и меню допустимых действий. Буквенные команды изменения пакета удалены. Доступные кнопки и клавиатурные действия строятся из одних структурированных записей; доверие, CAS/revision, отмена и операции пакетов остаются в прежнем management service.

## Что изменилось

В каталоге доступны поиск по имени, ID и описанию, фильтр со счётчиками, установка и перечитывание списка. Названия имеют спокойный основной цвет; состояния вынесены вправо с семантическим цветом. Карточка показывает причину ошибки и необходимость перезапуска до свёрнутых технических сведений. В review кнопки остаются под прокручиваемым содержимым, доверие изначально снято.

Стрелки выбирают видимую кнопку, Enter/Space выполняют её, Esc возвращает назад. Выбор, фильтр и поиск сохраняются. Карточка не меняет выбранный пакет при навигации по действиям. Незавершённое значение поля учитывается как dirty; секрет остаётся маской при resize. Прокрутка к выбранному элементу выполняется после native layout; мышь и клавиатура используют одинаковые guards.

Просмотр не импортирует установленный JavaScript и не вызывает модель. Управление стандартными пакетами по-прежнему требует перезапуска, UI-пакеты применяют изменения через существующий live mount. Desktop, публичный SDK и engine protocol в этом задании не меняются.

## Настоящие кадры OpenTUI

Кадры получены production `runOpenTuiAgent`, а не макетом. Fixture устанавливает настоящий ESM из папки и ZIP и перезапускает приложение между четырьмя фазами. Вызов команды и инструмента подтверждает загрузку сохранённых параметров; счётчик сети/модели остаётся нулевым. Исторические кадры 0.6.30 сохранены в прежнем [отчёте](extension-settings.md).

| Сценарий | Obsidian | Paper |
| --- | --- | --- |
| Каталог, 120×36 | [Кадр](../../assets/extensions-cards/obsidian/catalog-120x36.png) | [Кадр](../../assets/extensions-cards/paper/catalog-120x36.png) |
| Выбор фильтра | [Кадр](../../assets/extensions-cards/obsidian/filters-120x36.png) | [Кадр](../../assets/extensions-cards/paper/filters-120x36.png) |
| Карточка работающего расширения | [Кадр](../../assets/extensions-cards/obsidian/working-120x36.png) | [Кадр](../../assets/extensions-cards/paper/working-120x36.png) |
| Установлено без доверия | [Кадр](../../assets/extensions-cards/obsidian/installed-untrusted-120x36.png) | [Кадр](../../assets/extensions-cards/paper/installed-untrusted-120x36.png) |
| Технические сведения | [Кадр](../../assets/extensions-cards/obsidian/metadata-120x36.png) | [Кадр](../../assets/extensions-cards/paper/metadata-120x36.png) |
| Проверка и доверие | [Кадр](../../assets/extensions-cards/obsidian/install-review-120x36.png) | [Кадр](../../assets/extensions-cards/paper/install-review-120x36.png) |
| Параметры | [Кадр](../../assets/extensions-cards/obsidian/settings-120x36.png) | [Кадр](../../assets/extensions-cards/paper/settings-120x36.png) |
| Версии | [Кадр](../../assets/extensions-cards/obsidian/versions-120x36.png) | [Кадр](../../assets/extensions-cards/paper/versions-120x36.png) |
| Карточка 80×24 | [Кадр](../../assets/extensions-cards/obsidian/details-80x24.png) | [Кадр](../../assets/extensions-cards/paper/details-80x24.png) |
| Карточка 40×16 | [Кадр](../../assets/extensions-cards/obsidian/details-40x16.png) | [Кадр](../../assets/extensions-cards/paper/details-40x16.png) |
| Карточка 24×8 | [Кадр](../../assets/extensions-cards/obsidian/details-24x8.png) | [Кадр](../../assets/extensions-cards/paper/details-24x8.png) |

Рядом с PNG сохранены `.txt` и `.json` с символами и цветами renderer. На самом маленьком экране управление прокручивается к выбранному действию; для одновременного чтения всех сведений нужен больший размер.

## Проверки и выпуск

Локально Linux: быстрый профиль — 356 passed; новые UI-проверки — 6 passed. Они проверяют отсутствие буквенных мутаций, разделение каталога/карточки, длинный список из 120 пакетов, сохранение контекста, отдельное доверие, скрытый ввод при resize и переход к встроенным настройкам. TypeScript, lint и CLI/SDK build успешны; lint содержит warnings/info. Реальный lifecycle прошёл в Obsidian и Paper. Source и compiled creator проверяют прежние live enable/settings/disable и подтверждения инструментов через обновлённую карточку.

При проверке длинного списка обнаружена попытка прокрутки до расчёта native geometry. Она заменена отложенным запросом в `renderBefore`, без фиксированных пауз. На 24-колоночном каталоге скрытая кнопка обновления также исключается из keyboard targets; отдельный тест подтверждает переход к видимому фильтру. В fixture выбор ожидает видимую строку и повторяет только прокрутку к ней; проверки содержимого, доверия, файлов и модели сохранены.

Окончательные native CI, release source и опубликованные assets фиксируются после завершения выпуска. Физические терминалы и запуск macOS Intel здесь не подтверждаются; кросс-сборка и запуск — разные проверки.

Воспроизведение:

```bash
CHISEL_EXTENSION_SETTINGS_CAPTURES=docs/assets/extensions-cards/obsidian bun tests/fixtures/tui-extensions-settings.ts
CHISEL_EXTENSION_SETTINGS_THEME=paper CHISEL_EXTENSION_SETTINGS_CAPTURES=docs/assets/extensions-cards/paper bun tests/fixtures/tui-extensions-settings.ts
python3 scripts/render-terminal-captures.py docs/assets/extensions-cards/obsidian
python3 scripts/render-terminal-captures.py docs/assets/extensions-cards/paper
```
