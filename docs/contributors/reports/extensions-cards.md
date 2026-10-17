# Каталог и карточки расширений OpenTUI 0.6.34

[Материалы для участников](../README.md) · [Управление расширениями](../../extensions.md) · [Архитектурное решение](../../architecture/extension-settings.md#каталог-opentui-и-карточка-расширения)

CLI 0.6.34 выпущен из `main`. Общая оболочка Settings сохранена. Каталог расширений отделён от карточки: нажатие или Enter открывает описание, состояние и меню допустимых действий. Буквенные команды изменения пакета удалены. Доступные кнопки и клавиатурные действия строятся из одних структурированных записей; доверие, CAS/revision, отмена и операции пакетов остаются в прежнем management service.

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

Итоговый source — [`8f7c1a2`](https://github.com/TheAsrada/ChiselCode/commit/8f7c1a26568ebd734efff012caddef29e3726dba). На нём успешно завершились [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/39008616122) и все четыре jobs [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/39008624478). CI использует Bun 1.4.2, локальные проверки — Bun 1.4.3.

| Проверка release source | Результат |
| --- | --- |
| Полный source-набор, Linux | 1243 passed, 3 skipped, 0 failed; 1246 тестов в 163 файлах, 307,68 с |
| Evals, все категории | 14 из 14 сценариев успешны |
| Затронутый platform-набор, macOS ARM64 | 252 passed, 3 skipped, 0 failed; 255 тестов в 34 файлах, 65,90 с |
| Затронутый platform-набор, Windows x64 | 254 passed, 1 skipped, 0 failed; 255 тестов в 34 файлах, 82,54 с |
| Native smoke Linux/macOS/Windows | Installed/compiled CLI и SDK, настоящий OpenTUI, compiled creator и встроенные разделы MCP/Skills успешны |
| Typecheck, lint, CLI/SDK build | Успешны; lint с warnings/info |

Первый Windows job этого source завершился с 253 passed, 1 skipped, 1 failed: прежний fixture действий инструментов не дождался первой shell-команды в Obsidian/graphics за 15 секунд. Остальные три сочетания темы/отображения и все шесть новых проверок расширений прошли. После изучения лога повторён только Windows job, один раз, на том же source: спорный сценарий прошёл за 7,56 с, весь job успешен. Production deadlines, таймаут fixture и assertions не менялись. Результаты остальных трёх jobs сохранены; повторный полный source-прогон не выполнялся.

Воспроизведение:

```bash
CHISEL_EXTENSION_SETTINGS_CAPTURES=docs/assets/extensions-cards/obsidian bun tests/fixtures/tui-extensions-settings.ts
CHISEL_EXTENSION_SETTINGS_THEME=paper CHISEL_EXTENSION_SETTINGS_CAPTURES=docs/assets/extensions-cards/paper bun tests/fixtures/tui-extensions-settings.ts
python3 scripts/render-terminal-captures.py docs/assets/extensions-cards/obsidian
python3 scripts/render-terminal-captures.py docs/assets/extensions-cards/paper
```

## Выпуск CLI 0.6.34

[CLI 0.6.34](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.34) опубликован 17 октября 2026 года и проверен как latest, не draft/prerelease. Annotated tag `v0.6.34` указывает на `8f7c1a26568ebd734efff012caddef29e3726dba`. Тег создан после успешных обязательных native jobs; `verify-release-ci.ts` подтвердил точный source до отправки тега и повторно в [Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/39009429615). Все jobs Release успешны. Полный source-набор при сборке поставки не дублировался.

Все пять опубликованных assets скачаны: размеры и SHA-256 совпали с метаданными GitHub API. Извлечённый DEB и CLI, установленный из опубликованного npm-архива в отдельный временный prefix, показали `0.6.34` и прошли реальный manifest/model/tool/persistence smoke с локальным provider. SDK из npm-поставки импортируется отдельно (`API_VERSION=1`), declarations присутствуют. Все три bundled skill в DEB/npm побайтово совпадают с release source. При `npm install` под Node 24.19.0 получено предупреждение engine зависимости OpenTUI о Node ≥26.4; установка завершилась успешно, запуск и smoke выполнялись под поддерживаемым Bun 1.4.3.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `chiselcode-0.6.34.tgz` | 5863152 | `b7cf7ed223a78dfdbd0f88beb72e5160f12dd2c743b4898e4357940b5d141530` |
| `ChiselCode-Setup-0.6.34-linux-amd64.deb` | 36996178 | `2e35bb51bc151b4c87db9cb552a5c7dced5ece11922a0394b5a57cc9eda0358b` |
| `ChiselCode-Setup-0.6.34-macos-arm64.pkg` | 33359486 | `67b73425088fd610fc6239472e7e7405c2a6b56a9665ed2ecb4307bd055bb46c` |
| `ChiselCode-Setup-0.6.34-macos-x64.pkg` | 35944351 | `cddda3c4f543f0dcbd096d005f4c40539a11c591bf7586dfa1a223e35c716a38` |
| `ChiselCode-Setup-0.6.34.exe` | 38724392 | `ac6003b487c49e672d02f45a8060d12b15239dbfdf58699a6ca22b3d94126ecf` |

Release проверил запуск Windows x64, Linux x64 и macOS ARM64. macOS x64 собран, запуск на Intel не проверялся. Windows/macOS установщики не подписаны; системные GUI установки и физические терминалы здесь не проверялись. Полный source-набор выполнен на Linux; macOS/Windows имеют указанное platform/smoke-покрытие. Результаты публикации фиксируются отдельным коммитом `main`; тег и опубликованные assets не изменяются.
