# Скачивание файлов и контекст помощников

[Материалы для участников](../README.md) · [Скачивание](../../downloads.md) · [Помощники](../../subagents.md)

База реализации — `main e8bfad2`, CLI 0.6.30. Реализация завершена до отдельного поручения о выпуске CLI 0.6.31; сведения о публикации приведены ниже. Репозиторий концепта Desktop не изменяется.

## Реализация

`web_download` зарегистрирован в core WebToolProvider, а не в extension host. Он использует прежние URL/DNS/TLS/redirect/network boundaries и потоковый SafeWebHttpClient с backpressure. Разрешение сетевого чтения пересекается с разрешением записи; Plan и readonly отклоняются. Coding export ограничен рабочей копией. Системные каталоги разрешаются через ОС, без model-supplied shell command.

Сеть пишет в закрытый staging canonical Home, не меняет проект и не удерживает workspace lease. Локальная копия рядом с назначением создаётся и удаляется под destination lease и межпроцессным storage lock: короткая файловая фаза не пропускает root shell к sidecar-файлу. Проверяются размер, SHA-256 и повторная revision назначения. Разные диски не требуют межтомного rename. No-clobber использует hard link; overwrite требует неизменного назначения и atomic rename. Отмена распространяется на сеть, rate limiter, копирование и ожидание lock. Ошибки очищают staging.

У помощников удалены token reservations и owner envelope. Сохранены admission/concurrency, время, число шагов/попыток/инструментов, permissions и actual spend. Старые config/record/receipt поля отбрасываются при чтении без потери истории и usage. Отдельных входных/выходных/общих токенных квот нет. ContextManager использует реальные capabilities и обычные настройки модели; auto-compaction сохраняет актуальную задачу и атомарные tool units. Display clipping больше не применяется к model input или полному результату. Preview ограничен, полный большой ответ хранится в доступном родителю артефакте. Model-visible wait/status не повторяют полный task/context/attempt ledger; native details сохраняют полный descriptor.

## Проверки

`tests/integration/web-download.test.ts` использует настоящий HTTP server, production executor и policy. Только socket mapping публичного проверенного адреса направляется в fixture. Проверяются redirect/SSRF, 429/Retry-After/общий deadline, обрыв, размер, существующий файл, overwrite, отмена, отсутствие workspace-wide lease во время сети, конкурирующие записи и cleanup. ОС возвращает абсолютные пути; XDG проверяется с локализованными и перенаправленными каталогами.

`tests/fixtures/subagents-context.ts` использует production SubagentService/runChildAgent, настоящий HTTP driver и локальную scripted модель. Legacy configs с крошечными квотами не влияют на выполнение: проходят model summary и два generation requests с вводом выше прежнего порога, provider output capability 65 536, observed spend 270 000 и чтение полного большого artifact. Это проверка runtime/protocol, не оценка качества внешней LLM.

`tests/fixtures/web-download-cli.ts` проверяет обычный CLI через пользовательский HTTP proxy и публичный адрес, без production test flags. Проверки установленного npm-пакета и compiled CLI включены в штатную CI. `tui-subagent-settings.ts` открывает настоящие настройки с legacy config и проверяет сохранение черновика. [Нативные кадры OpenTUI](../../assets/internet-subagents/graphite-120x40.png): Graphite и Paper, TXT/JSON/PNG, 120×40, 80×24, 40×16 и 24×8.

На Linux прошёл `bun tests/fixtures/web-download-live.ts`: настоящий public search/fetch, readonly child, основной runtime и `web_download` сохранили изображение Python на системный Desktop. Модель scripted и локальная, платных model requests нет. Проверены PNG signature, 83 564 bytes и SHA-256 `515d56e5b2bb0ea82350bc42fca54149ca135815a1c7d3fedd8e44615a77d37a`; источник — `https://www.python.org/static/community_logos/python-logo-master-v3-TM.png`. Повторный онлайн-прогон после изоляции staging на `ecfa6ea` подтвердил тот же PNG и hash; фактический путь: `/home/agent/Desktop/ChiselCode-network-check-1792051168159.png`.

Локально на Linux прошли typecheck, lint (0 errors; 352 warnings, 53 infos), все 14 deterministic evaluations, build и compile. Полный набор на `ecfa6ea` — 1216 pass, 3 платформенных skip, 0 fail, 149 файлов. Отдельные проверки подтверждают корректный прогресс HTTP-сжатия и отсутствие изменений проекта во время сети; root shell видит итог без временных sidecars. Отдельный regression доказывает, что отмена дожидается начатой записи sink: retry/cleanup не опережают запись на диск. Installed/compiled package smoke завершился успешно с настоящими command/side-query/worktree/LSP/subagent/background/UI/loader/theme сценариями. Обычный `web_download` отдельно проверен через установленный npm-пакет и compiled CLI: production permissions, публичный адрес, пользовательский proxy, сохранённый файл и SHA-256.

При native-проверках уточнены три fixtures: получение metadata модели отделено от трёх generation requests SDK smoke; восстановление черновика проверяется после настоящего кадра OpenTUI; отмена durable lock ожидается обычным `await` перед проверкой ошибки. Последнее устранило зависание promise matcher Bun на Windows при ещё ожидающем polling timer. Проверки `CANCELLED`, FIFO и сохранности чужого lock сохранены; отдельный Windows-прогон завершился за секунду.

Отдельный ранний Windows-прогон выявил превышение прежних пяти секунд при холодном запуске PowerShell/C# для Known Folder API. Системному запросу выделено 15 секунд с прежней отменой; два последовательных запроса проверяются в суммарном бюджете 35 секунд. Для теста Web search/fetch с реальными параллельными checkpoints и reload выделен конечный IO budget 15 секунд; для шести модельных шагов с Web, редактированием и настоящим native shell — 30 секунд. HTTP deadline, повторы, разрешения и assertions сохранены.

Нативная [матрица CI](https://github.com/TheAsrada/ChiselCode/actions/runs/38741185672) на source `cc945771a1757ee432b9112c51aaf8cc4c76e6b3`, attempt 1, завершена успешно во всех шести Quality/Real Auto LSP jobs Windows, macOS и Linux. Полные наборы: Linux и macOS — 1216 pass, 3 платформенных skip; Windows — 1217 pass, 2 платформенных skip. Везде 0 fail, 149 файлов. На каждой ОС прошли typecheck, lint, evaluations, build, installed/compiled CLI и SDK smoke; журналы отдельно подтверждают native `web_download` с проверенным файлом и SHA-256 в обоих вариантах поставки. Windows installer проверен локальной сборкой в CI. Нативные кадры сохранены в artifacts этого прогона. Последующий commit отчёта не меняет runtime source.

Онлайн-прогон Linux не объявляет облачные runner folders перенаправленными в настоящий OneDrive. Проверка Windows/macOS использует настоящий системный запрос пути, но реальная синхронизация OneDrive в этой среде не настроена. No-clobber требует hard links; авторизация на сайтах, cookies и resume докачивания в этот scope не входят. Непомещающиеся обязательные правила или само поручение возвращают ограничение настоящего окна модели; отдельные квоты помощника не возвращаются.

## Выпуск CLI 0.6.31

[CLI 0.6.31](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.31) опубликован 15 октября 2026 года в 15:16:04 UTC. Аннотированный тег `v0.6.31` указывает на release source `3d61b6abd004be98c105a7803677e4936c3cddf2`; версии `package.json`, `package-lock.json` и `src/version.ts` согласованы.

До создания тега успешно завершена [native CI-матрица](https://github.com/TheAsrada/ChiselCode/actions/runs/38749466513), итоговый attempt 2: шесть Quality/Real Auto LSP jobs на этом точном source. В первом attempt Windows Ruby preparation завершилась ошибкой, а runtime-тест двух coding-помощников превысил 45 секунд. Оба Windows jobs повторены без изменения кода, таймаутов или assertions и прошли; runtime-тест завершился за 38,3 секунды. Итоговые полные наборы: Windows — 1217 pass, 2 skip; Linux и macOS — 1216 pass, 3 skip. Везде 0 fail, 149 файлов; installed/compiled CLI и SDK smoke успешны.

[Release workflow](https://github.com/TheAsrada/ChiselCode/actions/runs/38757473362), attempt 1, завершился успешно: проверил исходники тега, собрал четыре установщика и архив CLI с SDK расширений, затем опубликовал ровно пять файлов. Все опубликованные файлы скачаны; их размеры и SHA-256 совпали с метаданными GitHub:

| Файл | SHA-256 |
| --- | --- |
| `ChiselCode-Setup-0.6.31.exe` | `679944b3d3c73ffe359ffdd3770db2e84a0859f9b3bfcd7a55987e30e9af06a2` |
| `ChiselCode-Setup-0.6.31-macos-arm64.pkg` | `fc3d2a000afbca114b7b234bae25f1c25bf4d690a6c98d4ce30e387ac2b76585` |
| `ChiselCode-Setup-0.6.31-macos-x64.pkg` | `c9f4e74057aa732861775cb9dac41835f67983784bca595acdb6582d39da1739` |
| `ChiselCode-Setup-0.6.31-linux-amd64.deb` | `9520b6f4f785854a5d64478903be2ed421c91fb74eab2af50eaa8ee784919bc8` |
| `chiselcode-0.6.31.tgz` | `d4c8f7e930bab63db32b15fa20ccab7426cf06363dbffe873e386a595fbff8e6` |

На Linux извлечён payload опубликованного DEB и установлен опубликованный npm-архив в отдельный временный каталог. Оба CLI показали 0.6.31 и прошли `web-download-cli.ts`: production permissions, проверка публичного адреса, доверенный proxy, потоковый файл и проверенный SHA-256. У npm-пакета дополнительно проверены импорт публичного SDK расширений и наличие declarations. Публикация в npm registry не выполнялась.

Native CI запускала runtime на Windows x64, Linux x64 и macOS arm64. macOS x64 проверена кросс-сборкой; запуск на Intel Mac не выполнялся. Интерактивная установка опубликованных EXE/PKG и реальная синхронизация OneDrive не проверялись. Установщики Windows и macOS не подписаны; notarization macOS отсутствует.
