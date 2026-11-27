# Выпуск ChiselCode CLI 0.6.59

[Материалы для участников](../README.md) · [Установка CLI](../../installation.md) · [История изменений](../../../CHANGELOG.md)

Выпуск опубликован 27 ноября 2026 года в 05:50:24 UTC. Тег `v0.6.59` указывает на коммит `ff08517ca5e98b9e5e9ceb40a5a9bb995a5a7181` из `main`. [Выпуск](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.59) · [Исходный коммит](https://github.com/TheAsrada/ChiselCode/commit/ff08517ca5e98b9e5e9ceb40a5a9bb995a5a7181).

## Системный промпт GPT‑6.2

Sol, Astra и известные алиасы получают адаптацию универсального промпта. Универсальная основа для остальных моделей сохранена побайтно. Основной агент и помощник выбирают профиль по своей модели. Провайдер ChatGPT передаёт выбранный промпт GPT‑6.2 первым сообщением `developer`. [Профили и сборка промпта](../../architecture/system-prompt.md) · [Поток Responses](../../architecture/chatgpt.md#поток-ответов).

## Проверки

- На Linux прошли 546 быстрых и 26 целевых тестов, typecheck, lint, проверка документации и сборка CLI и SDK. Семь mock coding evals подтвердили выбранный текст и его SHA‑256 в отчёте.
- Quick CI и все шесть обязательных задач Native validation прошли на коммите выпуска. Полный набор на Linux включал 210 файлов: 1643 успешных теста, 3 платформенных пропуска. Installed и compiled smoke прошли на Linux x64, macOS arm64 и Windows x64. [Quick CI](https://github.com/TheAsrada/ChiselCode/actions/runs/45946652093) · [Native validation](https://github.com/TheAsrada/ChiselCode/actions/runs/45946652104).
- Локальный HTTP-сценарий проверил профиль GPT‑6.2 в основном запросе, алиас у помощника и универсальный текст у GPT‑6.1. Из установленного npm-пакета, локального compiled CLI и опубликованного Linux-бинарника также прошёл сценарий помощника с выбором модели и чтением файла. Качество ответов на живых моделях не измерялось.

## Публикация

Опубликованы шесть установщиков, переносимый архив Linux x64, npm-архив с SDK, скрипт установки, рецепты Homebrew и AUR и `SHA256SUMS`. Все 11 записей из `SHA256SUMS` совпали со скачанными файлами. Для всех 12 файлов сверены имена, размеры, статус загрузки и SHA‑256 с GitHub API. На скачанном Linux-бинарнике подтверждена версия `0.6.59`. [Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/45947914461) · [Контрольные суммы](https://github.com/TheAsrada/ChiselCode/releases/download/v0.6.59/SHA256SUMS).

Установщики Windows и macOS опубликованы без подписи, macOS PKG без нотариального заверения. Пакет macOS x64 собран, запуск на Intel Mac не проверялся. Linux-поставка рассчитана на x64 с glibc. Архив npm и рецепты доступны в файлах GitHub Release.
