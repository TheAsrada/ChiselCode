# Выпуск CLI 0.6.45

[Материалы для участников](../README.md) · [Установка](../../installation.md) · [Интерактивный режим](../../interactive.md)

[CLI 0.6.45](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.45) опубликован 02.11.2026 в 06:32:31 UTC. Добавлена ручная команда `/compact`, удалены дублирующие `/new`, `/sidebar`, `/mode`, `/ask` и `/auto`; исправлено повторное автосжатие восстановленной сессии. Подробности — в [CHANGELOG](../../../CHANGELOG.md#0645---2026-11-02).

Release source — `b742391c31c10266dc9fd581e03d87068d38d06c` из `main`. Annotated tag `v0.6.45` указывает на этот SHA. Версии `package.json`, `package-lock.json` и `src/version.ts` равны 0.6.45.

## Проверки release source

[Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/41399040138) и [Docs CI](https://github.com/TheAsrada/ChiselCode/actions/runs/41399040140) прошли на release source. [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/41399058355) завершила все четыре обязательные jobs: полный source-набор на Linux — 1460 pass, 3 skip, 0 fail в 185 файлах; native smoke на Linux, macOS и Windows — успешно. `scripts/verify-release-ci.ts` подтвердил эти jobs на точном SHA перед созданием тега; Release повторил проверку.

Локально на Linux: 27 точечных тестов и 492 быстрых теста прошли; typecheck, lint без ошибок, JS/SDK build, compiled CLI, установка npm-архива и проверка документации прошли. Настоящий кадр OpenTUI с подсказками команд получен через `CHISEL_COMMAND_PREVIEW=1 bun test tests/unit/opentui-spike.test.tsx --test-name-pattern 'slash suggestions keep'`. В кадре видны `/plan`, Shift+Tab и F4. Lint сообщил 412 предупреждений и 58 информационных замечаний, без ошибок.

## Публикация и проверка файлов

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/41400280293) завершил все шесть jobs. Release API подтвердил `v0.6.45`, опубликованное состояние без draft/prerelease и ровно пять assets в состоянии `uploaded`. Все пять файлов скачаны; размеры и локальные SHA-256 совпали с Release API.

| Asset | Размер, байт | SHA-256 |
| --- | ---: | --- |
| `ChiselCode-Setup-0.6.45-linux-amd64.deb` | 37038184 | `431b612d1329a09adb0e71c6e6c9b1566d1bd5a03203b24992350ec9c301f88c` |
| `ChiselCode-Setup-0.6.45-macos-arm64.pkg` | 33420881 | `ae39d8cf75f20960a94ad14d23b7a7c624dd86c2da5b0278bcdb1ed285df340c` |
| `ChiselCode-Setup-0.6.45-macos-x64.pkg` | 36004938 | `710d12b06367c52e215a4d4b1b5400e016fc46db9564f4593a8a6a004a207bf9` |
| `ChiselCode-Setup-0.6.45.exe` | 38766762 | `a05efbbade632c49785bdcd0c42d909ed46319b47ae85018e6cb0d1ac1e26c2d` |
| `chiselcode-0.6.45.tgz` | 5920879 | `b74e1fdb217f55ee44591066f8aef79165edc8b9308844be927564a8f248b902` |

Опубликованный DEB извлечён в отдельную папку: его бинарник вернул `0.6.45`. Опубликованный npm-архив установлен отдельно в offline-режиме: CLI вернул `0.6.45`, declarations extension SDK присутствуют.

## Ограничения проверки

Полный source-набор выполнен на Linux; Windows и macOS получили платформенные проверки и installed/compiled smoke. Скачанные Windows EXE и macOS PKG здесь сверены по размеру и SHA-256, но после публикации локально не запускались; их сборки и проверки выполнял Release workflow. macOS Intel binary собран на ARM64 runner, без отдельного запуска на Intel Mac. Ручная установка через GUI и физические терминалы не проверялись. Windows установщик и пакеты macOS не подписаны и не notarized.
