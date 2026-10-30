# Запуск приложения и допуск проекта

[Архитектура](../architecture.md) · [Выбор проекта](../getting-started.md#2-выберите-проект) · [Исходный план](../contributors/plans/project-startup.md)

Решение принято 30 октября 2026 года и относится к текущим исходникам `Unreleased`. Опубликованный CLI 0.6.43 не изменён. OpenTUI остаётся на React и закреплённых зависимостях проекта.

## Намерение запуска и пути

`LaunchIntent` сохраняет invocation cwd отдельно от явного `--cwd`. Обычный терминал выбирает свою папку; `--launcher` открывает application home без workspace. Явный `--cwd` имеет приоритет и не получает fallback при ошибке. Задача и `--resume` без допустимого проекта завершаются до запроса модели. Windows-ярлыки и finish-page передают `--launcher`; updater без `RestartCwd` использует тот же вариант.

`ApplicationPaths` собирает ChiselCode Home, каталог credentials, файл глобальной конфигурации по умолчанию, явно используемые `configPath` и собственные файлы установленного runtime. Путь default config берётся из общего helper с загрузчиком, включая Windows без `APPDATA`. Общие `/usr/bin`, `/usr/local/bin`, профиль пользователя и родительский каталог произвольного `configPath` целиком не закрываются. Bun/Node не считаются установленной копией ChiselCode по расположению executable.

`WorkspaceAdmission` проверяет существующий каталог, canonical path и файловую identity. `/cwd` дополнительно принимает файл и выбирает его родителя. Descriptor заморожен и связан с внутренней identity через `WeakMap`: JSON с полем `kind` допуска не выдаёт. Повторная проверка ловит замену папки и symlink перед публикацией scope и при повторном использовании открытого scope.

Служебный root отклоняется. Узкое исключение managed worktree проверяет существующие registry, Git registration, ownership marker, состояние и filesystem stamp в `WorktreeService`. Нативные файловые инструменты используют `WorkspacePolicy`; служебные поддеревья исключаются и при более широком проекте. Это не OS sandbox для shell, MCP/LSP или доверенного JS.

Операции библиотеки навыков имеют собственную файловую границу: `load_skill` читает только объявленный навык с проверкой относительного пути и symlink; `create_skill` передаёт editing engine policy конкретного validated destination или staging. Общий `FilePathPolicy` задаёт только root и resolve; workspace-инструменты по-прежнему получают `WorkspacePolicy` с исключением служебных данных. Библиотечная операция не выдаёт допуск workspace.

## Владельцы application и workspace

`HomeDraftController` использует общую модель представления, но не имеет executor или искусственного root. Он хранит текст, позицию редактора, режимы, модель и привязку выбранного проекта. `TuiController` беседы продолжает требовать строковый `projectPath`; `Session.projectPath` и публичные SDK не становятся nullable.

Application scope читает глобальную конфигурацию, каталог моделей, пользовательскую библиотеку, историю и updater. До выбора проекта нет project config/instructions, активации workspace extensions, MCP/LSP, project session и inference. Settings используют user target; проектная запись и trust без root возвращают явную причину. Для stdio MCP без workspace нужен абсолютный `transport.cwd`; HTTP-настройкам подставной root не нужен.

Проектные действия окна worktree или UI contribution получают отдельного project-bound владельца и существующую очередь/approval resolver. Они не превращают главный черновик в runtime и не создают вкладку только ради открытия окна. Их roots учитываются при освобождении scope, а cleanup ждёт собственной операции. Настоящие беседы, процессы и помощники сохраняют захваченный root независимо от главной и других вкладок.

## Открытие и восстановление

`ProjectOpenService` владеет request ID, отменой, deadline и списком открывающихся roots. Он допускает путь, готовит существующий scope и проверяет owner перед commit выбора. Поздний результат отменённой операции не меняет новый выбор; после завершения I/O освобождаются только неиспользуемые scopes. Проверка UNC может продолжаться в ОС после отмены ожидания UI.

Выбор папки сохраняет набранный текст, режимы и модель и возвращает фокус композеру. Enter закрытия picker не отправляет задачу. Асинхронное восстановление проверяет поколение и revision ввода: даже ввод с последующей очисткой не позволяет старому чтению затереть новое состояние.

Application draft использует UUID экземпляра, отдельные metadata и revision-specific reference в `CredentialStore`. Публикация metadata атомарна под существующим lock. При отказе старый payload не перезаписывается; неопределённый исход публикации не разрешает удалить новый payload. Конфликт сохраняет второй текст под новой identity и возвращает ошибку. Восстановление закрытого экземпляра копирует текст; живой экземпляр не становится целью записи.

История использует `SessionProjectRegistry` и `ProjectSessionStore.listReadonly`, без нового реестра и ремонта индекса при просмотре. Архивный viewer не создаёт controller/executor, не выполняет undo и pending tools и не переписывает session root. Resume обычной истории проверяет исходный путь и сохранённую canonical identity; недоступность оставляет readonly просмотр.

## Контекст запроса и Markdown

`AgentRuntime` строит `RuntimeIdentity` из VERSION, реально захваченных модели/профиля/режимов, adapter и cwd. Для CLI, OpenTUI и помощников используется один builder. После `model.request` routing итоговая модель уточняется core, а изменённый payload пересчитывается; данные расширения не заменяют identity приложения.

Owner-bound порт OpenTUI отдаёт один `UiSnapshot` на попытку. Он участвует в подсчёте и отправке через существующий ephemeral request context, не записываясь в Session, summary или checkpoint. При скрытом владельце возвращается только `ownerVisible: false`; UI другой вкладки и OS-window focus не читаются. Headless возвращает `available: false`. Выбранная следующая модель отличается от обслуживающей запрос.

Inline renderer преобразует только точные HTML-токены `<br>`, `<br/>`, `<br />` без атрибутов, без учёта регистра. Остальной HTML, code и escaped text сохраняют прежнее поведение. Исходный ответ и история не переписываются; native table renderer и узкий fallback получают многострочные chunks.

## Проверки

Логика допуска и контекста входит в быстрый профиль. Настоящий OpenTUI с локальным HTTP-провайдером проверяет пустой старт, архив без исполнения, отказ Home, сохранение текста и отдельную отправку. Renderer, encrypted drafts, реальные Git/leases и Windows updater остаются в source/native проверках. В installed manifest smoke добавлен отказ `--launcher --json` до inference; отдельной копии полного source-набора в поставке нет. Результаты и ограничения фиксируются в [отчёте реализации](../contributors/reports/project-startup.md).
