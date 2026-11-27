# ChiselCode и Codex CLI на Omarchy

[Материалы для участников](../../contributors/README.md)

**COMPLETE** · 48/48 запусков · 24/24 сопоставимых пар.

Модель `gpt-6.2-sol`, reasoning effort `high`. Обе CLI используют ChatGPT из одного аккаунта или workspace. Раннер сверяет модель и effort по локальным метаданным клиентов.

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

Доля решённых попыток составила **22/24 (91,7%)** у ChiselCode и **24/24 (100%)** у Codex CLI. По всем рабочим копиям оценщик засчитал **224/240 (93,3%)** закрытых проверок у ChiselCode и **240/240 (100%)** у Codex CLI.

В каждой строке указаны закрытые проверки, решённые попытки и суммарное время CLI за три повтора. Попытка считается решённой, если сеанс завершился на указанной модели и effort, исходные публичные тесты сохранены и проходят, а оценщик принял все 10 закрытых случаев. Баллы и время включают две незавершённые попытки ChiselCode. [Результаты по попыткам](RESULTS.json) · [Правила оценки](tests/README.md#задачи)

| Испытание | ChiselCode | Codex CLI |
| --- | ---: | ---: |
| `alerts` | 30/30 · 3/3 решено · 138,3 с | 30/30 · 3/3 решено · 164,4 с |
| `batches` | 22/30 · 2/3 решено · 105,7 с | 30/30 · 3/3 решено · 118,8 с |
| `cursor` | 30/30 · 3/3 решено · 152,9 с | 30/30 · 3/3 решено · 138,7 с |
| `jobs` | 22/30 · 2/3 решено · 118,5 с | 30/30 · 3/3 решено · 138,4 с |
| `layers` | 30/30 · 3/3 решено · 205,8 с | 30/30 · 3/3 решено · 215,2 с |
| `ledger` | 30/30 · 3/3 решено · 234,4 с | 30/30 · 3/3 решено · 367,1 с |
| `occupancy` | 30/30 · 3/3 решено · 146,6 с | 30/30 · 3/3 решено · 113,5 с |
| `replay` | 30/30 · 3/3 решено · 194,7 с | 30/30 · 3/3 решено · 200,7 с |
| **Итого** | **224/240 · 22/24 решено · 21 мин 37 с** | **240/240 · 24/24 решено · 24 мин 17 с** |

Обе CLI прошли по **220/220** закрытых проверок в 22 парах с двумя завершёнными сеансами. Исходные публичные тесты сохранены и прошли проверку оценщика во всех 48 попытках. Разница ChiselCode − Codex CLI составила **−8,33 п. п.** по доле решённых попыток и **−6,67 п. п.** по баллу закрытых проверок. Описательный 95% bootstrap-интервал по доле решённых — от −20,83 до 0 п. п. при равном весе восьми задач.

Медиана времени решённых попыток составила 51,225 с у ChiselCode (22) и 49,759 с у Codex CLI (24). В 22 общих успешных парах медиана разниц **внутри пары** (ChiselCode − Codex CLI) составила **+3,06 с**. ChiselCode был быстрее в 8 парах, Codex CLI — в 14.

### Инструменты и токены

В таблице приведены суммы по трём попыткам на каждое задание, включая сохранённые счётчики двух незавершённых сеансов ChiselCode.

| Испытание | Вызовы ChiselCode | Ошибки ChiselCode | Вызовы Codex CLI | Ошибки Codex CLI | Токены входа / выхода ChiselCode | Токены входа / выхода Codex CLI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `alerts` | 36 | 0 | 29 | 2 | 162 545 / 3 124 | 236 590 / 5 600 |
| `batches` | 27 | 0 | 27 | 2 | 120 131 / 2 029 | 246 146 / 3 437 |
| `cursor` | 37 | 0 | 33 | 1 | 156 024 / 3 699 | 265 492 / 4 533 |
| `jobs` | 31 | 0 | 33 | 3 | 125 222 / 2 295 | 260 363 / 4 057 |
| `layers` | 37 | 0 | 40 | 2 | 173 746 / 5 937 | 301 845 / 7 800 |
| `ledger` | 38 | 0 | 35 | 2 | 176 514 / 7 714 | 289 673 / 15 580 |
| `occupancy` | 37 | 0 | 28 | 2 | 146 818 / 3 308 | 205 109 / 3 558 |
| `replay` | 36 | 0 | 34 | 2 | 153 642 / 4 730 | 271 183 / 7 746 |
| **Итого** | **279** | **0** | **259** | **16** | **1 214 642 / 32 836** | **2 076 401 / 52 311** |

Из кэша прочитано **351 232** входных токена у ChiselCode и **1 549 056** у Codex CLI. Этот объём уже учтён в таблице. В 22 общих успешных парах медиана доли кэша по попыткам составила 30,1% и 75,6%, а медиана входных токенов вне кэша — 38 344,5 и 20 075,5 соответственно.

Источники токенов и способ учёта вызовов различаются. Счётчик Codex CLI включает команды с ненулевым кодом выхода. В полном прогоне 15 из 16 таких событий связаны с поиском отсутствующего `AGENTS.md`. Все 55 вызовов `run_shell` в сессиях ChiselCode отмечены как успешные. [Схема учёта в раннере](tests/run.py)

## Наблюдения и причины ошибок

### Две незавершённые попытки ChiselCode

| Попытка | Время CLI | Успешных вызовов до сбоя | Балл рабочей копии |
| --- | ---: | ---: | ---: |
| [`r01/batches`](logs/r01/batches/chisel/session-01.json) | 8,513 с | 3 | 2/10 |
| [`r02/jobs`](logs/r02/jobs/chisel/session-01.json) | 18,436 с | 7 | 2/10 |

В обеих сессиях работа остановилась до первой правки с ошибкой `unavailable` и сообщением «ChatGPT не завершил ответ». Балл каждой рабочей копии совпал с баллом исходного кода. Раннер учёл обе попытки как `failed`. Точная причина ошибки по опубликованным журналам неизвестна.

## Как интерпретировать

- Время измерено от старта вызова клиента до обнаружения результата и выхода. В ChiselCode учтены TUI, выбор effort и завершение. Проверка оценщиком в длительность клиента не входит.
- Запрошенные модель и effort определяются по клиентским метаданным. Обе выгрузки ChiselCode со статусом `failed` содержат `gpt-6.2-sol` и `high`, тогда как для этих строк раннер сохранил `verified: false`. Серверное развёртывание модели и фактические reasoning-вычисления по этим данным неизвестны.
- Раннер исключает из парного сравнения распознанные инфраструктурные сбои и отмены. Таймаут задачи считается неуспехом. [Правила сравнения](tests/report.py)
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
