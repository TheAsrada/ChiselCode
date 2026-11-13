# Выпуск ChiselCode CLI 0.6.54

[Материалы для участников](../README.md) · [Установка CLI](../../installation.md) · [Фоновые задачи](../../background-tasks.md)

Выпуск [CLI 0.6.54](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.54) собран из коммита [6d1a2e10f751e7d43c5c83f377821f9e0d7d14d6](https://github.com/TheAsrada/ChiselCode/commit/6d1a2e10f751e7d43c5c83f377821f9e0d7d14d6).

## Исправление

На Linux GNU `timeout` создаёт дополнительную группу внутри сессии оболочки. Supervisor учитывает все группы этой сессии и проверяет дерево после выхода оболочки и закрытия каналов вывода. Подтверждённое завершение позволяет продолжить работу с проектом. Если завершение не подтверждено, локальный и межпроцессный координаторы сохраняют ресурс и возвращают `BACKGROUND_RECOVERY_REQUIRED` с состоянием `cleanup_unknown`. Просмотр и управление задачей привязаны к исходному владельцу.

Локально на Linux x64 сценарий `timeout 3 sleep 0.4; printf done` до исправления давал exit 0 и `cleanup_unknown`. После исправления интеграционный тест проверяет чтение второй сессией, остановку группы по дедлайну ChiselCode и сохранение блокировки при отдельной сессии потомка. Локальный CLI-тест с SSE-провайдером проверил чтение файла из второго процесса и через readonly-помощника на исходниках, собранном бинарнике и изолированно установленном npm-архиве. Обновлены справка фоновых задач, архитектура, диагностика и CHANGELOG. [Воспроизведение](../testing.md#обычные-изменения).

В выпуск также вошёл попиксельный вывод логотипа главной. Кадры настоящего OpenTUI в Foot показывают результат в темах Paper и Obsidian. [Проверка логотипа](../../assets/logo-linux/README.md#попиксельный-вывод-coder-mini).

## Проверки перед тегом

[Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/43473543672) и [Docs CI](https://github.com/TheAsrada/ChiselCode/actions/runs/43473543997) успешны. Скрипт `verify-release-ci.ts` подтвердил шесть обязательных jobs и steps [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/43473543735) на release source.

| Платформа | Результат |
| --- | --- |
| Linux x64 | Полный source, 1594 passed, 3 skipped, 0 failed, 203 файла. Полнота JUnit подтверждена. Успешны installed/compiled CLI и SDK, Linux package/curl lifecycle и native OpenTUI smoke. |
| macOS arm64 | Платформенный набор, 535 passed, 3 skipped, 0 failed, 69 файлов. Успешны LSP, installed/compiled CLI и SDK, native OpenTUI smoke. |
| Windows x64 | Платформенный набор, 537 passed, 1 skipped, 0 failed, 69 файлов. Успешны LSP, installed/compiled CLI и SDK, native OpenTUI smoke, updater и ярлыки. |

Первый [macOS smoke](https://github.com/TheAsrada/ChiselCode/actions/runs/43473543735/job/132051363800) отменён GitHub без запуска шагов: hosted runner не получил job после нескольких попыток. [Повтор только этого job](https://github.com/TheAsrada/ChiselCode/actions/runs/43473543735/job/132060796108) прошёл на том же SHA, остальные пять результатов сохранились.

Локально на Linux прошли 47 связанных тестов с двумя Windows-пропусками, 528 быстрых тестов, typecheck, lint, сборка и проверка документации.

## Публикация

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/43478400020) успешно собрал и опубликовал шесть установщиков, переносимый Linux-архив, `install.sh`, рецепты Homebrew/AUR, npm-архив CLI с SDK и `SHA256SUMS`.

| Файл | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-0.6.54-linux-x64.tar.gz` | 46381414 | `dd2f313b5a5e27b299d108a25d6a959904cab70aecf5e21472918071f7bee7bd` |
| `ChiselCode-Setup-0.6.54-linux-amd64.deb` | 39444108 | `37839c3bc0db10f3a91902e633933ced24816cde013f57901b09a16add37c2f0` |
| `ChiselCode-Setup-0.6.54-linux-x86_64.pkg.tar.zst` | 45484450 | `77e7e58dc09b76699b0ad9526b1bd7c54fd4295601deed7ff266e06edac6c57a` |
| `ChiselCode-Setup-0.6.54-linux-x86_64.rpm` | 45618284 | `a3f381fe6fca0fe3a98e846bb3651583bc49a803096828fad0aa672263a90783` |
| `ChiselCode-Setup-0.6.54-macos-arm64.pkg` | 33461721 | `7c634979655adb080f93954ec5de72541b012c0c0a64c4339fc45968463a7647` |
| `ChiselCode-Setup-0.6.54-macos-x64.pkg` | 36045630 | `8f0846fcd100eb64d5fc472694b79b6e86cf44c0b245c63679d643e48a1078b1` |
| `ChiselCode-Setup-0.6.54.exe` | 38792781 | `81abb788a6f5fc99439229d4dd2486320c7a4a47cd056f90d22153a7b658ae72` |
| `SHA256SUMS` | 1073 | `d262b4866f7af69e376a263626173f6221fd962eb789e92e2f0fb25f8b53947d` |
| `chiselcode-0.6.54-aur.tar.gz` | 715 | `061704d4310fd05c2be78e4c1d913abe237975e8425dd92067ff4850948476dd` |
| `chiselcode-0.6.54.tgz` | 5964242 | `80dad79dc5c9ff97a4314a66d10c9e51da74c482bdc851fb6e92f222998c6b3a` |
| `chiselcode.rb` | 571 | `c1d55c20847cf0c29aa53ac42704d422cc9e9135a2251fda37e6a25899a0d55d` |
| `install.sh` | 2730 | `9e4cca9105cf677f8665303fba6f2e9f136815f4f9b45b5177d1c2af58db040b` |

Скачаны все 12 файлов. Для каждого проверены статус `uploaded`, размер и SHA-256 из GitHub API, включая сам `SHA256SUMS`. Команда `sha256sum -c SHA256SUMS` подтвердила 11 перечисленных файлов. Тег указывает на проверенный source.

Бинарник из переносимого Linux-архива и бинарник из DEB побайтово совпали. Оба запущены и показали `0.6.54`. На опубликованном переносимом бинарнике и CLI из опубликованного npm-архива повторён сценарий `run_shell` → `read_file` из второго процесса и readonly-помощника.

## Границы проверки

Полный source-набор выполнялся на Linux. Windows и macOS проверены платформенными наборами и smoke. Скачанные EXE и PKG вручную не устанавливались. macOS x64 собран, запуск на Intel Mac не проверялся. Установщики выпущены без подписи, macOS PKG без нотариального заверения. Linux-поставка рассчитана на x64 с glibc.

Архив npm и рецепты Homebrew/AUR доступны в GitHub Release. Публикация в npm registry, отдельный Homebrew tap и AUR не выполнялась.
