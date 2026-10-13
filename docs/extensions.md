# Установка и управление расширениями

[Документация](README.md) · [Для разработчика](extensions/README.md) · [Безопасность](security.md)

Расширение добавляет инструменты, команды, статусы, представления и темы. Укажите локальную подготовленную папку или ZIP. ChiselCode проверит содержимое без выполнения JavaScript и сохранит самостоятельную копию; исходник после установки больше не нужен.

## Установка

```sh
chisel extensions inspect ./my-extension.zip --json
chisel extensions install ./my-extension.zip --json
```

В ZIP manifest `chisel-extension.json` находится **в корне**, рядом с готовым `.mjs` и assets. Поддерживаются STORE/DEFLATE; TAR/TGZ/RAR/7z, ZIP64, encrypted ZIP и адреса сайтов не поддерживаются. Tarball приложения/SDK `chiselcode-…tgz` не является пакетом расширения.

Установка по умолчанию **выключена и без доверия**. Результат показывает id, digest и installed location. Factory, activation, модель, network, зависимости или install scripts не запускаются.

## Проверка и доверие

Сверьте имя, id, версию, совместимость, конечный путь и полный SHA-256. Подтвердите именно установленное содержимое:

```sh
chisel extensions approve INSTALLED_LOCATION --id author.feature --digest SHA256_ИЗ_INSPECT --enable
```

В терминале появится подтверждение. Без TTY добавьте `--ack-process-access`; для доверия без включения используйте `--disabled` вместо `--enable`. Также доступны `install SOURCE --trust --enable` с interactive confirmation или `install SOURCE --digest SHA256 --ack-process-access --enable` без stdin.

Доверенный JavaScript работает внутри приложения с доступом процесса к файлам, сети и запуску программ. Это **не OS sandbox**. SHA-256 связывает bytes, а не удостоверяет автора. Разрешения штатных инструментов проверяются отдельно при каждом действии.

Доверие привязано к id/version/API/entry, конечному canonical location и всему содержимому, включая assets. Оно не переносится скрыто из исходной папки. Изменённый installed package не исправляется повторным approve: подготовьте новый источник и используйте update.

## Обновление и сохранённые версии

```sh
chisel extensions inspect ./new-package.zip --json
chisel extensions update author.feature ./new-package.zip --digest НОВЫЙ_SHA256 --ack-process-access --json
chisel extensions versions author.feature
chisel extensions rollback author.feature СОХРАНЁННЫЙ_DIGEST --json
```

Update принимает тот же id и требует новое exact trust даже при прежней строке версии. По умолчанию сохраняется включённость пользователя; ранее выключенный пакет не включается сам. Проверка, отказ от trust, отмена и stale conflict сохраняют прежний выбранный пакет. Для намеренного downgrade из нового источника нужен `--allow-downgrade`; rollback явно выбирает сохранённую версию и перепроверяет её receipt.

До четырёх неиспользуемых предыдущих версий сохраняются автоматически. Выбранные, используемые и неизвестные recovery versions защищены. Если одинаковый digest соответствует нескольким legacy locations, выберите точный key из `versions`.

## Включение, выключение и удаление

```sh
chisel extensions enable author.feature
chisel extensions disable author.feature
chisel extensions remove author.feature --json
```

Enable требует неизменный совместимый пакет с уже выданным trust. Disable сохраняет пакет, данные и доверие. Remove удаляет подключение, а затем только подтверждённо принадлежащие менеджеру неиспользуемые bytes. Загруженная версия продолжает работать до restart; её физическое удаление откладывается. Неизвестный владелец также защищает файлы.

Беседы, artifacts, worktrees, результаты инструментов, пользовательские файлы, желаемая тема и accent сохраняются. Вручную подготовленные legacy folders не удаляются: убирается только подключение, путь показывается в результате. Remove не останавливает фоновые задачи и не обещает выгрузить произвольный JS.

## Запуск, статусы и восстановление

После изменения code/trust/enabled/selection перезапустите приложение:

```sh
chisel extensions status --json
chisel extensions recover --json
chisel --no-external-extensions
```

Status показывает desired state и отдельно known version uses. Он не импортирует пакет и не объявляет чужой workspace active. Recovery проверяет journals, убирает доказанно owned abandoned staging и безопасные неиспользуемые versions. После crash неизвестные use records сохраняют bytes; мёртвый PID сам по себе не разрешает их стирание. Автоматического replay/import/trust нет.

`--no-external-extensions` оставляет встроенные возможности и исключает внешние импорты. Help/version/doctor и package-management commands также не выполняют пользовательский код и не требуют API-ключа. Некорректный/future registry не заменяется пустым.

Изменённая или исчезнувшая тема расширения после restart даёт встроенный Obsidian с уведомлением. Desired theme и accent не переписываются. Пока приложение работает, его каталог и действия принадлежат загруженной версии.

Проект только сужает user выбор в `.chiselrc`:

```json
{"externalExtensions":{"disabledIds":["author.feature"]}}
```

`disabled: true` запрещает все внешние пакеты для проекта. Project не устанавливает код, не выбирает source/версию и не выдаёт trust.

## Доступность и границы

Loader/SDK опубликованы в [0.6.25](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.25), темы — в [0.6.26](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.26). Описанный менеджер пакетов добавлен в текущем main; опубликованный 0.6.26 этих новых CLI operations ещё не содержит. Номер нового релиза будет указан после публикации.

Полный Settings → Extensions добавляется отдельно. Нет marketplace, загрузки из npm/GitHub/URL, install scripts, runtime TS/JSX, native dependency resolver, hot reload или sandbox изолированного JS.

Связанные темы: [темы интерфейса](themes.md), [статусы и панели](interface-contributions.md), [разрешения](permissions.md), [упаковка и lifecycle](extensions/package-management.md), [ошибки запуска](troubleshooting.md).
