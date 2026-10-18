# Обновление и перезапуск Windows, CLI 0.6.35

[Материалы для участников](../README.md) · [Установка](../../installation.md) · [Архитектурное решение](../../architecture/self-update.md)

CLI 0.6.35 выпущен из `main`. Исправление разделяет обычный выход и выход для обновления. После сохранения черновиков и cleanup обновление завершает процесс без Explorer/`--pause`. NSIS ждёт фактического выхода, сохраняет прежний EXE при блокировке, записывает результат и открывает новое приложение через Windows Shell.

## Настоящие кадры OpenTUI

Кадры получены production `runOpenTuiAgent` в Windows на source `db27cde`. Версия назначения `9.9.9` относится к изолированной fixture: публичный выпуск с таким номером не используется. JSON с native spans и цветами сохранены рядом с PNG; содержимое кадров не менялось. [Успешный Windows-сценарий](https://github.com/TheAsrada/ChiselCode/actions/runs/39101940117) подтверждает тот же source.

| Сценарий | Кадр | Исходный capture |
| --- | --- | --- |
| Установщик скачан и проверен | [PNG](../../assets/windows-update/ready.png) | [JSON](../../assets/windows-update/ready.json) |
| Предыдущая установка остановлена из-за занятого файла | [PNG](../../assets/windows-update/failure.png) | [JSON](../../assets/windows-update/failure.json) |

## Проверки

Локально Linux, Bun 1.4.3: 61 passed в полных файлах `self-update`, `update-controller`, `opentui-update`; быстрый профиль — 358 passed. CLI/SDK build и TypeScript успешны. Новые проверки покрывают отдельный выход, отсутствие принудительного выхода при обычном закрытии, состояние передачи управления, показ прежней ошибки, NSIS quoting и конечный `/D=`. Shared NSIS include скомпилирован makensis 3.11 на Linux; это проверка сборки, не исполнения Windows.

`Windows update regression` запускается явно для узкой диагностики. В обязательном `Native validation` тот же сценарий включён один раз в Windows job, вместе с полными затронутыми тестовыми файлами. Полный source-набор остаётся на Linux.

`tests/fixtures/windows-update.ts` собирает два временных EXE и настоящий NSIS installer с общим production `update.nsh`. Первый EXE запускает production OpenTUI, получает fixture release metadata и скачивает реальные bytes этого установщика с проверкой SHA-256. Модель и внешняя сеть в сценарии не вызываются. После кнопки «Перезапустить» проверяются сохранённый защищённый черновик, завершённый cleanup и выход без паузы. Новый payload фиксирует argv и наличие настоящей консоли. Установленные bytes сравниваются с payload.

Отдельная попытка удерживает файл через Windows `FileShare.Read`: установка обязана завершиться ошибкой, сохранить прежние bytes и показать читаемую причину при следующем запуске клиента. Затем проверяются root path и ID сессии. Сценарий работает только в Windows и отдельной временной папке; записи регистрации приложения, ярлыков и пользовательской библиотеки навыков не выполняются. Это проверка production механизма замены и перезапуска, а не системного GUI всего мастера установки.

Release source — [`db27cde582d8059fb0dd6c86b2fb4ee5aa7b7d6b`](https://github.com/TheAsrada/ChiselCode/commit/db27cde582d8059fb0dd6c86b2fb4ee5aa7b7d6b). [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/39101928434), [узкий Windows-прогон](https://github.com/TheAsrada/ChiselCode/actions/runs/39101940117) и все четыре jobs [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/39102080680) успешны на этом source. Финальный Native run прошёл с первой попытки. CI использует Bun 1.4.2 и Node 24.19.0.

| Проверка release source | Результат |
| --- | --- |
| Полный source-набор, Linux | 1247 passed, 3 skipped, 0 failed; 1250 тестов в 163 файлах, 315,55 с |
| Evals, все категории | 14 из 14 сценариев успешны |
| Windows platform-набор | 300 passed, 1 skipped, 0 failed; 301 тест в 36 файлах, 104,95 с |
| macOS ARM64 platform-набор | 298 passed, 3 skipped, 0 failed; 301 тест в 36 файлах, 52,55 с |
| Узкий Windows-прогон | 61 passed в трёх файлах; настоящий NSIS, protected draft, процесс ожидания, новая консоль, сохранение старого EXE при блокировке, показ причины ошибки, root path и ID сессии |
| Native Linux/macOS/Windows | Успешны installed/compiled CLI и SDK, LSP, процессы, настоящий OpenTUI, compiled creator и MCP/Skills |
| Typecheck, lint, CLI/SDK build | Успешны; lint с warnings/info |

Ранние диагностические прогоны выявили два недостатка fixture: клик до native layout и чтение черновика по короткому Windows alias вместо канонического project path. Исправлены ожидание геометрии и идентичность пути; проверка сохранённого защищённого черновика осталась обязательной. На source `0843e5a` настоящий upgrade и новая консоль уже прошли, но assertion журнала обнаружил production-ошибку: NSIS `FileOpen a` открывает существующий файл с начала. После ожидания теперь явно выполняется `FileSeek END`. Нативная проверка на новом source подтверждает сохранение ранних записей. Таймауты и assertions не ослаблялись; неуспешные прогоны не использовались для допуска к тегу.

Воспроизведение на Windows с Bun и NSIS в PATH:

```powershell
bun test tests/unit/self-update.test.ts tests/unit/update-controller.test.ts tests/unit/opentui-update.test.tsx
bun tests/fixtures/windows-update.ts
```

## Выпуск CLI 0.6.35

[CLI 0.6.35](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.35) опубликован 18 октября 2026 года и проверен как latest, не draft/prerelease. Annotated tag `v0.6.35` указывает на `db27cde582d8059fb0dd6c86b2fb4ee5aa7b7d6b`. Тег создан после всех обязательных успешных jobs на точном source. Production `verify-release-ci.ts` подтвердил допуск до отправки тега и повторно в [Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/39102616965); все jobs Release успешны.

Все пять опубликованных assets скачаны: размеры и SHA-256 совпали с GitHub API, форматы EXE/PKG/DEB/tgz проверены по сигнатурам файлов.

Извлечённый DEB и CLI, установленный из опубликованного npm-архива в отдельный временный prefix, показали `0.6.35` и прошли настоящий manifest/model/tool/persistence smoke с локальным provider. `update --json` опубликованного DEB получил текущий публичный релиз и подтвердил отсутствие более новой версии. SDK из npm импортируется отдельно (`API_VERSION=1`), declarations присутствуют. Все три bundled skill в DEB/npm побайтово совпадают с release source. Установка npm под Node 24.19.0 завершилась с предупреждением engine зависимости OpenTUI о Node ≥26.4; запуск и smoke выполнены под поддерживаемым Bun 1.4.3.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `chiselcode-0.6.35.tgz` | 5863982 | `7b5346ba795cd2a81d0539b199e931875c8565f1abde900c491e93219310a06f` |
| `ChiselCode-Setup-0.6.35-linux-amd64.deb` | 36997320 | `5e30d58cde4501b0a7fe362ab5bc5c22ba35f918ef2f99cf620b1258c640b514` |
| `ChiselCode-Setup-0.6.35-macos-arm64.pkg` | 33359804 | `ddcc047e9266449c3479d2063fe1aad37f5d8d3e5842237fb5308018bcb16078` |
| `ChiselCode-Setup-0.6.35-macos-x64.pkg` | 35944662 | `94ec0790374a83e72258395c5b61198765b6f8fd5acf5ccde4148596c7b0d34e` |
| `ChiselCode-Setup-0.6.35.exe` | 38733184 | `63fd5df49e8c571c23ef6df285a1be398aa0be3c986d2216f7592a50dbb09564` |

При переходе с зависающего клиента до 0.6.35 закройте его окна и запустите новый Windows EXE вручную один раз: исправление в новом бинарнике не меняет уже работающую старую логику. [Порядок восстановления](../../troubleshooting.md#зависает-перезапуск-после-update).

Release проверил запуск Windows x64, Linux x64 и macOS ARM64; macOS x64 собран, запуск на Intel не проверялся. Windows/macOS установщики не подписаны. Сценарий обновления Windows проверен настоящим NSIS и консольными процессами в CI; GUI полного мастера установки и физические терминалы вручную здесь не проверялись. Результаты публикации и кадры фиксируются отдельным коммитом `main`; тег и опубликованные assets не меняются.
