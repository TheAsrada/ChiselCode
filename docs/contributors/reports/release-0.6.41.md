# Выпуск CLI 0.6.41

[Материалы участников](../README.md) · [Установка](../../installation.md) · [Искра и состояния запроса](request-activity.md) · [Оформление интерфейса](interface-design.md) · [Чистая главная](home-commands.md)

[CLI 0.6.41](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.41) опубликован 25 октября 2026 года в 12:25:11 UTC. В выпуск входят обновлённый композер и меню, общая система движения и настройка reduced motion, фирменная искра со статусами реальных действий и главная без служебной ленты. Slash-команды `/status` и `/doctor` удалены.

Release source — `4e06523fdf8451228ad338b665fefaa996312d08`, отправлен прямо в `main`. Версии `package.json`, корневого `package-lock.json` и `src/version.ts` синхронизированы. Annotated tag `v0.6.41` создан после успешного допуска всех четырёх обязательных jobs и указывает на этот source; объект тега — `fdbc96d70cd7eae930f99c3963d4abdf9d1ebe46`.

Код продукта совпадает с проверенной реализацией `95b4e36ccf94b9e8411ef179bd8e8826af1ba7a6`, кроме номера версии; предыдущие результаты сохранены в [отчёте об искре](request-activity.md#итоговая-ci). Допуск релиза заново проверен на точном release source.

## Проверки release source

[Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/40191135394) и [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/40191130641) прошли на точном release source, Bun 1.4.2. Скрипт `verify-release-ci.ts` подтвердил все четыре обязательные jobs перед созданием тега; Release повторно проверил тот же допуск через GitHub API.

| Job | Результат | Время успешного job |
| --- | --- | --- |
| Full source, Linux | 1373 pass, 3 skip, 0 fail; 1376 тестов в 177 файлах за 264,85 с; typecheck, lint, eval и дополнительные source UI-fixtures прошли | 311 с |
| Native Linux | Installed npm/SDK, compiled CLI и OpenTUI-сценарии, включая искру, прошли | 171 с |
| Native macOS | 361 pass, 3 skip, 0 fail за 139,22 с; installed/compiled smoke прошли | 364 с |
| Native Windows | 363 pass, 1 skip, 0 fail за 391,73 с; реальный updater, installed/compiled smoke и UI прошли на одном повторе | 848 с |

Полный source-набор выполнен один раз на Linux. Windows/macOS получили платформенный набор из 364 тестов в 47 файлах и проверки поставки. Source-сценарий и compiled design fixture проверили настоящие SDK и инструменты: параллельные чтение/поиск, отдельный поиск, подтверждённые запись и shell, потоковый ответ, стабильный черновик и отсутствие модельных запросов от меню. В CI используется Obsidian; Paper отдельно прошла production fixture и native tests обеих тем на Linux при реализации.

Локально перед release source прошли 446 быстрых тестов в 47 файлах за 2,16 с, typecheck, lint, JS/SDK build и запуск CLI с версией 0.6.41. Lint сохраняет 401 прежнее предупреждение и 58 информационных замечаний, блокирующих ошибок нет. Пересекающиеся наборы не суммируются.

### Первый Windows job и единственный повтор

Первый Windows job завершился с 362 pass, 1 skip и 1 fail за 419,93 с: `subagent-lifecycle.test.ts` превысил свою конечную границу 20000 мс. Сценарий создаёт 37 настоящих записей задач и проверяет отмену, дубликаты, закрытие владельца и границы доступа. Функциональной ошибки assertion в логе не было. Этот код и тест не менялись; на предыдущем успешном Windows source тот же сценарий занял 9343,99 мс.

По правилу одного повтора при предполагаемом временном сбое заново выполнен только Windows job на том же source. На повторе сценарий завершился за 6379,67 мс при прежнем deadline 20000 мс; все остальные проверки Windows и поставки также прошли. Код, таймауты и assertions не менялись. Точная причина замедления первого job не установлена. Linux source и Linux/macOS smoke сохранили успешные результаты без повторного исполнения.

От создания Native workflow до завершения последнего job прошло 1378 с (22 мин 58 с). Сумма фактически исполненных jobs, включая неудачный Windows job длительностью 488 с, — 2182 с (36 мин 22 с runner time). Скопированные GitHub записи успешных jobs частичного rerun не считались повторным исполнением. Это длительности проверок, а не измерение скорости UI.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/40192830894) завершил все шесть jobs успешно: допуск source, сборки Windows/macOS/Linux и npm/SDK, публикация. Release API подтвердил `v0.6.41`, отсутствие draft/prerelease и пять assets в состоянии `uploaded`. Заметки опубликованы по-русски с абсолютными ссылками на материалы.

Все пять опубликованных файлов скачаны и сверены с Release API по размеру и SHA-256.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-Setup-0.6.41-linux-amd64.deb` | 37020918 | `f8aae42490126ac276c9ff0ea11bc68f57502009a1faa2912d23d782441ce94f` |
| `ChiselCode-Setup-0.6.41-macos-arm64.pkg` | 33394821 | `fac2cd720109ca0f48d213de5e39bce3354e7cd7fb92fcbd636729b9ec610e57` |
| `ChiselCode-Setup-0.6.41-macos-x64.pkg` | 35978373 | `f2b5c9fec48064070372d41f0e6043b2893bc0e3d7e4992e6a78833fc27451ad` |
| `ChiselCode-Setup-0.6.41.exe` | 38754283 | `ff64039b175e577c1574d44ef4518579725e193d669ba3dec20a67f2105302fe` |
| `chiselcode-0.6.41.tgz` | 5901227 | `c19ea6577e5f6678580da8c95395ae1e57ed014eee1bdd372258a811bd50afc3` |

Linux binary извлечён из опубликованного DEB без установки в систему. DEB manifest и `--version` вернули 0.6.41. `update --json` подтвердил `current: 0.6.41`, `latest: 0.6.41`, `updateAvailable: false` и все пять assets с теми же размерами и контрольными суммами. npm-архив содержит `chiselcode@0.6.41`, обычный CLI, declarations extension SDK и UI composition, встроенный `extension-creator`.

Установка, справка оформления, архитектура и оба оглавления обновлены. Проверены 11 изменённых Markdown-файлов и 206 относительных ссылок, anchors и изображений; отчёт достижим из обоих оглавлений. Версии и все контрольные суммы в таблице сверены с опубликованными файлами. Отчёты реализации сохраняют свои source/results и ссылаются на выпуск. Последующий коммит меняет только документацию; опубликованные tag и assets не заменяются.

## Ограничения проверки

Полный source-набор выполнен на Linux; Windows/macOS имеют платформенные проверки и smoke поставки. На Linux пропущены системный clipboard без desktop-сессии и две Windows-only проверки CMD/Python. На macOS пропущены detached orphan и две Windows-only проверки; на Windows — detached orphan. Эти пропуски не объявляются успешными тестами.

Intel macOS package собран, но отдельный запуск на физическом Intel Mac и ручной GUI-прогон установщиков не выполнялись. Установщики не подписаны; нотариальная проверка macOS не выполнялась. Скорость физического терминала и SSH не измерялась. Концепт Desktop не изменялся и не выпускался.
