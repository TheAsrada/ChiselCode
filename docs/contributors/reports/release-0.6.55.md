# Выпуск ChiselCode CLI 0.6.55

[Материалы для участников](../README.md) · [Установка CLI](../../installation.md) · [Глубина рассуждений](../../model-picker.md#глубина-рассуждений)

Выпуск [CLI 0.6.55](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.55) собран из коммита [`2b3847a919ba`](https://github.com/TheAsrada/ChiselCode/commit/2b3847a919bab7a6da801ea20ce38f6abc26acb6).

## Глубина рассуждений

`/effort` читает доступные для активной модели уровни. Сессия хранит явный выбор в `reasoningEfforts` по паре «профиль + модель». Auto оставляет поле effort вне запроса. Снимок на момент отправки применяется ко всем раундам работы с инструментами и к отложенному сообщению в очереди.

Локальный HTTP-сценарий с настоящим OpenTUI подтвердил, что изменение уровня после постановки сообщения в очередь применяется только к следующей отправке. При переключении между двумя профилями с одинаковой моделью каждый профиль получил свой уровень. Проверены возврат фокуса и черновика по Esc, применение стрелками и Enter, быстрый выбор и сброс. [Кадр 80×24](../../assets/reasoning-effort/effort-80x24.png).

Тесты проверили фактические JSON-тела `reasoning_effort`, `output_config.effort` и `reasoning.effort`. Для моделей без поддержки и при Auto поле отсутствует. Живой GPT‑6.2 Sol через подписку не проверен: доступный вход не предоставил ChatGPT account ID.

## Проверки перед тегом

- Локально на Linux прошли 47 точечных тестов, 534 теста быстрого профиля, typecheck, lint, проверка справки, сборка и открытие `/effort` в Linux PTY 80×24 на скомпилированном CLI и из установленного npm-архива.
- Успешны [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/44996970575) и [Docs](https://github.com/TheAsrada/ChiselCode/actions/runs/44996428662).
- [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/44996970551) прошла на исходном коммите релиза. Linux выполнил полный набор source-тестов (1608 прошли, 3 пропущены, 205 файлов) и smoke поставки. Windows x64 (539 тестов прошли, 2 пропущены) и macOS arm64 (538 прошли, 3 пропущены) выполнили платформенные проверки, LSP и smoke установленного и скомпилированного CLI. Скрипт `verify-release-ci.ts` подтвердил все шесть обязательных jobs и их шаги.

Первый прогон на коммите `2841deb` обнаружил, что тест прокрутки автодополнения рассчитывал позицию `/resume` по прежнему числу команд. Тест сверяет позицию с актуальным реестром и по-прежнему проверяет, что выбранная команда видна за пределами первой страницы. [Первый прогон](https://github.com/TheAsrada/ChiselCode/actions/runs/44996428727).

## Публикация

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/44998050136) опубликовал шесть установщиков, переносимый Linux-архив, npm-архив с SDK, скрипт установки, рецепты Homebrew и AUR и `SHA256SUMS`. Для всех 12 скачанных файлов проверены статус, размер и SHA-256 по GitHub API. 11 файлов из `SHA256SUMS` прошли `sha256sum -c`.

| Файл | Размер, байт | SHA-256 |
| --- | --- | --- |
| `ChiselCode-0.6.55-linux-x64.tar.gz` | 46388110 | `e92598827b9c81de18a27ea0e0c03d279dbb835207ec647c6b7c8e0255d1524d` |
| `ChiselCode-Setup-0.6.55-linux-amd64.deb` | 39451288 | `10ecb917fb3d455cec677c8d9fb660b3e325fdb0b36033d506db76975a343c47` |
| `ChiselCode-Setup-0.6.55-linux-x86_64.pkg.tar.zst` | 45495137 | `99155c3aebc11170b74035e40a47a3eb0019cdcdd236a7b9b6f25e740b6bcb27` |
| `ChiselCode-Setup-0.6.55-linux-x86_64.rpm` | 45625418 | `b1f43528bd9bf301dae5628100a14a7148c95fbe7efbd63fe13a9a208915b64f` |
| `ChiselCode-Setup-0.6.55-macos-arm64.pkg` | 33471443 | `a3fd82e209cb71774deb01317e41e139ced7c1e50ef59c693eedf17c872fcd4b` |
| `ChiselCode-Setup-0.6.55-macos-x64.pkg` | 36055082 | `1a0f5f63a8ffcf2429753014765b07777d7afc1b694df0d694a1af2b7421a0d8` |
| `ChiselCode-Setup-0.6.55.exe` | 38807720 | `61525d3f741a61329990079e1d571cfecf437d00bc6815597e8c51d1a8ac5538` |
| `SHA256SUMS` | 1073 | `b7057098b388c1c65a7e9f1222441902a81e841d160657e1094b590fd775bd9d` |
| `chiselcode-0.6.55-aur.tar.gz` | 718 | `af364bf940cc59a148cc95f21d8eaea87209e699f20ff0989b9222546b66ddf1` |
| `chiselcode-0.6.55.tgz` | 5971995 | `e819cdddfc7af380569cb40ccd07e48f11d0bf7ff36b8cd2b6aac2ad7d1c27cf` |
| `chiselcode.rb` | 571 | `49904f2b4bebb07af2b3c6ec01ed20194f334195a3df1579f7c4ad7697cc8a45` |
| `install.sh` | 2730 | `3cdb484b0fa93fce234e45ce56d91afdaf335af83bd8a41a8e1315848c2a6385` |

## Границы проверки

Установщики Windows и macOS выпущены без подписи. macOS PKG без нотариального заверения. Пакет macOS x64 собран, запуск на Intel Mac не проверялся. Linux-поставка рассчитана на x64 с glibc. Архив npm и рецепты Homebrew и AUR опубликованы как файлы GitHub Release.
