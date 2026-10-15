# Скачивание файлов и контекст помощников

[Материалы для участников](../README.md) · [Скачивание](../../downloads.md) · [Помощники](../../subagents.md)

База — `main e8bfad2`, CLI 0.6.30. Изменения относятся к текущим исходникам, новый релиз этим заданием не публикуется. Репозиторий концепта Desktop не изменяется.

## Реализация

`web_download` зарегистрирован в core WebToolProvider, а не в extension host. Он использует прежние URL/DNS/TLS/redirect/network boundaries и потоковый SafeWebHttpClient с backpressure. Разрешение сетевого чтения пересекается с разрешением записи; Plan и readonly отклоняются. Coding export ограничен рабочей копией. Системные каталоги разрешаются через ОС, без model-supplied shell command.

Сеть не удерживает workspace lease. Проверенный временный файл публикуется под короткими destination lease и межпроцессным storage lock. No-clobber использует hard link; overwrite требует неизменного назначения и atomic rename. Отмена распространяется на сеть, rate limiter и ожидание lock. Ошибки очищают staging; подтверждённые bytes проверяются перед публикацией.

У помощников удалены token reservations и owner envelope. Сохранены admission/concurrency, время, число шагов/попыток/инструментов, permissions и actual spend. Старые config/record/receipt поля отбрасываются при чтении без потери истории и usage. Отдельных входных/выходных/общих токенных квот нет. ContextManager использует реальные capabilities и обычные настройки модели; auto-compaction сохраняет актуальную задачу и атомарные tool units. Display clipping больше не применяется к model input или полному результату. Preview ограничен, полный большой ответ хранится в доступном родителю артефакте. Model-visible wait/status не повторяют полный task/context/attempt ledger; native details сохраняют полный descriptor.

## Проверки

`tests/integration/web-download.test.ts` использует настоящий HTTP server, production executor и policy. Только socket mapping публичного проверенного адреса направляется в fixture. Проверяются redirect/SSRF, 429/Retry-After/общий deadline, обрыв, размер, существующий файл, overwrite, отмена, отсутствие workspace-wide lease во время сети, конкурирующие записи и cleanup. ОС возвращает абсолютные пути; XDG проверяется с локализованными и перенаправленными каталогами.

`tests/fixtures/subagents-context.ts` использует production SubagentService/runChildAgent, настоящий HTTP driver и локальную scripted модель. Legacy configs с крошечными квотами не влияют на выполнение: проходят model summary и два generation requests с вводом выше прежнего порога, provider output capability 65 536, observed spend 270 000 и чтение полного большого artifact. Это проверка runtime/protocol, не оценка качества внешней LLM.

`tests/fixtures/web-download-cli.ts` проверяет обычный CLI через пользовательский HTTP proxy и публичный адрес, без production test flags. Проверки установленного npm-пакета и compiled CLI включены в штатную CI. `tui-subagent-settings.ts` открывает настоящие настройки с legacy config и проверяет сохранение черновика. [Нативные кадры OpenTUI](../../assets/internet-subagents/graphite-120x40.png): Graphite и Paper, TXT/JSON/PNG, 120×40, 80×24, 40×16 и 24×8.

На Linux прошёл `bun tests/fixtures/web-download-live.ts`: настоящий public search/fetch, readonly child, основной runtime и `web_download` сохранили изображение Python на системный Desktop. Модель scripted и локальная, платных model requests нет. Проверены PNG signature, 83 564 bytes и SHA-256 `515d56e5b2bb0ea82350bc42fca54149ca135815a1c7d3fedd8e44615a77d37a`; источник — `https://www.python.org/static/community_logos/python-logo-master-v3-TM.png`. Фактический путь первого прогона: `/home/agent/Desktop/ChiselCode-network-check-1792047317308.png`.

Штатные quality/build, installed/compiled smoke, native Windows/macOS/Linux и кадры OpenTUI фиксируются после завершения проверок. Онлайн-прогон Linux не объявляет облачные runner folders перенаправленными в настоящий OneDrive и не подменяет проверки остальных платформ.
