# Композиция OpenTUI и создание расширений агентом

[Материалы для участников](../README.md) · [Пользовательское руководство](../../ui-mods.md) · [SDK](../../extensions/ui-composition.md) · [Архитектурное решение и источники Claude mods](../../architecture/ui-contributions.md#композиция-и-live-ui)

Работа в `main`, Unreleased после 0.6.32. Это реализация CLI/OpenTUI; Desktop в эту задачу не входит. Новая версия и релиз не создавались.

## Реализация

Добавлены 29 render sites, декларативные text/value/box/button/native и стабильный порядок слоёв. Пакет может дополнять, скрывать, заменять и оборачивать штатные участки. Сохраняются полная история, защищённые dialogs, ошибки, native editor и работа основной беседы. Дерево валидируется и очищается до публикации; провайдер не исполняется в React render.

`kind: ui` использует отдельный lifecycle на workspace/package. Settings применяет enable/disable, reviewed update и параметры без остановки core и соседнего UI-пакета. UI-tool проходит обычные guards, Plan, approval, очередь и checkpoints; отключение owner отменяет pending approval. Обычные extensions сохраняют restart lifecycle. Неподтверждённый cleanup блокирует повторный UI mount.

Встроенный `extension-creator` доступен автоматически и через slash. Английские инструкции требуют создавать пользовательские подписи на языке беседы. `create_extension` статически проверяет пакет и устанавливает его через атомарный менеджер, выключенным и без доверия. Пакет включается только после exact-content Settings review.

## Реальные кадры

Это `captureSpans()` настоящего OpenTUI с production renderer/controller/executor и реальным managed store; PNG получены скриптом экспорта терминальных кадров без изменения содержимого. Provider в сценарии scripted: он подтверждает передачу bundled skill и authoring tool, не оценивает качество произвольной модели.

| Сценарий | Кадр | Исходный capture |
| --- | --- | --- |
| Агент создал выключенный пакет | [PNG](../../assets/ui-composition/created-disabled.png) | [JSON](../../assets/ui-composition/created-disabled.json) |
| Включение в том же приложении | [PNG](../../assets/ui-composition/enabled-settings.png) | [TXT](../../assets/ui-composition/enabled-settings.txt) |
| Новый логотип главной | [PNG](../../assets/ui-composition/custom-home.png) | [TXT](../../assets/ui-composition/custom-home.txt) |
| Панель и ответы | [PNG](../../assets/ui-composition/live-workbench.png) | [JSON](../../assets/ui-composition/live-workbench.json) |
| Защищённое подтверждение записи | [PNG](../../assets/ui-composition/protected-approval.png) | [TXT](../../assets/ui-composition/protected-approval.txt) |
| Узкий экран 46×25 | [PNG](../../assets/ui-composition/narrow-workbench.png) | [TXT](../../assets/ui-composition/narrow-workbench.txt) |
| Сбой одного провайдера | [PNG](../../assets/ui-composition/provider-fallback.png) | [TXT](../../assets/ui-composition/provider-fallback.txt) |
| Отключение, возврат native UI | [PNG](../../assets/ui-composition/disabled-restored.png) | [TXT](../../assets/ui-composition/disabled-restored.txt) |
| Светлая тема, Unicode | [PNG](../../assets/ui-composition/paper-unicode/live-workbench.png) | [JSON](../../assets/ui-composition/paper-unicode/live-workbench.json) |
| Светлая тема, узкий экран | [PNG](../../assets/ui-composition/paper-unicode/narrow-workbench.png) | [TXT](../../assets/ui-composition/paper-unicode/narrow-workbench.txt) |

## Проверки

Локально Linux, Bun 1.4.3:

- `bun run test:fast`: 356 passed.
- Точечные source tests: порядок нескольких слоёв; normal и structural updates с сохранением cursor/draft; ошибки и циклические DTO; foreign actions; lifecycle нескольких пакетов/проектов; readonly boot и `--no-external-extensions`; Plan/guards и отмена UI approval; отказ/повтор/разрешение записи; защита путей, JS syntax/import closure и неизменность уже установленного пакета.
- Production OpenTUI fixture: автоматический `load_skill` → `create_extension` → отключённый пакет без import → пользовательский review/trust → live UI; mouse Settings и клавиатурные кнопки; native approval; свежий settings snapshot без повторного выполнения ESM module; отключение и checkpoints. Выполнены Obsidian/ASCII и Paper/Unicode, включая 46×25.
- Тот же сценарий выполнен compiled binary `chisel-ui-creator` с установленными рядом bundled skills. Имя соответствует runtime detection установленного `chisel-*`.
- `typecheck`, `lint`, CLI/SDK build прошли. Lint сохраняет существующие warnings/info; ошибок нет. Проверка npm-поставки подтверждает три bundled skill и открывает их из собранного пакета; прежний `/skill-creator` проверен на русском и английском.

Полный Linux source и native-проверки Windows/macOS запускаются отдельно через Native validation на source commit; результаты CI фиксируются после завершения. Новые platform tests проверяют authoring paths и UI lifetime, compiled fixture — поставку навыка и настоящий renderer. Полный source-набор повторно в installed/compiled форматах не запускается.

Воспроизведение кадров:

```bash
CHISEL_CAPTURE_DIR=docs/assets/ui-composition bun tests/fixtures/tui-extension-creator.ts
CHISEL_CAPTURE_THEME=paper CHISEL_CAPTURE_UNICODE=1 CHISEL_CAPTURE_DIR=docs/assets/ui-composition/paper-unicode bun tests/fixtures/tui-extension-creator.ts
python3 scripts/render-terminal-captures.py docs/assets/ui-composition
python3 scripts/render-terminal-captures.py docs/assets/ui-composition/paper-unicode
```
