# Материалы для участников проекта

[Документация](../README.md) · [Разработка](../development.md) · [Карта архитектуры](../architecture.md)

Отчёты фиксируют реализацию и проверки указанного source. Их результаты не распространяются автоматически на последующие изменения. Пользовательские действия описаны в справке, текущие технические контракты — в архитектуре.

## Разработка и правила

- [Окружение и сборка](../development.md).
- [Порядок проверок и CI](testing.md).
- [Проверки отдельных возможностей](feature-checks.md).
- [Правила работы и документации](../../AGENTS.md).
- [Совместная работа с концептом Desktop](desktop-sync.md) — только при отдельном поручении по Desktop.

## Выпуски

| Выпуск | Материалы |
| --- | --- |
| [CLI 0.6.43](reports/release-0.6.43.md) | Исправления установки навыков, допуск source и контрольные суммы |
| [CLI 0.6.42](reports/release-0.6.42.md) | Установка навыков, структура документации, CI и контрольные суммы |
| [CLI 0.6.41](reports/release-0.6.41.md) | Оформление, искра, чистая главная, CI и контрольные суммы |
| [CLI 0.6.40](reports/release-0.6.40.md) | Менеджер рабочих копий, исправления провайдеров и проверка поставки |
| [CLI 0.6.39](reports/release-0.6.39.md) | Допуск source и опубликованные файлы |
| [CLI 0.6.38](reports/release-0.6.38.md) | Интерактивные расширения и события агента |
| [CLI 0.6.37](reports/release-0.6.37.md) | Потоковые ответы и проверка поставки |

История остальных версий находится в [CHANGELOG](../../CHANGELOG.md) и [GitHub Releases](https://github.com/TheAsrada/ChiselCode/releases).

## Реализация

### Интерфейс и работа в чате

| Область | Отчёт |
| --- | --- |
| Общий дизайн и исследование OpenCode | [Оформление интерфейса](reports/interface-design.md) |
| Искра и состояния запроса | [Анимация активности](reports/request-activity.md) |
| Команды на главной | [Главная без служебной ленты](reports/home-commands.md) |
| Главная и автоматическая панель | [Навигация](reports/clean-navigation.md) |
| Графика OpenTUI | [Удаление ASCII и проверки оформления](reports/opentui-graphics.md) |
| Действия агента и навыки | [Сводки инструментов](reports/tool-actions.md) · [Первичная проверка создания навыков](reports/skill-creator.md) |
| Статусы возможностей | [UI contributions](reports/ui-contributions.md) |
| Настройки MCP и навыков | [Встраивание в Settings](reports/settings-tools.md) |

### Расширения

| Область | Отчёт |
| --- | --- |
| Внешние пакеты и SDK | [Загрузка и доверие](reports/external-extension-loader.md) |
| Установка и версии | [Транзакции пакетов](reports/extension-packages.md) |
| Каталог и карточки | [Интерфейс управления](reports/extensions-cards.md) |
| Настройки | [Поля и сохранение](reports/extension-settings.md) |
| Темы | [Подключение палитр](reports/extension-themes.md) |
| Композиция интерфейса | [Создание и live UI](reports/ui-composition.md) |
| Интерактивные элементы и middleware | [Формы, панели и события](reports/extension-widgets.md) |

### Runtime и инструменты

| Область | Отчёт |
| --- | --- |
| Помощники | [Реализация и проверки](reports/subagents.md) |
| Фоновые задачи | [Владение процессами](reports/background-tasks.md) |
| Побочные вопросы | [Запросы модели](reports/model-requests.md) |
| Рабочие копии | [Сервис Git](reports/worktrees.md) · [Графический менеджер](reports/worktree-manager-0.6.40.md) |
| Web Search | [Поисковые сервисы](reports/web-search.md) |
| Скачивание и контекст помощников | [Интернет и дочерние задачи](reports/internet-subagents.md) |
| Обновление Windows | [Замена EXE и перезапуск](reports/windows-update.md) |

## Диагностика и исследования

- [Отказы провайдера и клиентские ошибки](reports/provider-client-diagnostics.md).
- [Сессия с рабочими копиями](reports/worktree-session-review.md).
- [Сохранённые разговоры и снятие квот помощников](reports/conversation-diagnostics.md).
- [Отказы и результаты Web Fetch](reports/web-fetch-diagnostics.md).
- [CI и измерение времени](reports/ci-efficiency.md).
- [История перехода на профили провайдеров](reports/provider-migration.md).

## Планы

- [Контекст агента и Markdown](plans/agent-environment.md) — короткий план достоверной identity запроса, снимка OpenTUI и переносов в таблицах; пока не реализован.
- [Запуск, выбор проекта и контекст приложения](plans/project-startup.md) — план разделения ChiselCode Home и рабочей папки, главной без проекта, допуска worktree и сведений для агента; пока не реализован.
- [Исходный план менеджера рабочих копий](plans/worktree-manager.md); состояние реализации — в отчётах выше.

Планы и исследования сохраняют контекст принятия решений. Наличие плана не означает публикацию возможности.

## Связанные справочники

- [Совместимость OpenTUI](../opentui-compatibility.md) · [Терминальная матрица](../opentui-terminal-matrix.md).
- [Дизайн боковой панели](../design/sidebar.md).
- [Просмотр изменений файлов](../file-edit-ux.md).
