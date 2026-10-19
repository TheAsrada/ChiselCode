# Чистая главная, горячие клавиши и автоматическая панель

[Материалы участников](../README.md) · [Интерактивный режим](../../interactive.md) · [Клавиши](../../keybindings.md) · [Дизайн панели](../../design/sidebar.md)

Изменение вошло в [CLI 0.6.36](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.36), опубликованный 19 октября 2026 года. Работа выполнена в `main`; исходный HEAD — `52392c5`.

## Изменение

Общая строка ввода больше не проецирует `status` contributions в кнопки «Фон», LSP, «Агенты» и «Ещё». Это одно изменение для главной и всех бесед, без фильтрации текста по названиям. Источники, счётчики, ошибки, revision и действия доступны через компактное окно F9 и **Меню → Состояние сервисов**. Внешние пакеты сохраняют свой SDK и прежние действия.

F7 открывает дерево помощников, F8 — существующий owned navigation `/tasks`, F9 — список сервисов. F8 использует ту же subscription/action revision и `ExtensionUiBinding`, что меню; горячая клавиша не очищает черновик и не создаёт model/tool запрос. Подтверждения, настройки, побочные ответы и другие активные окна сохраняют приоритет ввода.

Причина отсутствия правой панели была в глобальном `sidebarMode`: закрытие переносилось между экранами и записывалось в настройки. Теперь видимость принадлежит текущему `OpenTuiScreen`. При каждом входе в беседу снова действует Auto, без перехвата ввода; на главной панель скрыта до явного открытия. Выбранный раздел и данные беседы сохраняют прежнего владельца. С ширины 120 колонок панель размещается справа; на узком терминале явное Ctrl+B/F7 открывает drawer/fullscreen, сохраняя чат видимым при обычном входе.

Старое `ui.sidebarMode` совместимо читается и удаляется при сохранении. Тема, accent, будущие поля, профили и credentials сохраняются. Тип legacy input оставлен с пометкой deprecated; настройка больше не используется приложением.

## Настоящие кадры

![Главная Obsidian без служебных кнопок](../../assets/clean-navigation/obsidian-home.png)

![Чат Paper с автоматически открытой панелью](../../assets/clean-navigation/paper-chat.png)

Все восемь кадров, их TXT/JSON и происхождение: [галерея](../../assets/clean-navigation/README.md). PNG — экспорт native spans, без дорисовки интерфейса.

## Проверки

- Linux, Bun 1.4.3: 62 pass в шести файлах layout/config/navigation/sidebar; 15 pass в шести файлах owner bindings, вкладок, подтверждений, side query, subagents, composition и production navigation. Дополнительные assertions изоляции F8/F9 в settings/side query прошли в 10 тестах двух файлов.
- Быстрый профиль: 360 pass, 0 fail. Typecheck и lint прошли; существующие предупреждения не отключались.
- Обычный `runOpenTuiAgent` в Obsidian и Paper: чистая главная, F9, меню, внешние подробности, нормальный approval, реальная запись файла, checkpoint и disposal. Отдельно прошли ordinary background fixture с F8 во время busy main и F9 со счётчиком активной команды; внешний loader с сохранением черновика/фокуса и выполнением штатного инструмента.
- Собран CLI/SDK и compiled UI harness обычного приложения; проверены native slots, F9, навигация, approval, файл и checkpoint.

Первый локальный запуск LSP config остановился из-за отсутствующих закреплённых test dependencies; после подготовки `typescript-language-server@6.0.1` и `typescript@6.0.3` файл прошёл целиком. Две новые проверки первоначально обращались к ID диалога без суффикса `-popup`; ID исправлены. Внешний fixture использовал неверное имя mock-клавиши `escape`; заменено на штатное `ESCAPE` и добавлено ожидание закрытия окна. Assertions не пропускались, production timeout не менялся.

## Native CI перед выпуском

Release source — `94dc1d18b394bf967e8271fa45eccdac8ac520c0`. [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/39230661133) и все четыре job [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/39230683616) прошли с первого запуска, без повторов, изменения deadlines или пропуска assertions. Native CI использует Bun 1.4.2.

| Проверка | Фактический результат | Длительность job |
| --- | --- | ---: |
| Полный source, Ubuntu | 1257 pass, 3 skip, 0 fail в 164 файлах; тесты 327,52 с; typecheck/lint и 14 eval успешны | 380 с |
| Native Ubuntu | Установленный npm-пакет, compiled CLI и OpenTUI, MCP/skills в Settings, внешние UI-расширения | 127 с |
| Native macOS | 312 pass, 3 skip, 0 fail в 40 файлах, 76,82 с; installed/compiled smoke | 201 с |
| Native Windows | 314 pass, 1 skip, 0 fail в 40 файлах, 202,25 с; реальный NSIS updater и installed/compiled smoke | 632 с |

От запуска Native workflow до завершения последнего job прошло 636 с. Это измеренное время ожидания, а не сумма runner minutes. Полный source-набор выполнен один раз на Linux; Windows/macOS проверяли платформенные файлы целиком и реальные процессы/поставку. Локальные native кадры и compiled harness сняты на Linux; интерактивная работа в физических терминалах Windows/macOS вручную не проверялась.

Production `verify-release-ci.ts` подтвердил все четыре job на точном source до создания и отправки annotated tag `v0.6.36`. Тег и опубликованные assets не перезаписывались.

## Выпуск CLI 0.6.36

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/39232052168) повторно проверил допуск точного source и завершил все шесть jobs успешно. Annotated tag `v0.6.36` указывает на `94dc1d18b394bf967e8271fa45eccdac8ac520c0`; GitHub API подтвердил его объект. Выпуск опубликован как latest, не draft/prerelease, с четырьмя установщиками и npm-архивом CLI/SDK.

Все пять опубликованных файлов скачаны. Размеры и SHA-256 совпали с GitHub API; форматы EXE/PKG/DEB/tgz проверены по сигнатурам файлов.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-Setup-0.6.36-linux-amd64.deb` | 37003622 | `870d660de8918d86e38e85d8dd6caf2e9d32d4b90d86c451fd66b95951372980` |
| `ChiselCode-Setup-0.6.36-macos-arm64.pkg` | 33357972 | `d55787a29831ee11e3303e1cb79dac41ee6f464aeb73874199a98c45679fb4fd` |
| `ChiselCode-Setup-0.6.36-macos-x64.pkg` | 35943470 | `91c9504c78ede223ee2132efd47aa43f56546edcabd3fffc9a3478a291cd434a` |
| `ChiselCode-Setup-0.6.36.exe` | 38727365 | `ea337a0baf56aba8a552c520f6146d7ad1488614ca36068e683701929dcb5cf6` |
| `chiselcode-0.6.36.tgz` | 5862100 | `7cca75a156dbb430dc9e2a60baa3366395514ea2d47079f4b9fb88de3bbb840a` |

Извлечённый опубликованный DEB и CLI, установленный из опубликованного npm-архива в отдельный временный prefix, показали `0.6.36` и прошли настоящий manifest/model/tool/persistence smoke с локальным provider. `update --json` опубликованного бинарника получил текущий публичный релиз `0.6.36`, все пять assets с SHA-256 и `updateAvailable: false`. Публичный SDK импортируется отдельно (`API_VERSION=1`), declarations присутствуют. Все три bundled skill в DEB/npm побайтово совпали с tag source.

Установка npm под Node 24.19.0 завершилась с предупреждением engine зависимости OpenTUI о Node ≥26.4; запуск и smoke выполнены под поддерживаемым Bun 1.4.3. npm-архив опубликован в GitHub Release.

Release проверил запуск Windows x64, Linux x64 и macOS ARM64. macOS x64 собран, запуск на Intel не проверялся. Установщики Windows/macOS не подписаны; GUI полного мастера установки и физические терминалы вручную не проверялись. Эти результаты добавлены отдельным коммитом документации в `main`, без изменения release source, тега и assets.
