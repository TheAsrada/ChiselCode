# Changelog

All notable changes to ChiselCode are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.10] - 2026-09-12

### Fixed

- Сборка установщика: пути к LICENSE и EXE в `installer/chiselcode.nsi` заданы через `${__FILEDIR__}`, так как makensis резолвит относительные пути от папки скрипта. Релиз v0.1.9 вышел без `ChiselCode-Setup-*.exe`; установщик публикуется начиная с v0.1.10.
- Тесты `resolveProjectDir`: сравнение с `realpath`, так как tmpdir может содержать симлинки (`/var` → `/private/var` на macOS, короткие имена 8.3 на Windows).

## [0.1.9] - 2026-09-12

### Added

- Windows-установщик `ChiselCode-Setup-<версия>.exe` в каждом релизе: ставится без прав администратора в `%LOCALAPPDATA%\ChiselCode`, добавляет `chisel` в пользовательский PATH, создаёт ярлыки в меню «Пуск» и деинсталлятор.
- Команда чата `/cwd <путь>`: смена папки проекта без перезапуска — можно запустить `chisel` из любого места и просто указать путь к проекту или файлу в чате. Без аргументов показывает текущую папку; новая папка начинает новую сессию.

## [0.1.8] - 2026-09-12

### Fixed

- Исправлено мгновенное закрытие `chisel-windows-x64.exe` при запуске: корневая команда теперь объявляет аргумент `[prompt...]`, поэтому `chisel "задача"` больше не падает с `too many arguments`, а запуск без аргументов открывает TUI вместо падения с объектом опций вместо промпта.
- Окно больше не исчезает без сообщения: на Windows при запуске двойным кликом (родитель — Explorer) программа ждёт Enter перед выходом, а фатальные ошибки всегда показывают подсказку про запуск из PowerShell. Флаги `--pause` / `--no-pause` управляют паузой вручную.
- Добавлен текстовый fallback-режим: если Ink не может включить raw mode в урезанной консоли, включается простой построчный интерфейс (ввод, `/help`, `/status`, `/exit`, подтверждение `y/N`), а мастер настройки работает через обычные вопросы.

## [0.1.7] - 2026-09-12

### Added

- Режим `anthropic-compatible` для прокси, которые реализуют Anthropic Messages API: `POST /v1/messages` с Bearer-токеном, отдельным базовым URL и моделью.
- Четвёртый вариант `chisel setup` и настройка `/settings` для Anthropic-совместимого API.

## [0.1.6] - 2026-09-12

### Added

- Claude Code-подобные быстрые команды в интерактивном режиме: `/help`, `/clear`, `/settings`, `/model`, `/status`, `/exit` с подсказками и автодополнением по `/`.
- Компактное безопасное меню `/settings` для смены сервиса, модели и адреса совместимого API без показа ключа.
- Многострочный редактор ввода: Enter — отправка, Shift+Enter — новая строка, ↑/↓ — история запросов, Tab — дополнить команду.

### Changed

- Изменения модели, сервиса и адреса API из настроек применяются к следующим запросам текущего сеанса.

## [0.1.5] - 2026-09-12

### Fixed

- Retry once when an OpenAI-compatible server ends a successful request without text instead of showing the internal `completed` status.
- Recognize common streamed reasoning fields without rendering private reasoning as the final answer.
- Show an actionable diagnostic if a provider still returns no final text.

## [0.1.4] - 2026-09-12

### Added

- Guided first-run setup, `chisel setup`, and a non-secret `chisel doctor` diagnostic.
- Automatic setup in interactive mode when no API key is configured.
- Beginner-focused Windows quick start and troubleshooting guide.

### Changed

- Translate the interactive welcome and approval experience into Russian.
- Explain missing API-key failures with an actionable setup command.

## [0.1.3] - 2026-09-11

### Fixed

- Include Ink's optional development-tools peer dependency in the standalone bundle dependency graph.

## [0.1.2] - 2026-09-11

### Fixed

- Run the repository-pinned Biome binary in package scripts instead of fetching a formatter dynamically.

## [0.1.1] - 2026-09-11

### Fixed

- Normalize asynchronous tool failures into structured tool results so policy violations do not terminate the agent loop.

## [0.1.0] - 2026-09-11

### Added

- Bun/TypeScript coding-agent CLI with an Ink TUI and one-shot mode.
- Anthropic, OpenAI, and OpenAI-compatible provider adapters.
- Secure project-scoped file, search, shell, and Git tools with approval previews.
- Persistent sessions, context composition, credential fallback storage, and JSON output.
- Unit and integration test coverage, formatting/lint checks, and release automation.
