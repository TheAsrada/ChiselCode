# Выпуск ChiselCode CLI 0.6.56

[Материалы для участников](../README.md) · [Установка CLI](../../installation.md) · [Рабочие копии](../../worktrees.md)

[CLI 0.6.56](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.56) опубликован 23.11.2026 в 20:32:59 (UTC+05:00). Тег `v0.6.56` указывает на [коммит `084dcbdf2f64`](https://github.com/TheAsrada/ChiselCode/commit/084dcbdf2f64509f01c397651ade0750927b88fb) из `main`. [История изменений](../../../CHANGELOG.md).

## Рабочие копии во время запроса

Менеджер получает список и diff отдельно от очереди разговора. При удерживаемой блокировке реестра Esc закрывает окно и отменяет ожидание. Интеграционный тест удерживает ответ локального провайдера и подтверждает, что запрос завершается после закрытия меню. Создание, перенос, удаление и открытие используют штатный контур выполнения вкладки. [Устройство менеджера](../../architecture/worktree-manager.md#путь-действия-интерфейса).

## Проверки

- На Linux прошли 536 быстрых тестов, точечные тесты Git и настоящего OpenTUI, typecheck, lint, проверка документации и сборка CLI и SDK.
- Проверка в Linux PTY 92×28 подтвердила загрузку списка во время запроса, закрытие через Esc и завершение ответа. Сценарий прошёл на скомпилированном CLI и из установленного npm-архива.
- Все шесть обязательных jobs прошли на исходном коммите. Полный набор исходных тестов прошёл на Linux (1612 прошли, 3 пропущены, 206 файлов). Платформенные проверки и запуск установленного и скомпилированного CLI выполнены на Linux x64, Windows x64 и macOS arm64. [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/45202617059).

В первой матрице Windows прошла функциональные шаги, включая менеджер рабочих копий. 15-минутный лимит остановил загрузку артефакта. Повтор перестал обновлять статус на платформенных проверках. Для финального исходного коммита общий лимит Windows увеличен до 20 минут. [Первый прогон](https://github.com/TheAsrada/ChiselCode/actions/runs/45191613919/attempts/1).

## Публикация

Опубликованы шесть установщиков, переносимый Linux-архив, npm-архив с SDK, скрипт установки, рецепты Homebrew и AUR и `SHA256SUMS`. У 12 скачанных файлов сверены размеры и SHA-256 с GitHub API. Все 11 записей из `SHA256SUMS` прошли проверку. На опубликованном Linux-бинарнике проверены версия и сценарий закрытия меню во время запроса в PTY. [Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/45205240815).

| Файл | Размер, байт | SHA-256 |
| --- | --- | --- |
| `ChiselCode-0.6.56-linux-x64.tar.gz` | 46397231 | `1f0fbcabd91e1831e77de4d0c780068717289ec7c0153d172eefa6887fe7d17f` |
| `ChiselCode-Setup-0.6.56-linux-amd64.deb` | 39459056 | `82a26df24842aa2e42d0f94576bde506e0b9435e2f1bfe8b42ee27b4d6edfb21` |
| `ChiselCode-Setup-0.6.56-linux-x86_64.pkg.tar.zst` | 45495687 | `60b7e02f026f40aaa301c238bcb9a9395c62286a2bb5897b2fc91d1c31a2e044` |
| `ChiselCode-Setup-0.6.56-linux-x86_64.rpm` | 45630094 | `a319a5913aa9e6635c0266a82d4f7f6a63ebf98c4de39257df7baaa9be293301` |
| `ChiselCode-Setup-0.6.56-macos-arm64.pkg` | 33481994 | `9538b710d7e1ec68d67ca85fe4b231e27df378e081d1900368db4d807d89bc2c` |
| `ChiselCode-Setup-0.6.56-macos-x64.pkg` | 36064684 | `5d9aa552f1ece9f5ee973c31010919e666760d842a434f85b2adf8394d434ee0` |
| `ChiselCode-Setup-0.6.56.exe` | 38805855 | `b9e83877711a9f23f208fc953027ce1583968e908d3056502d9bbb0b8038aaac` |
| `SHA256SUMS` | 1073 | `32c6fc33d09b2a7aadf46e43f16547e46a90fe7796e7ac6f2aba8c5dd0a08a62` |
| `chiselcode-0.6.56-aur.tar.gz` | 714 | `2810c8ae6f9cc93660e45c09a16a37d28f9f35df5c922ceea30c44063d49b85f` |
| `chiselcode-0.6.56.tgz` | 5978820 | `c45b6de04717cca56eedd01a9379a641b98bad1ef073c137a9ee97ebf55a8fc7` |
| `chiselcode.rb` | 571 | `0cb24340b6eff23e4b4b6b266a9cc8038acef758cd163f452a1d621faf1e350e` |
| `install.sh` | 2730 | `21f5bbd672566f950b4f620ecd4605ed0a4d97db0f3b9dcd4479d1f6f13e6608` |

## Границы проверки

Установщики Windows и macOS опубликованы без подписи. macOS PKG без нотариального заверения. Пакет macOS x64 собран, запуск на Intel Mac не проверялся. Linux-поставка рассчитана на x64 с glibc. Архив npm и рецепты Homebrew и AUR доступны как файлы GitHub Release.
