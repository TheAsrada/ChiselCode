# Выпуск ChiselCode CLI 0.6.53

[Материалы для участников](../README.md) · [Установка CLI](../../installation.md) · [Диагностика команд](../../background-tasks.md#причина-завершения-обычной-команды)

Выпуск: [CLI 0.6.53](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.53). Тег `v0.6.53` указывает на source [`c351ccd9048b8eada963fb8b7777748be8be9ff7`](https://github.com/TheAsrada/ChiselCode/commit/c351ccd9048b8eada963fb8b7777748be8be9ff7). Работа выполнена в `main`; документация с результатами опубликована отдельным коммитом после выпуска.

## Что изменилось

`ManagedOutcome` остаётся единственным наблюдавшимся исходом процесса. Foreground и HostSandboxExecutor используют общее преобразование в результат инструмента: код или `null`, сигнал, причина, заданный лимит, измеренное ожидание и cleanup. Очищенный ProcessLog сохраняется отдельно от сводки. Причина остаётся в сообщении модели после переноса лога в artifact; полный захваченный лог отличается от неполного захвата. Сбой захвата при exit 0 не считается успехом. Сохранены approvals, состояние отмены, cleanup и защитные блокировки. Подтверждённый выход не затирается поздним AbortSignal или hook.

Референсы: [OpenCode 2.2.7](https://github.com/anomalyco/opencode/releases/tag/v2.2.7) и [патч #62141](https://github.com/anomalyco/opencode/pull/62141). В его notice время тайм-аута берётся из заданного лимита, а для сигнала может вычисляться условный код `128 + N`. ChiselCode хранит наблюдавшиеся сигнал и exit code раздельно и измеряет ожидание отдельно от лимита и cleanup. Исправление Store PowerShell 7 относится к запуску pwsh в OpenCode; ChiselCode сохраняет штатный CMD-транспорт, проверенный на Windows.

Публичный ToolExecutionResult и SDK не изменены. Необязательные данные находятся в `details.shell`. Проверены сообщение провайдеру после offload, сериализация результата через SessionV3Schema, результат без нового поля и hooks. Installed/compiled SDK smoke сохранили работу внешних расширений.

## Проверки перед тегом

[Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/43029679867) и все шесть jobs [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/43029679848) успешны на release source. Скрипт `verify-release-ci.ts` подтвердил каждый обязательный job и step до отправки тега; Release повторил допуск перед сборкой и публикацией.

| Job | Результат | Длительность, с |
| --- | --- | ---: |
| [Full source (ubuntu-latest)](https://github.com/TheAsrada/ChiselCode/actions/runs/43029679848/job/130553367942) | Успешно | 491 |
| [LSP lifecycle (macos-latest)](https://github.com/TheAsrada/ChiselCode/actions/runs/43029679848/job/130553367731) | Успешно | 180 |
| [LSP lifecycle (windows-latest)](https://github.com/TheAsrada/ChiselCode/actions/runs/43029679848/job/130553367672) | Успешно | 245 |
| [Native smoke (macos-latest)](https://github.com/TheAsrada/ChiselCode/actions/runs/43029679848/job/130553367853) | Успешно | 464 |
| [Native smoke (ubuntu-latest)](https://github.com/TheAsrada/ChiselCode/actions/runs/43029679848/job/130553368237) | Успешно | 294 |
| [Native smoke (windows-latest)](https://github.com/TheAsrada/ChiselCode/actions/runs/43029679848/job/130553367308) | Успешно | 738 |

Native validation заняла 758 с от создания до завершения; сумма длительностей jobs — 2412 с.

| ОС | Фактическое покрытие |
| --- | --- |
| Linux | Полный source: 1592 passed, 3 skipped, 0 failed, 203 файла, 432,03 с. Проверка полноты JUnit успешна. Installed/compiled CLI и SDK, настоящий runtime, Linux packages/curl lifecycle и native UI smoke успешны. |
| macOS arm64 | Платформенный набор: 535 passed, 3 skipped, 0 failed, 69 файлов. Полные shell-runtime/background-process, LSP lifecycle, installed/compiled CLI и SDK, native UI smoke успешны. |
| Windows x64 | Платформенный набор: 537 passed, 1 skipped, 0 failed, 69 файлов. Штатный CMD, Unicode, оба пути диагностики, LSP lifecycle, updater/NSIS, ярлыки, installed/compiled CLI и SDK, native UI smoke успешны. |

Общий shell harness запускает реальные процессы через foreground и fallback: exit 0/7, POSIX SIGTERM с `exitCode=null`, тайм-аут с частичным выводом, отмену, ошибку close захвата при exit 0, лимит захвата при быстром выходе и длинный UTF-8 лог. Проверка логов не заменяет код команды кодом supervisor.

Локально на Linux прошли 48 точечных тестов runtime/process/workspace (2 Windows-only пропущены), повторная проверка полного shell-файла после уточнения гонки (10 passed, 2 skipped), background-runtime fixture, typecheck, lint, build и docs:check. `bun run test:fast`: 528 passed, 0 failed. Первый локальный fast-прогон дал 527 passed и отказ одного теста ChatGPT Responses; отдельно все 10 тестов файла и следующий fast-прогон прошли. Причина единичного отказа не воспроизвелась; проверки не отключались.

Первый push `56dbbd1` прошёл Quick CI; его незавершённый Native validation заменён новым push с уточнением гонки лимита захвата. Для допуска использованы только результаты `c351ccd`.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/43031636611) завершился успешно за 187 с на том же SHA. Опубликованы шесть установщиков CLI, переносимый Linux-архив, install.sh, рецепты Homebrew/AUR, npm-архив SDK и SHA256SUMS.

| Файл | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-0.6.53-linux-x64.tar.gz` | 46381124 | `b2cfaa159e12add31a4a753a19d154a6440ba50a5279f0f5ad324a77566b61b7` |
| `ChiselCode-Setup-0.6.53-linux-amd64.deb` | 39444148 | `37ef7ac6079fc071c73e655e61ff53e46c8366c07380f9210cf2a2826d0ad136` |
| `ChiselCode-Setup-0.6.53-linux-x86_64.pkg.tar.zst` | 45483222 | `e93ac510cb6fee161ecfd6f87771030627082cad5502938768690d0756fe1d79` |
| `ChiselCode-Setup-0.6.53-linux-x86_64.rpm` | 45615598 | `7aae6104c64cbfa01f39691b613feaba5909121a78881d192c11533f500a47ea` |
| `ChiselCode-Setup-0.6.53-macos-arm64.pkg` | 33461332 | `65c9592892a2d89cf104efe03aa85296cf0baef10656dc0ea38e3725093f7736` |
| `ChiselCode-Setup-0.6.53-macos-x64.pkg` | 36044542 | `934678e3cb2a008ddf91b8c01db8a819b2ba20ec0db77e6b462a60654c8a02bb` |
| `ChiselCode-Setup-0.6.53.exe` | 38797290 | `a4b8bc6c37cc838955a02b98fc87c1a40b6d9c8ffd64ce899d8a0c4524619364` |
| `SHA256SUMS` | 1073 | `4910b9b0f967f7ea3dd4e34285fb8360c1566776a23d64f77edff1852c5754b9` |
| `chiselcode-0.6.53-aur.tar.gz` | 713 | `88b2753fbbbce66c46f71628fa547832ba0a89dfd07f1e2bc31354e19cf72740` |
| `chiselcode-0.6.53.tgz` | 5963894 | `f8399aa78c0f72086806beba8a71d87babb66335b904bc00c8cb8d43c7f3bfc1` |
| `chiselcode.rb` | 571 | `456f1ed8a8fa87769c35288fd59896b639ab4ba1c537dd6744d448b2c7bfb642` |
| `install.sh` | 2730 | `976a82167edf58f102c1991a6b1cf570aa56e0f99d5a6251c2f69c92d7fcb05f` |

Все 12 файлов скачаны из опубликованного Release. Независимая сверка с API подтвердила точные имена, `uploaded`, размеры и SHA-256, включая сам SHA256SUMS. `sha256sum -c SHA256SUMS` подтвердил все 11 перечисленных файлов. Локальный gh не поддерживает `--slurp`, поэтому независимая сверка API выполнена через Python; штатная проверка assets в Release успешна.

Бинарник из переносимого Linux-архива и DEB имеет одинаковый SHA-256 `91794c1b60d95fdb6e8fc6fd2c6eaf482eae7e2069d7c9873b7a68ba81019af9`. Оба запущены и показали `0.6.53`. Скачанный compiled payload прошёл manifest-cli: gateway SSE → tool → model → persisted source.

Опубликованный `chiselcode-0.6.53.tgz` установлен через npm в изолированный каталог; CLI показал `0.6.53`. External SDK fixture прошёл на установленном пакете: самостоятельная компиляция автора по declarations, загрузка и доверие, import/read/write/Plan, hooks, отказ изменённому asset и восстановление. SDK взят из скачанного архива, без импорта соседних исходников ядра.

## Границы проверки

Полный source-набор выполнялся на Linux; Windows/macOS выполняли платформенные наборы и smoke. POSIX-сигнал не переносится на Windows как выдуманный числовой код. Ручная установка скачанных EXE и PKG не выполнялась; macOS x64 собран, но запуск на Intel Mac не проверялся. Установщики не подписаны, macOS PKG не нотарифицированы. Linux-поставка — x64 с glibc.

npm-пакет с SDK опубликован как asset GitHub Release и проверен установкой. Публикации в npm registry нет: канал не настроен в workflow, `npm whoami` в среде вернул `ENEEDAUTH`. Рецепты Homebrew/AUR опубликованы в Release; публикация в отдельный tap или AUR не выполнялась.
