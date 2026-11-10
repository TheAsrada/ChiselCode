# Границы модулей терминала и сервисов

[Архитектура](../architecture.md) · [Порядок проверок](../contributors/testing.md)

Статус: принято 10 ноября 2026 года, текущие исходники. Рефакторинг сохраняет публичные импорты, DTO, файловые схемы и пользовательские сценарии. Ниже описаны внутренние владельцы и направление зависимостей.

## Терминальное приложение

`opentui-agent.tsx` собирает application lifetime: workspace, renderer, extension host, отмену, очередь операций и общий shutdown. `TuiWorkspace` и `TuiTabExecution` по-прежнему владеют разговорами, поколениями, approvals и выполняемыми операциями. Application не создаёт второй executor для меню.

| Модуль | Ответственность и состояние |
| --- | --- |
| `workspace-navigation.ts` | Открытие проекта, каталог истории, resume/rename/delete. Каждый action захватывает controller и generation; `ProjectOpenService` остаётся владельцем допуска, отмены и deadline, окно — владельцем `DirectoryBrowser`. |
| `model-catalog-controller.ts` | Application cache моделей, номера запросов и generation invalidation; прогрев capabilities проверяет поколение адресованного controller. |
| `model-selection-actions.ts` | Загрузка и явный выбор модели исходного разговора, запись preferences через общую очередь. |
| `application-settings-actions.ts` | Адаптеры Settings к provider/config stores и проектным сервисам. `ApplicationPreferences` и очередь сохранений принадлежат приложению; адаптеры используют один объект состояния. |
| `use-conversation-bindings.ts` | Подписка на conversation view, binding UI contributions, восстановление native курсора и прокрутки. Cleanup снимает подписки и освобождает только созданный им binding. |
| `opentui-composer.tsx` | Отображение подсказок, режимов и native editor через данные и callbacks. Решения об отправке, фокусе и изменении черновика принимает экран. |
| `use-connection-settings.ts` | Черновик подключения, подтверждённый baseline, авторизация и её `AbortController`, номера асинхронных операций, connection autosave. |
| `use-connection-settings-model.ts` | Производные строки, поиск, выбор и признаки dirty; не записывает настройки и не запускает операции. |
| `opentui-settings.tsx` | Маршруты, фокус оболочки, размеры, предпросмотр темы и состав вложенных панелей. Перед переходом завершает их `flush`. |

Направление: application → actions/stores и экран → hooks/компоненты. Контракты Settings находятся в `settings-contracts.ts`; прежний импорт `OpenTuiSettingsActions` из `opentui-settings.tsx` сохранён как type re-export. Leaf-модули не импортируют application или экран. Авторизация не переживает смену actions/unmount; поздний ответ не подтверждает новую операцию. Предпросмотр темы очищает сама оболочка.

## Рабочие копии

`WorktreeService` сохраняет владение repository admission, immutable plans, ownership marker, реестром, mutation, reconciliation и use leases. Он проверяет managed identity **до** чтения snapshot. `result-snapshot.ts` получает проверенную Git identity и запись, строит bounded before/after, diff и fingerprints; не выдаёт разрешение и не применяет результат. `observations.ts` содержит общие проверки путей, UTF-8/размера, безопасное чтение и Git status/index observations. Handle файла закрывается там же, где открыт.

Направление: service → snapshot → observations/driver/policy; `contracts.ts` содержит лимиты и публичные типы. Сервис повторно проверяет source/target перед mutation; capability, approval, writer lease, staged writes и rollback остаются на прежнем пути. Публичные exports из `service.ts`, включая `parseWorktreePorcelain`, сохранены.

## Фоновые задачи

`BackgroundTaskService` владеет owners, сериализацией bind/admission, fair queue, tickets, активными процессами, timers, promotion, recovery и передачей lifetime leases. `owner-binding.ts` определяет входной контракт владельца без зависимости от сервиса.

`shell-policy.ts` разрешает shell target/cwd, вычисляет conservative access plan, очищает command preview и повторно проверяет актуальную политику и лимиты. Он не получает registry активных задач и не освобождает ресурсы процесса. Сервис применяет результат в прежних точках перед spawn/promotion и при policy refresh.

`BackgroundTaskJournal` владеет подписками на изменения и публикацией ревизии: render DTO → immutable schema snapshot → task store → conversation receipt → observer. Изменившийся во время записи вывод не попадает в событие предыдущего snapshot. Foreground не создаёт conversation receipt; закрытый owner не получает UI event. Подписка возвращает detach, dispose очищает подписчиков. Journal не останавливает процесс и не снимает lease; ошибки записи по-прежнему обрабатывает process lifecycle сервиса.

Направление: service → policy/journal → существующие policy/storage/config. Journal использует узкие порты записи и владельца; observers не владеют process resources.

## LSP

`LspService` владеет workspace lifetime, конфигурацией, server entries, transport, pending start/restart/stop и поколениями. В нём остаются допуск запроса и финальные fences конфигурации, policy, generation, workspace revision и фактических bytes.

`LspDocumentCache` обслуживает принадлежащие server entries документы: блокировки по файлу, didOpen/didChange/didClose, LRU, diagnostics serial/version evidence, invalidate и ожидание диагностики. Cache использует узкий host-port для текущей конфигурации, составного signal, признака закрытия и уведомления об изменении; он не может запустить или перезапустить сервер. Очистка lifetime сначала отменяет generation и закрывает transport, затем очищает документы и locks. `safe-text.ts` содержит очистку сообщений; `server-state.ts` — внутренние типы entries, `contracts.ts` — публичные DTO.

Направление: service → cache → documents/transport types/policy. Leaf-модули не импортируют `service.ts`; публичные типы по прежнему пути доступны через re-export. Backends, каталог и provisioning не изменены.

## Проверка границ

Поведенческие сценарии сохраняются в существующих runtime/OpenTUI tests: Worktrees, Background, LSP, project startup/resume, model picker, Settings autosave, composition и tab approvals. `background-journal.test.ts` дополнительно проверяет delayed write с изменением live output, приватность DTO, освобождение подписки и отдельный foreground lane. Он входит в быстрый профиль без процессов и renderer.

Настоящие кадры и воспроизведение: [OpenTUI после рефакторинга](../assets/module-refactoring/README.md). Проверки поставки используют существующий `command-packaging.ts`, полный Linux source и native jobs по [правилам проекта](../contributors/testing.md). Headless кадры не подтверждают отображение в физических терминалах; локальная Linux-проверка не заменяет Windows/macOS jobs.
