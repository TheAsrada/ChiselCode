# CI: сокращение повторов и быстрый профиль

[Материалы для участников](../README.md) · [Порядок проверок](../testing.md) · [Разработка](../../development.md)

Изменения выполнены после CLI 0.6.31 прямо в main. Проверенный code source — `5b34cef03c9a66e90aec7a2dac9e91b67783761d`; последующая правка отчёта меняет только Markdown. Версия и опубликованный тег не менялись; отдельный релиз не запускался.

## Изменения

Обычный push использует Quick CI и профиль из 38 test files без серверов, дочерних приложений и OpenTUI renderer. В нём 343 проверки permissions/SSRF, provider contracts, compaction/tool pairs, extension lifecycle, конфигурации и состояния интерфейса. `bun run test`/`npm test` используют быстрый профиль; `bun test` и `bun run test:full` сохраняют весь набор.

Native validation запускается вручную: один полный source-набор на Linux и три native smoke. Это четыре jobs вместо девяти, без трёх повторов полного source-набора и полного каталога серверов на каждом push. Installed package и compiled CLI выполняют разные короткие проверки поставки. Сложные процессы, помощники, worktrees и UI остаются в source tests; расширенный installed/compiled UI harness доступен отдельно при изменении bundling/SDK. Полный каталог LSP запускается отдельно при изменении backends/provisioning, с возможностью выбора языков. Точная карта и ограничения платформ приведены в [порядке проверок](../testing.md).

В двух crash-тестах пакетов после настоящего SIGKILL и подтверждённого выхода worker задаётся давность его изолированного lock. Это убирает два ожидания по 30 секунд; recovery, atomic commit boundaries и запрет replay проверяются прежними assertions. Production lock/deadlines не менялись. Все исходные test files сохранены.

Release требует последний успешный ручной Native validation на точном SHA тега. Quick CI, старый SHA, пропущенные jobs и ошибка GitHub API не подходят. Повтор полного набора в Release убран; сборки проходят короткую проверку запуска и версии. Кэшируются package downloads, не пользовательские данные.

## Измерения и проверки

Локальный быстрый профиль: 343 pass, 0 fail, 2859 assertions, 38 files, 908 мс (Linux/Bun 1.4.2; предыдущий запуск — 888 мс). Это длительность тестов с загрузкой модулей; подготовка CI runner, npm install, typecheck/lint/build в неё не входит.

Изменённые настоящие process tests: 4 pass, 23 assertions, 1,86 секунды на Linux; два crash points заняли 249 и 259 мс. Не сравнивается напрямую со скоростью Windows runner.

База: [CI выпуска 0.6.31](https://github.com/TheAsrada/ChiselCode/actions/runs/38749466513), source `3d61b6a`, итоговый attempt 2. Windows Quality занимал 33:54, source-тесты внутри — 12:48, UI packaging — 7:29, installed CLI — 3:22, compiled CLI — 2:56. Сумма шести успешных jobs — 82:52 runner minutes, без неуспешных attempts. Эти цифры описывают старую схему и не являются обещанием ускорения текущего native run.

## Промежуточные отказы

Первоначальная попытка только распараллелить прежнюю матрицу не решила стоимость повторов. В [run 38762092668](https://github.com/TheAsrada/ChiselCode/actions/runs/38762092668), source `eaf584b`, macOS PHP download вернул HTTP 502. Добавлен один ограниченный retry начальной подготовки после cleanup, без повтора assertions/активации.

В [run 38763775890](https://github.com/TheAsrada/ChiselCode/actions/runs/38763775890), source `16e7ad8`, Windows UI packaging потерял раннюю команду до mount и фокуса prompt: `Settings did not open`. Fixture теперь ждёт готового ввода и явно фокусирует поле; сценарий прошёл на Linux в source и compiled вариантах. Его функциональные assertions и deadline сохранены.

[Run 38764815910](https://github.com/TheAsrada/ChiselCode/actions/runs/38764815910), source `0022034`, отменён по решению сократить полные прогоны. Эти runs не выдаются за успешную финальную native-матрицу.

Итоговый [Quick CI 38767175942](https://github.com/TheAsrada/ChiselCode/actions/runs/38767175942) на `5b34cef`, attempt 1: success. Единственный job `Fast checks` завершился за 25 секунд (16:13:35–16:14:00 UTC, 15.10.2026), включая setup/cleanup. Внутри: 343 pass, 0 fail, 2859 assertions, 38 files, 1210 мс; typecheck — 3 секунды, lint — 2, build — 1, установка зависимостей — 5. Эти длительности steps округлены GitHub до секунд. Локально также прошли typecheck, lint (существующие warnings сохранены), build/CLI version, actionlint четырёх workflows и проверка 110 относительных ссылок/anchors в восьми Markdown.

Полная новая native-матрица, каталог LSP и положительная реальная проверка release gate в этом задании не запускались; Windows/macOS изменения crash harness пока не подтверждены. Реальный GitHub API ранее подтвердил отказ gate принимать незавершённый run; его новый контракт проверен четырьмя unit tests внутри быстрого профиля. Новый выпуск не запрошен.
