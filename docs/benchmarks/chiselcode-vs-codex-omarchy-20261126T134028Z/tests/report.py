"""Build GitHub-ready aggregates from the runner's structured measurements."""
from collections import Counter, defaultdict
from random import Random
from statistics import mean, median

from run import AGENTS, INFRA, load, dump, row_path


def score(row):
    grade = row["grade"]
    return grade["passed"] / grade["total"] if grade["pristine"] else 0.0


def solved(row):
    return row["status"] == "completed" and row["verified"] and row["grade"]["public_ok"] and score(row) == 1.0


def summary(rows):
    actual = [row for row in rows if row]
    finished = [row for row in actual if row["status"] == "completed" and row["verified"]]
    data = {"recorded": len(actual), "completed": len(finished),
            "solved": sum(solved(row) for row in actual),
            "mean_fraction": round(mean(map(score, actual)), 5) if actual else None,
            "statuses": dict(sorted(Counter(row["status"] for row in actual).items())),
            "median_wall_s_solved": median(row["seconds"] for row in actual if solved(row))
            if any(map(solved, actual)) else None}
    for label in ("input", "output", "cache_read"):
        values = [row["tokens"][label] for row in finished if row["tokens"].get(label) is not None]
        data[f"median_{label}"] = median(values) if values else None
        data[f"n_{label}"] = len(values)
    for label in ("tools", "tool_errors"):
        values = [row[label] for row in finished if row.get(label) is not None]
        data[f"median_{label}"] = median(values) if values else None
        data[f"n_{label}"] = len(values)
    return data


def paired(rows):
    groups = defaultdict(dict)
    for row in rows:
        groups[(row["task"], row["repeat"])][row["agent"]] = row
    valid = []
    for group in groups.values():
        if set(group) != set(AGENTS):
            continue
        chisel, codex = (group[agent] for agent in AGENTS)
        if any(row["status"] in INFRA or row["status"] == "cancelled"
               or row["grade"].get("grader_error")
               or (row["status"] == "completed" and not row["verified"]) for row in (chisel, codex)):
            continue
        valid.append((chisel, codex))
    by_task = defaultdict(list)
    both_solved = []
    quality = []
    for chisel, codex in valid:
        difference = int(solved(chisel)) - int(solved(codex))
        by_task[chisel["task"]].append(difference)
        quality.append(score(chisel) - score(codex))
        if solved(chisel) and solved(codex):
            both_solved.append(chisel["seconds"] - codex["seconds"])
    task_means = list(map(mean, by_task.values()))
    interval = None
    if len(task_means) >= 4:
        random = Random(6212)
        draws = sorted(mean(random.choices(task_means, k=len(task_means))) for _ in range(5000))
        interval = [round(draws[125] * 100, 2), round(draws[4874] * 100, 2)]
    wins = sum(solved(chisel) and not solved(codex) for chisel, codex in valid)
    losses = sum(solved(codex) and not solved(chisel) for chisel, codex in valid)
    return {
        "eligible_pairs": len(valid),
        "both_solved": len(both_solved),
        "only_chisel": wins,
        "only_codex": losses,
        "neither_solved": len(valid) - len(both_solved) - wins - losses,
        "task_macro_solve_delta_pp": round(mean(task_means) * 100, 2) if task_means else None,
        "solve_delta_bootstrap_95_pp": interval,
        "paired_case_delta_pp": round(mean(quality) * 100, 2) if quality else None,
        "both_solved_median_wall_delta_s": round(median(both_solved), 2) if both_solved else None,
    }


def number(value):
    return "н/д" if value is None else f"{value:g}"


def log_links(agent, files, folder):
    links = [f"[{name}]({folder}/{name})" for name in files]
    if not any(name.startswith("session-") for name in files):
        links.append("выгрузка сессии отсутствует")
    expected = ("terminal.log",) if agent == "chisel" else ("stdout.jsonl", "stderr.log")
    for name in expected:
        if name not in files and name + ".gz" not in files:
            links.append(f"`{name}` отсутствует")
    return " · ".join(links)


def write_report(out):
    manifest = load(out / "manifest.json")
    rows = [load(path) for item in manifest["plan"] if (path := row_path(out, item)).is_file()]
    stats = {agent: summary([row for row in rows if row["agent"] == agent]) for agent in AGENTS}
    pairs = paired(rows)
    planned = len(manifest["plan"])
    full = len(rows) == planned
    total_pairs = planned // 2
    status = "COMPLETE" if full and pairs["eligible_pairs"] == total_pairs else "PARTIAL"
    data = {"status": status, "planned_attempts": planned, "recorded_attempts": len(rows),
            "environment": {key: value for key, value in manifest.items() if key != "plan"},
            "agents": stats, "paired": pairs, "attempts": rows}
    dump(out / "RESULTS.json", data)
    lines = [
        "# ChiselCode и Codex CLI на Omarchy", "",
        f"**{status}** · {len(rows)}/{planned} запусков · {pairs['eligible_pairs']}/{total_pairs} сопоставимых пар.",
        "",
        f"Модель `{manifest['model']}`, reasoning effort `{manifest['effort']}`. Обе CLI используют ChatGPT "
        "из одного аккаунта или workspace. Модель и effort подтверждаются локальными метаданными клиентов.",
        "",
        "| Параметр | Значение |", "| --- | --- |",
        f"| Старт UTC | `{manifest['started_utc']}` |",
        f"| Платформа | {manifest['platform']} {manifest['kernel']} · {manifest['machine']} |",
        f"| Python / Git / bubblewrap | {manifest['python']} / {manifest['git']} / {manifest['bubblewrap']} |",
        f"| ChiselCode | `{manifest['clients']['chisel']['version']}` |",
        f"| Codex CLI | `{manifest['clients']['codex']['version']}` |",
        f"| Протокол | {manifest['repeats']} повтора · seed {manifest['seed']} · {manifest['timeout_seconds']} с на попытку |",
        f"| SHA-256 набора | `{manifest['suite_sha256']}` |", "",
        "## Результаты", "",
        "Задача решена, когда сеанс завершился на указанной модели и effort, исходные публичные тесты сохранены и проходят, "
        "а независимый оценщик принял все случаи. В таблице ниже процент по случаям учитывает и частичные правки.",
        "",
        "| Показатель | ChiselCode | Codex CLI |", "| --- | ---: | ---: |",
        f"| Решено / записано | {stats['chisel']['solved']}/{stats['chisel']['recorded']} | {stats['codex']['solved']}/{stats['codex']['recorded']} |",
    ]
    for label, field in [
        ("Завершено", "completed"), ("Медиана времени решённых, с", "median_wall_s_solved"),
        ("Входные токены, медиана", "median_input"), ("Выходные токены, медиана", "median_output"),
        ("Чтение кэша, медиана", "median_cache_read"), ("Вызовы инструментов, медиана", "median_tools"),
        ("Ошибки инструментов, медиана", "median_tool_errors"),
    ]:
        values = []
        for agent in AGENTS:
            value = number(stats[agent][field])
            count = stats[agent].get(f"n_{field.removeprefix('median_')}")
            values.append(f"{value} (n={count})" if count is not None else value)
        lines.append(f"| {label} | {values[0]} | {values[1]} |")
    lines += [
        "", "| Задача | ChiselCode решено / попыток | ChiselCode средний % | Codex решено / попыток | Codex средний % |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for task in sorted({item["task"] for item in manifest["plan"]}):
        cells = []
        for agent in AGENTS:
            item = summary([row for row in rows if (row["task"], row["agent"]) == (task, agent)])
            fraction = item["mean_fraction"]
            cells.extend([f"{item['solved']}/{item['recorded']}", f"{100 * fraction:.1f}%" if fraction is not None else "н/д"])
        lines.append(f"| `{task}` | " + " | ".join(cells) + " |")
    interval = pairs["solve_delta_bootstrap_95_pp"]
    evidence = [
        f"В сопоставимых парах только ChiselCode решил {pairs['only_chisel']}, только Codex решил {pairs['only_codex']}, "
        f"оба решили {pairs['both_solved']}, оба не решили {pairs['neither_solved']}.",
        f"Разница ChiselCode − Codex по доле решённых с равным весом разработческих задач "
        f"составила {number(pairs['task_macro_solve_delta_pp'])} п. п.",
    ]
    if interval:
        evidence.append(f"Описательный 95% bootstrap по задачам дал [{number(interval[0])}; {number(interval[1])}] п. п. "
                        "Выборка из восьми задач ограничивает переносимость оценки.")
    if pairs["both_solved"]:
        evidence.append(f"Медиана парной разницы времени на задачах, решённых обеими CLI, "
                        f"составила {number(pairs['both_solved_median_wall_delta_s'])} с.")
    lines += ["", " ".join(evidence), "", "## Статусы запуска", "",
              "| Статус | ChiselCode | Codex CLI |", "| --- | ---: | ---: |"]
    for status_key in sorted(set(stats["chisel"]["statuses"]) | set(stats["codex"]["statuses"])):
        lines.append("| " + status_key + " | " + " | ".join(
            str(stats[agent]["statuses"].get(status_key, 0)) for agent in AGENTS) + " |")
    lines += ["", "## Как интерпретировать", "",
              "- Время измерено от старта вызова клиента до обнаружения результата и выхода. В ChiselCode учтены TUI, выбор effort и завершение. "
              "Проверка оценщиком в длительность клиента не входит.",
              "- Источники токенов и вызовов различаются. Время, токены, ошибки и кэш описывают локально наблюдаемый клиентский сеанс. "
              "Оценка цены подписки отсутствует.",
              "- Суффикс модели на стороне серверного развёртывания и фактическая доля reasoning вычислений не наблюдались. "
              "CLI подтверждают запрошенное значение `high`.",
              "- Сетевые сбои, лимиты, ошибки адаптера и отмены видны в общих строках. Их пары исключены из парной оценки. "
              "Обычный таймаут задачи засчитывается как неуспех.",
              "- Это авторские задачи с локальными репозиториями, открытым контрактом и различными входами оценщика. "
              "Размер набора и общий язык Python ограничивают выводы о других проектах.",
              "", "## Воспроизведение и журналы", "",
              "[Точный набор тестов, фикстуры, оценщик и команды запуска](tests/README.md) · "
              "[Результаты по попыткам](RESULTS.json)", "",
              "Журналы сохраняют исходный порядок событий. Секреты, личные данные, "
              "внутренние инструкции и зашифрованные элементы модели маскируются. "
              "PTY содержит управляющие символы терминала. Большие файлы могут быть сжаты без обрезки.", "",
              "| Прогон | Клиент | Статус | Журналы |", "| --- | --- | --- | --- |"]
    for agent in AGENTS:
        folder = f"logs/preflight/{agent}"
        path = out / folder / "attempt.json"
        if path.is_file():
            probe = load(path)
            links = log_links(agent, probe.get("logs", []), folder)
            lines.append(f"| Preflight | {agent} | {probe['status']} | {links} |")
    for row in rows:
        task, repeat, agent = row["task"], row["repeat"], row["agent"]
        folder = f"logs/r{repeat:02}/{task}/{agent}"
        links = log_links(agent, row.get("logs", []), folder)
        lines.append(f"| `r{repeat:02}/{task}` | {agent} | {row['status']} | {links} |")
    lines.append("")
    temporary = out / "REPORT.tmp"
    temporary.write_text("\n".join(lines), encoding="utf-8")
    temporary.replace(out / "REPORT.md")
