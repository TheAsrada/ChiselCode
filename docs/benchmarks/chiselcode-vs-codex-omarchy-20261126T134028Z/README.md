# ChiselCode и Codex CLI на Omarchy

[Материалы для участников](../../contributors/README.md)

**COMPLETE** · 48/48 запусков · 24/24 сопоставимых пар.

Модель `gpt-6.2-sol`, reasoning effort `high`. Обе CLI используют ChatGPT из одного аккаунта или workspace. Модель и effort подтверждаются локальными метаданными клиентов.

| Параметр | Значение |
| --- | --- |
| Начало измеряемых запусков, UTC | `2026-11-26T13:41:21.693136+00:00` |
| Завершение раннера, UTC | `2026-11-26T14:27:36.267137+00:00` |
| Полное время работы раннера | 47 мин 8 с, включая preflight и оценку |
| Платформа | Omarchy 4.5.0 · Linux 7.2.15-1-omarchy · x86_64 |
| Python / Git / bubblewrap | 3.14.8 / git version 2.56.0 / bubblewrap 0.13.1 |
| ChiselCode | `0.6.58` · [`7cadfdb9abcc4b6ba2002f4cf3212fe279f606bc`](https://github.com/TheAsrada/ChiselCode/tree/7cadfdb9abcc4b6ba2002f4cf3212fe279f606bc) |
| Codex CLI | `codex-cli 0.166.0` · [`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`](https://github.com/openai/codex/tree/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856) |
| Протокол | 3 повтора · seed 6212 · 720 с на попытку |
| SHA-256 набора | `7eb20cfa8037ac451d22f01f4c623980bf8a884cbde8adaad6069a70b98aacf0` |

SHA-256 обоих установленных исполняемых файлов совпал с бинарниками из опубликованных пакетов Linux x86_64. [ChiselCode v0.6.58](https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.58) · [Codex CLI rust-v0.166.0](https://github.com/openai/codex/releases/tag/rust-v0.166.0)

## Результаты

Задача решена, когда сеанс завершился на указанной модели и effort, исходные публичные тесты сохранены и проходят, а независимый оценщик принял все случаи. В таблице ниже процент по случаям учитывает и частичные правки.

| Показатель | ChiselCode | Codex CLI |
| --- | ---: | ---: |
| Решено / записано | 22/24 | 24/24 |
| Завершено | 22 | 24 |
| Медиана времени решённых, с | 51.225 | 49.759 |
| Входные токены, медиана | 54626 (n=22) | 89946.5 (n=24) |
| Выходные токены, медиана | 1221.5 (n=22) | 1695.5 (n=24) |
| Чтение кэша, медиана | 16128 (n=22) | 63744 (n=24) |
| Вызовы инструментов, медиана | 12 (n=22) | 11 (n=24) |
| Ошибки инструментов, медиана | 0 (n=22) | 1 (n=24) |

| Задача | ChiselCode решено / попыток | ChiselCode средний % | Codex решено / попыток | Codex средний % |
| --- | ---: | ---: | ---: | ---: |
| `alerts` | 3/3 | 100.0% | 3/3 | 100.0% |
| `batches` | 2/3 | 73.3% | 3/3 | 100.0% |
| `cursor` | 3/3 | 100.0% | 3/3 | 100.0% |
| `jobs` | 2/3 | 73.3% | 3/3 | 100.0% |
| `layers` | 3/3 | 100.0% | 3/3 | 100.0% |
| `ledger` | 3/3 | 100.0% | 3/3 | 100.0% |
| `occupancy` | 3/3 | 100.0% | 3/3 | 100.0% |
| `replay` | 3/3 | 100.0% | 3/3 | 100.0% |

Обе CLI решили задачу в 22 парах. В двух остальных решение получил только Codex CLI. Разница ChiselCode − Codex CLI по доле решённых составила −8,33 п. п. при равном весе задач. Описательный 95% bootstrap-интервал по задачам составил от −20,83 до 0 п. п. Выборка из восьми задач ограничивает переносимость оценки. В парах с двумя решениями медиана разницы времени ChiselCode − Codex CLI составила 3,06 с.

## Наблюдения

- Среди 22 пар, где обе CLI решили задачу, ChiselCode затратил меньше времени в 8, Codex CLI — в 14.
- В следующих сессиях ChiselCode сохранил ошибку `unavailable` с сообщением «ChatGPT не завершил ответ». Раннер включил эти попытки в парное сравнение со статусом `failed`. [`r01/batches`](logs/r01/batches/chisel/session-01.json) · [`r02/jobs`](logs/r02/jobs/chisel/session-01.json).

## Статусы запуска

| Статус | ChiselCode | Codex CLI |
| --- | ---: | ---: |
| completed | 22 | 24 |
| failed | 2 | 0 |

## Как интерпретировать

- Время измерено от старта вызова клиента до обнаружения результата и выхода. В ChiselCode учтены TUI, выбор effort и завершение. Проверка оценщиком в длительность клиента не входит.
- Источники токенов и вызовов различаются. Время, токены, ошибки и кэш описывают локально наблюдаемый клиентский сеанс. Оценка цены подписки отсутствует.
- Суффикс модели на стороне серверного развёртывания и фактическая доля reasoning вычислений не наблюдались. CLI подтверждают запрошенное значение `high`.
- По протоколу сетевые сбои, лимиты, ошибки адаптера и отмены исключают пару из оценки. Таймаут задачи считается неуспехом.
- Это авторские задачи с локальными репозиториями, открытым контрактом и различными входами оценщика. Размер набора и общий язык Python ограничивают выводы о других проектах.

## Воспроизведение и журналы

[Точный набор тестов, фикстуры, оценщик и команды запуска](tests/README.md) · [Результаты по попыткам](RESULTS.json)

Контракты задач доступны в снимке. [alerts](tests/tasks/alerts/TASK.md) · [batches](tests/tasks/batches/TASK.md) · [cursor](tests/tasks/cursor/TASK.md) · [jobs](tests/tasks/jobs/TASK.md) · [layers](tests/tasks/layers/TASK.md) · [ledger](tests/tasks/ledger/TASK.md) · [occupancy](tests/tasks/occupancy/TASK.md) · [replay](tests/tasks/replay/TASK.md)

Из каталога `tests/` на машине с теми же версиями CLI выполните следующие команды.

```bash
python3 run.py selftest
python3 run.py run --out "runs/omarchy-$(date -u +%Y%m%dT%H%M%SZ)" \
  --chisel /usr/bin/chisel --codex "$(readlink -f "$(mise which codex)")"
```

Журналы сохраняют исходный порядок событий. Секреты, личные данные, внутренние инструкции и зашифрованные элементы модели маскируются. Сохранены все 50 выгрузок сессий, включая контрольные, 25 журналов PTY ChiselCode и по 25 файлов stdout и stderr Codex CLI. PTY содержит управляющие символы терминала.

| Прогон | Клиент | Статус | Журналы |
| --- | --- | --- | --- |
| Preflight | chisel | completed | [terminal.log](logs/preflight/chisel/terminal.log) · [session-01.json](logs/preflight/chisel/session-01.json) |
| Preflight | codex | completed | [stdout.jsonl](logs/preflight/codex/stdout.jsonl) · [stderr.log](logs/preflight/codex/stderr.log) · [session-01.jsonl](logs/preflight/codex/session-01.jsonl) |
| `r01/jobs` | codex | completed | [stdout.jsonl](logs/r01/jobs/codex/stdout.jsonl) · [stderr.log](logs/r01/jobs/codex/stderr.log) · [session-01.jsonl](logs/r01/jobs/codex/session-01.jsonl) |
| `r01/jobs` | chisel | completed | [terminal.log](logs/r01/jobs/chisel/terminal.log) · [session-01.json](logs/r01/jobs/chisel/session-01.json) |
| `r01/ledger` | chisel | completed | [terminal.log](logs/r01/ledger/chisel/terminal.log) · [session-01.json](logs/r01/ledger/chisel/session-01.json) |
| `r01/ledger` | codex | completed | [stdout.jsonl](logs/r01/ledger/codex/stdout.jsonl) · [stderr.log](logs/r01/ledger/codex/stderr.log) · [session-01.jsonl](logs/r01/ledger/codex/session-01.jsonl) |
| `r01/cursor` | chisel | completed | [terminal.log](logs/r01/cursor/chisel/terminal.log) · [session-01.json](logs/r01/cursor/chisel/session-01.json) |
| `r01/cursor` | codex | completed | [stdout.jsonl](logs/r01/cursor/codex/stdout.jsonl) · [stderr.log](logs/r01/cursor/codex/stderr.log) · [session-01.jsonl](logs/r01/cursor/codex/session-01.jsonl) |
| `r01/batches` | codex | completed | [stdout.jsonl](logs/r01/batches/codex/stdout.jsonl) · [stderr.log](logs/r01/batches/codex/stderr.log) · [session-01.jsonl](logs/r01/batches/codex/session-01.jsonl) |
| `r01/batches` | chisel | failed | [terminal.log](logs/r01/batches/chisel/terminal.log) · [session-01.json](logs/r01/batches/chisel/session-01.json) |
| `r01/replay` | chisel | completed | [terminal.log](logs/r01/replay/chisel/terminal.log) · [session-01.json](logs/r01/replay/chisel/session-01.json) |
| `r01/replay` | codex | completed | [stdout.jsonl](logs/r01/replay/codex/stdout.jsonl) · [stderr.log](logs/r01/replay/codex/stderr.log) · [session-01.jsonl](logs/r01/replay/codex/session-01.jsonl) |
| `r01/occupancy` | codex | completed | [stdout.jsonl](logs/r01/occupancy/codex/stdout.jsonl) · [stderr.log](logs/r01/occupancy/codex/stderr.log) · [session-01.jsonl](logs/r01/occupancy/codex/session-01.jsonl) |
| `r01/occupancy` | chisel | completed | [terminal.log](logs/r01/occupancy/chisel/terminal.log) · [session-01.json](logs/r01/occupancy/chisel/session-01.json) |
| `r01/layers` | codex | completed | [stdout.jsonl](logs/r01/layers/codex/stdout.jsonl) · [stderr.log](logs/r01/layers/codex/stderr.log) · [session-01.jsonl](logs/r01/layers/codex/session-01.jsonl) |
| `r01/layers` | chisel | completed | [terminal.log](logs/r01/layers/chisel/terminal.log) · [session-01.json](logs/r01/layers/chisel/session-01.json) |
| `r01/alerts` | chisel | completed | [terminal.log](logs/r01/alerts/chisel/terminal.log) · [session-01.json](logs/r01/alerts/chisel/session-01.json) |
| `r01/alerts` | codex | completed | [stdout.jsonl](logs/r01/alerts/codex/stdout.jsonl) · [stderr.log](logs/r01/alerts/codex/stderr.log) · [session-01.jsonl](logs/r01/alerts/codex/session-01.jsonl) |
| `r02/ledger` | codex | completed | [stdout.jsonl](logs/r02/ledger/codex/stdout.jsonl) · [stderr.log](logs/r02/ledger/codex/stderr.log) · [session-01.jsonl](logs/r02/ledger/codex/session-01.jsonl) |
| `r02/ledger` | chisel | completed | [terminal.log](logs/r02/ledger/chisel/terminal.log) · [session-01.json](logs/r02/ledger/chisel/session-01.json) |
| `r02/jobs` | chisel | failed | [terminal.log](logs/r02/jobs/chisel/terminal.log) · [session-01.json](logs/r02/jobs/chisel/session-01.json) |
| `r02/jobs` | codex | completed | [stdout.jsonl](logs/r02/jobs/codex/stdout.jsonl) · [stderr.log](logs/r02/jobs/codex/stderr.log) · [session-01.jsonl](logs/r02/jobs/codex/session-01.jsonl) |
| `r02/replay` | codex | completed | [stdout.jsonl](logs/r02/replay/codex/stdout.jsonl) · [stderr.log](logs/r02/replay/codex/stderr.log) · [session-01.jsonl](logs/r02/replay/codex/session-01.jsonl) |
| `r02/replay` | chisel | completed | [terminal.log](logs/r02/replay/chisel/terminal.log) · [session-01.json](logs/r02/replay/chisel/session-01.json) |
| `r02/batches` | chisel | completed | [terminal.log](logs/r02/batches/chisel/terminal.log) · [session-01.json](logs/r02/batches/chisel/session-01.json) |
| `r02/batches` | codex | completed | [stdout.jsonl](logs/r02/batches/codex/stdout.jsonl) · [stderr.log](logs/r02/batches/codex/stderr.log) · [session-01.jsonl](logs/r02/batches/codex/session-01.jsonl) |
| `r02/occupancy` | chisel | completed | [terminal.log](logs/r02/occupancy/chisel/terminal.log) · [session-01.json](logs/r02/occupancy/chisel/session-01.json) |
| `r02/occupancy` | codex | completed | [stdout.jsonl](logs/r02/occupancy/codex/stdout.jsonl) · [stderr.log](logs/r02/occupancy/codex/stderr.log) · [session-01.jsonl](logs/r02/occupancy/codex/session-01.jsonl) |
| `r02/alerts` | codex | completed | [stdout.jsonl](logs/r02/alerts/codex/stdout.jsonl) · [stderr.log](logs/r02/alerts/codex/stderr.log) · [session-01.jsonl](logs/r02/alerts/codex/session-01.jsonl) |
| `r02/alerts` | chisel | completed | [terminal.log](logs/r02/alerts/chisel/terminal.log) · [session-01.json](logs/r02/alerts/chisel/session-01.json) |
| `r02/cursor` | codex | completed | [stdout.jsonl](logs/r02/cursor/codex/stdout.jsonl) · [stderr.log](logs/r02/cursor/codex/stderr.log) · [session-01.jsonl](logs/r02/cursor/codex/session-01.jsonl) |
| `r02/cursor` | chisel | completed | [terminal.log](logs/r02/cursor/chisel/terminal.log) · [session-01.json](logs/r02/cursor/chisel/session-01.json) |
| `r02/layers` | chisel | completed | [terminal.log](logs/r02/layers/chisel/terminal.log) · [session-01.json](logs/r02/layers/chisel/session-01.json) |
| `r02/layers` | codex | completed | [stdout.jsonl](logs/r02/layers/codex/stdout.jsonl) · [stderr.log](logs/r02/layers/codex/stderr.log) · [session-01.jsonl](logs/r02/layers/codex/session-01.jsonl) |
| `r03/occupancy` | codex | completed | [stdout.jsonl](logs/r03/occupancy/codex/stdout.jsonl) · [stderr.log](logs/r03/occupancy/codex/stderr.log) · [session-01.jsonl](logs/r03/occupancy/codex/session-01.jsonl) |
| `r03/occupancy` | chisel | completed | [terminal.log](logs/r03/occupancy/chisel/terminal.log) · [session-01.json](logs/r03/occupancy/chisel/session-01.json) |
| `r03/ledger` | chisel | completed | [terminal.log](logs/r03/ledger/chisel/terminal.log) · [session-01.json](logs/r03/ledger/chisel/session-01.json) |
| `r03/ledger` | codex | completed | [stdout.jsonl](logs/r03/ledger/codex/stdout.jsonl) · [stderr.log](logs/r03/ledger/codex/stderr.log) · [session-01.jsonl](logs/r03/ledger/codex/session-01.jsonl) |
| `r03/layers` | codex | completed | [stdout.jsonl](logs/r03/layers/codex/stdout.jsonl) · [stderr.log](logs/r03/layers/codex/stderr.log) · [session-01.jsonl](logs/r03/layers/codex/session-01.jsonl) |
| `r03/layers` | chisel | completed | [terminal.log](logs/r03/layers/chisel/terminal.log) · [session-01.json](logs/r03/layers/chisel/session-01.json) |
| `r03/jobs` | codex | completed | [stdout.jsonl](logs/r03/jobs/codex/stdout.jsonl) · [stderr.log](logs/r03/jobs/codex/stderr.log) · [session-01.jsonl](logs/r03/jobs/codex/session-01.jsonl) |
| `r03/jobs` | chisel | completed | [terminal.log](logs/r03/jobs/chisel/terminal.log) · [session-01.json](logs/r03/jobs/chisel/session-01.json) |
| `r03/cursor` | chisel | completed | [terminal.log](logs/r03/cursor/chisel/terminal.log) · [session-01.json](logs/r03/cursor/chisel/session-01.json) |
| `r03/cursor` | codex | completed | [stdout.jsonl](logs/r03/cursor/codex/stdout.jsonl) · [stderr.log](logs/r03/cursor/codex/stderr.log) · [session-01.jsonl](logs/r03/cursor/codex/session-01.jsonl) |
| `r03/batches` | codex | completed | [stdout.jsonl](logs/r03/batches/codex/stdout.jsonl) · [stderr.log](logs/r03/batches/codex/stderr.log) · [session-01.jsonl](logs/r03/batches/codex/session-01.jsonl) |
| `r03/batches` | chisel | completed | [terminal.log](logs/r03/batches/chisel/terminal.log) · [session-01.json](logs/r03/batches/chisel/session-01.json) |
| `r03/replay` | chisel | completed | [terminal.log](logs/r03/replay/chisel/terminal.log) · [session-01.json](logs/r03/replay/chisel/session-01.json) |
| `r03/replay` | codex | completed | [stdout.jsonl](logs/r03/replay/codex/stdout.jsonl) · [stderr.log](logs/r03/replay/codex/stderr.log) · [session-01.jsonl](logs/r03/replay/codex/session-01.jsonl) |
| `r03/alerts` | chisel | completed | [terminal.log](logs/r03/alerts/chisel/terminal.log) · [session-01.json](logs/r03/alerts/chisel/session-01.json) |
| `r03/alerts` | codex | completed | [stdout.jsonl](logs/r03/alerts/codex/stdout.jsonl) · [stderr.log](logs/r03/alerts/codex/stderr.log) · [session-01.jsonl](logs/r03/alerts/codex/session-01.jsonl) |
