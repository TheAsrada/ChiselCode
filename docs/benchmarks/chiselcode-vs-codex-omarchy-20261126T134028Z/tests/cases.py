"""Closed case inputs and reference models. Loaded only by the organizer."""
from collections import defaultdict
from copy import deepcopy
import json
from random import Random

APIS = {
    "layers": "resolve", "jobs": "schedule", "batches": "apply_batches",
    "cursor": "page", "replay": "replay", "occupancy": "occupancy",
    "ledger": "post", "alerts": "dispatch",
}


def merge(left, right):
    result = deepcopy(left)
    for key, value in right.items():
        if value is None:
            result.pop(key, None)
        elif isinstance(value, dict):
            previous = result.get(key)
            result[key] = merge(previous if isinstance(previous, dict) else {}, value)
        else:
            result[key] = deepcopy(value)
    return result


def resolve(defaults, layers, env):
    result = deepcopy(defaults)
    for layer in layers:
        result = merge(result, layer)
    for key in sorted(env):
        steps = key.removeprefix("APP__").lower().split("__")
        if not key.startswith("APP__") or not all(steps):
            continue
        target = result
        for step in steps[:-1]:
            if not isinstance(target.get(step), dict):
                target[step] = {}
            target = target[step]
        try:
            target[steps[-1]] = json.loads(env[key])
        except ValueError:
            target[steps[-1]] = env[key]
    return result


def schedule(jobs):
    missing = {dep for deps in jobs.values() for dep in deps if dep not in jobs}
    if missing:
        return {"missing": sorted(missing)}
    dependencies = {job: set(deps) for job, deps in jobs.items()}
    dependents = defaultdict(set)
    for job, deps in dependencies.items():
        for dep in deps:
            dependents[dep].add(job)
    available = sorted(job for job, deps in dependencies.items() if not deps)
    waves = []
    remaining = set(jobs)
    while available:
        waves.append(available)
        tail = []
        for job in available:
            remaining.remove(job)
            for dependent in dependents[job]:
                dependencies[dependent].remove(job)
                if not dependencies[dependent]:
                    tail.append(dependent)
        available = sorted(tail)
    return {"waves": waves, "blocked": sorted(remaining)}


def apply_batches(stock, batches):
    stock = stock.copy()
    statuses = []
    accepted = set()
    for batch in batches:
        label = batch["id"]
        if label in accepted:
            statuses.append("duplicate")
            continue
        changes = defaultdict(int)
        for sku, delta in batch["lines"]:
            changes[sku] += delta
        totals = {sku: stock.get(sku, 0) + delta for sku, delta in changes.items()}
        if any(amount < 0 for amount in totals.values()):
            statuses.append("insufficient")
            continue
        for sku, amount in totals.items():
            if amount:
                stock[sku] = amount
            else:
                stock.pop(sku, None)
        statuses.append("applied")
        accepted.add(label)
    return {"stock": stock, "statuses": statuses}


def page(rows, limit, after, team):
    if not 1 <= limit <= 50:
        raise ValueError
    selected = [
        row for row in rows
        if (team is None or row["team"] == team)
        and (after is None or (-row["score"], row["id"]) > (-after[0], after[1]))
    ]
    selected.sort(key=lambda row: (-row["score"], row["id"]))
    last = selected[limit - 1] if len(selected) > limit else None
    return {"rows": selected[:limit], "next": [last["score"], last["id"]] if last else None}


def replay(lines, watermark):
    candidates, issues = [], []
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError:
            event = None
        fields = {"seq", "id", "key", "op"}
        if isinstance(event, dict) and event.get("op") == "set":
            fields.add("value")
        valid = (
            isinstance(event, dict) and set(event) == fields
            and event["op"] in ("set", "delete")
            and type(event["seq"]) is int and event["seq"] >= 0
            and all(isinstance(event[key], str) and event[key] for key in ("id", "key"))
        )
        if not valid:
            issues.append([number, "invalid"])
        elif event["seq"] > watermark:
            candidates.append((event["seq"], number, event))
    state, seen = {}, set()
    for seq, number, event in sorted(candidates):
        if event["id"] in seen:
            issues.append([number, "duplicate"])
            continue
        seen.add(event["id"])
        if event["op"] == "set":
            state[event["key"]] = event["value"]
        else:
            state.pop(event["key"], None)
        watermark = seq
    return {"state": state, "issues": sorted(issues), "watermark": watermark}


def occupancy(events, start, end):
    if start > end:
        raise ValueError
    if start == end:
        return {"area": 0, "peak": None, "peak_at": None}
    points = sorted({start, end, *(time for time, _ in events if start < time < end)})
    intervals = []
    for left, right in zip(points, points[1:]):
        height = sum(delta for time, delta in events if time <= left)
        intervals.append((height, left, right))
    peak, peak_at, _ = max(intervals, key=lambda item: (item[0], -item[1]))
    return {
        "area": sum(height * (right - left) for height, left, right in intervals),
        "peak": peak, "peak_at": peak_at,
    }


def post(opening, transfers):
    balances = opening.copy()
    seen, statuses = set(), []
    for key, source, target, amount in transfers:
        if key in seen:
            status = "duplicate"
        elif source not in balances or target not in balances:
            status = "unknown"
        elif balances[source] < amount:
            status = "insufficient"
        else:
            status = "posted"
            balances[source] -= amount
            balances[target] += amount
            seen.add(key)
        statuses.append(status)
    return {"balances": balances, "statuses": statuses}


def dispatch(routes, events, cooldown):
    delivered = []
    last = {}
    for time, tag, message in sorted(events, key=lambda row: row[0]):
        for channel in sorted(routes):
            pair = channel, tag
            if tag in routes[channel] and (pair not in last or time >= last[pair] + cooldown):
                delivered.append([time, channel, tag, message])
                last[pair] = time
    return delivered


def event(seq, label, key="x", **extra):
    return json.dumps({"seq": seq, "id": label, "key": key, **extra})


def build(task):
    rng = Random(621129)
    rows = [
        {"id": label, "score": score, "team": team, "note": {"keep": label}}
        for label, score, team in [("z", 5, "a"), ("b", 6, "b"), ("a", 5, "a"),
                                    ("m", 2, "a"), ("d", 5, "b"), ("c", -2, "a")]
    ]
    batch = lambda label, *items: {"id": label, "lines": list(items)}
    cases = {
        "layers": [
            ({}, [], {}), ({"keep": None}, [], {"OTHER": "x"}),
            ({"a": {"x": 1, "y": 2}}, [{"a": {"x": None, "z": [4]}}], {}),
            ({"a": 1}, [{"a": {"x": None, "nested": {"old": None, "new": 1}}}], {}),
            ({"a": {"x": 1}}, [{"a": None}, {"a": {"y": 2}}], {}),
            ({"a": {"k": True}}, [], {"APP__A": "null", "APP__A__B": "22"}),
            ({"foo": [1]}, [], {"APP__FOO": '{"n":true}', "app__foo": "x"}),
            ({"a": [1]}, [{"a": [2]}], {"APP__A__": "9", "APP____Z": "4", "APP__B": "raw"}),
            ({"a": {"b": [1]}}, [{"x": {"y": [{"z": 3}]}}], {"APP__N": "null"}),
            ({}, [], {"APP__foo": "last", "APP__FOO": "first", "APP__FOO__N": "false"}),
        ],
        "jobs": [
            ({},), ({"b": [], "a": []},), ({"c": ["b"], "b": ["a"], "a": []},),
            ({"z": ["a", "b", "a"], "a": [], "b": [], "m": ["b"]},),
            ({"x": ["x"], "y": ["x"], "z": []},),
            ({"q": ["m"], "m": ["n"], "n": ["m"], "a": [], "b": ["a", "q"]},),
            ({"a": ["a", "z", "k"], "b": ["k"]},), ({"x": ["y"], "y": ["x"]},),
            ({f"n{i}": [f"n{i-1}"] if i else [] for i in range(2400)},),
            ({f"n{i}": [f"n{rng.randrange(i)}"] if i else [] for i in range(120)},),
        ],
        "batches": [
            ({}, []), ({"a": 3}, [batch("x", ["a", -3])]),
            ({"a": 2}, [batch("x", ["a", -4], ["a", 2])]),
            ({"a": 1, "b": 3}, [batch("x", ["a", -3], ["b", 5])]),
            ({"a": 1}, [batch("x", ["a", -3]), batch("x", ["a", 2]), batch("x", ["a", -200])]),
            ({"a": 0, "b": 0}, [batch("x", ["a", 0])]),
            ({}, [batch("z"), batch("z", ["a", 3])]),
            ({"q": 7}, [batch("a", ["q", -7]), batch("b", ["q", 4], ["new", 9])]),
            ({}, [batch("m", ["new", -2], ["new", 2])]),
            ({"a": 5}, [batch(str(rng.randrange(5)), [rng.choice("ab"), rng.randrange(-5, 7)]) for _ in range(24)]),
        ],
        "cursor": [
            ([], 1, None, None), (rows, 2, None, None), (rows, 2, [5, "a"], None),
            (rows, 2, [5, "a"], "b"), (rows, 4, [5, "j"], "a"),
            (rows, 2, [-3, "a"], None), (rows, 50, None, ""), (rows, 3, None, "a"),
            (rows, 0, None, None), (rows, 51, None, None),
        ],
        "replay": [
            ([], -1), ([" ", "null", "[]", "{notjson"], 10),
            ([event(3, "a", op="set", value=3), event(1, "b", op="set", value=1)], 0),
            ([event(5, "a", op="set", value=5), event(2, "a", op="set", value=2)], 0),
            ([event(1, "a", op="set", value=1), event(2, "a", op="set", value=None)], 1),
            ([event(1, "a", op="delete", value=0), event(1, "b", op="delete")], 10),
            ([event(True, "a", op="delete"), event(-1, "b", op="delete"), event(0, "", op="delete")], 0),
            ([event(3, "a", op="set", value=True), event(3, "b", op="delete"), event(3, "a", op="set", value="late")], 0),
            ([event(2, "a", "k", op="delete"), event(9, "a", "x", op="delete"), "bad"], 0),
            ([event(2, "a", "", op="delete"), event(3, "b", op="invalid"), event(4, "c", op="set")], -1),
        ],
        "occupancy": [
            ([], -7, 9), ([], 3, 3), ([], 3, 2), ([[-2, -4]], 0, 10),
            ([[-2, 5], [0, -2], [10, 99]], 0, 10),
            ([[6, 2], [3, -3], [3, 3], [6, -2]], 0, 9),
            ([[8, 4], [2, 4], [4, -4]], 0, 9),
            ([[-10**10, 5], [3, -5], [10**10, 20]], -10**9, 10**9),
            ([[0, -2], [3, 1], [6, -7], [7, 5]], 0, 9),
            ([[rng.randrange(-7, 7), rng.randrange(-4, 5)] for _ in range(30)], -5, 5),
        ],
        "ledger": [
            ({}, []), ({"a": 0, "b": 2}, [["m", "b", "a", 2]]),
            ({"a": 0, "b": 2}, [["m", "a", "b", 1], ["m", "b", "a", 2], ["m", "x", "a", 1]]),
            ({"a": 5}, [["x", "a", "a", 6], ["x", "a", "a", 5], ["x", "a", "a", 4]]),
            ({"a": 0}, [["z", "a", "missing", 10], ["z", "missing", "a", 9]]),
            ({"a": 2, "b": 0}, [["z", "missing", "b", 1], ["z", "a", "b", 1]]),
            ({"a?'": 1, "b;": 0}, [["a';", "a?'", "b;", 1]]),
            ({"a": 5, "b": 0, "c": 0}, [["1", "a", "b", 5], ["2", "b", "c", 5], ["3", "c", "a", 4]]),
            ({"a": 7, "b": 0}, [["9", "a", "b", 1], ["m", "a", "a", 6], ["3", "a", "b", 6]]),
            ({"a": 3, "b": 7}, [[str(rng.randrange(8)), rng.choice("abc"), rng.choice("abc"), rng.randrange(1, 7)] for _ in range(32)]),
        ],
        "alerts": [
            ({}, [[1, "x", "a"]], 0), ({"z": ["a", "a"], "a": ["a"]}, [[0, "a", "m"]], 0),
            ({"x": ["x"]}, [[5, "x", "5"], [1, "x", "1"], [3, "x", "3"]], 2),
            ({"x": ["x"]}, [[2, "x", "w"], [2, "x", "a"]], 1),
            ({"x": ["x"]}, [[-9, "x", "a"], [-8, "x", "b"], [-7, "x", "c"]], 2),
            ({"x": ["x", "y"]}, [[1, "x", "m"], [1, "y", "m"], [2, "x", "m"]], 5),
            ({"x": ["x"]}, [[2, "x", "w"], [2, "x", "a"]], 0),
            ({"z": ["x"], "b": ["x", "y"]}, [[3, "x", "m"], [5, "y", "n"], [4, "x", "o"]], 2),
            ({"b": ["z"]}, [[0, "m", "none"], [1, "z", "yes"]], 4),
            ({"a": ["x", "y"], "b": ["y"]}, [[rng.randrange(-5, 8), rng.choice("xyz"), str(i)] for i in range(35)], 3),
        ],
    }[task]
    reference = globals()[APIS[task]]
    for number, args in enumerate(cases, 1):
        try:
            expected = {"value": reference(*deepcopy(args))}
        except ValueError:
            expected = {"error": "ValueError"}
        yield f"{task}-{number:02}", args, expected
