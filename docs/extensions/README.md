# Разработка расширений

[Документация](../README.md) · [Подключение пакета](../extensions.md) · [Архитектурный контракт](../architecture/external-extensions.md)

SDK v1 предназначен для готового self-contained ESM пакета. Runtime helpers предоставляет текущий host через default factory; автору не нужны renderer, внутренние `src` или соседняя копия ChiselCode.

| Задача автора | Руководство |
| --- | --- |
| Собрать первый пакет и подключить его | [Быстрый старт](quickstart.md) |
| Описать manifest, пути и совместимость | [Формат пакета](package.md) |
| Упаковать ZIP и проверить установку/версии | [Пакеты и lifecycle](package-management.md) |
| Определить tools, commands и запрос модели | [Инструменты и команды](tools-commands.md) |
| Добавить chat/UI, context, guards и собственное состояние | [Представления и lifecycle](contributions.md) |
| Добавить светлую и тёмную тему | [Палитры, проверка и lifecycle](themes.md) |
| Добавить общие поля настроек и секреты | [Параметры расширения](settings.md) |
| Проверить сборку и разобраться с отказом | [Проверки и ошибки](testing.md) |

API types: `import type { ExtensionFactory, HostSdk, ActivationContext, ToolDefinition, EffectPlan, ToolResult, Command, ModelPort, UiContribution, UiDetailsView, ServiceToken } from "chiselcode/extension-sdk"`. Полный список public exports находится в declarations этого entrypoint. Runtime export для tooling — только `API_VERSION`; исполняемый пакет использует **injected** `sdk.defineTool` и `sdk.createServiceToken`.

Linked internal barrel `src/extensions/index.ts` остаётся интерфейсом встроенных возможностей и проверок. Он не является публичным SDK. Доверенный код работает in-process; cooperative timeouts и typed ports не изолируют произвольный JS от ОС.
