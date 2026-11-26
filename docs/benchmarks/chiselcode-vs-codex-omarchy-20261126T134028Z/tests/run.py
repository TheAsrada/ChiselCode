#!/usr/bin/env python3
"""Paired, resumable benchmark for local ChiselCode and Codex CLI."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import errno
import fcntl
from hashlib import file_digest, sha256
import json
import os
from pathlib import Path
import platform
import pty
from random import Random
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

from cases import APIS, build
from evidence import capture_logs

ROOT = Path(__file__).resolve().parent
MODEL, EFFORT = "gpt-6.2-sol", "high"
AGENTS = ("chisel", "codex")
PROMPT = (ROOT / "PROMPT_TASK.txt").read_text().strip()
ANSI = re.compile(rb"\x1b(?:\][^\x07]*?(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[()][A-Z0-9]|[=>])", re.S)
INFRA = {"rate_limit", "auth_error", "model_unverified", "adapter_error", "network_error", "sandbox_error"}
GIT_ENV = {"PATH": os.defpath, "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": "/dev/null", "LC_ALL": "C.UTF-8",
           "GIT_AUTHOR_DATE": "2026-11-25T00:00:00Z",
           "GIT_COMMITTER_DATE": "2026-11-25T00:00:00Z"}


def dump(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def executable(name):
    value = shutil.which(name)
    if not value:
        raise SystemExit(f"Команда недоступна: {name}")
    return Path(os.path.abspath(value))


def version(path):
    return subprocess.check_output([str(path), "--version"], text=True, timeout=18).strip()


def digest(path):
    with path.open("rb") as file:
        return file_digest(file, "sha256").hexdigest()


def benchmark_files():
    sources = [*ROOT.glob("*.py"), ROOT / "auth.mjs", ROOT / "PROMPT_TASK.txt"]
    sources.extend(path for path in (ROOT / "tasks").rglob("*")
                   if path.is_file() and "__pycache__" not in path.parts)
    return sorted(sources)


def fingerprint():
    digest = sha256()
    for path in benchmark_files():
        digest.update(str(path.relative_to(ROOT)).encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()


def git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], env=GIT_ENV, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


def prepare(to, task):
    if task == "probe":
        to.mkdir()
        (to / "probe.txt").write_text("OLD\n", encoding="utf-8")
    else:
        shutil.copytree(ROOT / "tasks" / task, to, ignore=shutil.ignore_patterns("__pycache__"))
    git(to, "-c", "init.templateDir=", "init", "-q", "-b", "bench")
    git(to, "add", "--", ".")
    git(to, "-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid",
        "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture")


def mounts(agent_bin=None, extra=(), online=False):
    command = [str(executable("bwrap")), "--die-with-parent", "--unshare-pid", "--unshare-ipc",
               "--unshare-uts", "--cap-drop", "ALL", "--clearenv", "--ro-bind", "/usr", "/usr",
               "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    for directory in ("/bin", "/sbin", "/lib", "/lib64"):
        if Path(directory).exists():
            path = Path(directory)
            command.extend(["--symlink", os.readlink(path), directory] if path.is_symlink()
                           else ["--ro-bind", directory, directory])
    for name in ("resolv.conf", "hosts", "nsswitch.conf", "ssl/certs", "ssl/openssl.cnf", "ca-certificates", "pki/tls/certs"):
        path = Path("/etc") / name
        if path.exists() and (online or name not in ("resolv.conf", "hosts")):
            command += ["--ro-bind", str(path), str(path)]
    if not online:
        command.append("--unshare-net")
    runtime = list(extra)
    if agent_bin:
        runtime.extend([agent_bin, agent_bin.resolve()])
        real = agent_bin.resolve()
        if agent_bin.name == "codex" or real.name == "codex":
            for folder in {agent_bin.parent, real.parent}:
                for name in ("codex-code-mode-host", "codex-exec-server"):
                    companion = folder / name
                    if companion.is_file():
                        runtime.extend([companion, companion.resolve()])
        if "node_modules" in real.parts:
            index = real.parts.index("node_modules")
            runtime.append(Path(*real.parts[:index + 1]))
        # npm/Bun wrappers use their shebang interpreter on PATH.
        for interpreter in ("node", "bun"):
            found = shutil.which(interpreter)
            if found:
                runtime += [Path(os.path.abspath(found)), Path(found).resolve()]
    extra_path = []
    for path in sorted(set(runtime), key=lambda p: (len(p.parts), str(p))):
        if path.is_relative_to("/usr") or path.is_relative_to("/bin"):
            continue
        if path.is_dir():
            if path in {Path("/"), Path("/home"), Path("/opt"), Path("/var"), Path("/tmp")} or Path.home().is_relative_to(path):
                raise SystemExit("Укажи только каталог установленного runtime в --runtime-dir.")
            if ROOT.is_relative_to(path) or path.is_relative_to(ROOT):
                raise SystemExit("Каталог runtime должен находиться отдельно от архива.")
        source = path.resolve(strict=True)
        command += ["--ro-bind", str(source), str(path)]
        if path.is_file():
            extra_path.append(str(path.parent))
    env = {"HOME": "/home/bench", "USER": "bench", "USERNAME": "bench",
           "XDG_CONFIG_HOME": "/home/bench/.config", "XDG_DATA_HOME": "/home/bench/.local/share",
           "XDG_CACHE_HOME": "/home/bench/.cache", "XDG_STATE_HOME": "/home/bench/.local/state",
           "CODEX_HOME": "/home/bench/.codex", "PATH": ":".join(dict.fromkeys([*extra_path, "/usr/bin", "/bin"])),
           "LANG": "C.UTF-8", "TERM": "xterm-256color",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "PYTHONDONTWRITEBYTECODE": "1"}
    for key, value in env.items():
        command += ["--setenv", key, value]
    return command


def sandbox(repo, *, online=False, home=None, agent_bin=None, extra=()):
    prefix = mounts(agent_bin, extra, online)
    prefix += ["--bind" if online else "--ro-bind", str(repo), "/arena"]
    if home:
        prefix += ["--bind", str(home), "/home/bench"]
    return prefix + ["--chdir", "/arena"]


def grade(repo, task, trusted=False):
    case_ids, args, expected = zip(*build(task))
    pristine = not (repo / "tests").is_symlink() and all(
        (repo / file).is_file() and not (repo / file).is_symlink()
        and (repo / file).read_bytes() == (ROOT / "tasks" / task / file).read_bytes()
        for file in ("TASK.md", "tests/test_public.py")
    )
    public_test = ROOT / "tasks" / task / "tests/test_public.py"
    command = [sys.executable, "-I", "-B", str(ROOT / "grade_worker.py"), str(repo), APIS[task], str(public_test)]
    if not trusted:
        command = sandbox(repo) + ["--ro-bind", str(ROOT / "grade_worker.py"), "/worker.py",
                                  "--ro-bind", str(public_test), "/public_test.py",
                                  "--", "/usr/bin/python3", "-I", "-B", "/worker.py", "/arena", APIS[task], "/public_test.py"]
    public_ok = False
    try:
        result = subprocess.run(command, input=json.dumps(args), text=True, capture_output=True, timeout=15)
        payload = json.loads(result.stdout) if result.returncode == 0 else {}
        answers = payload.get("answers", []) if isinstance(payload, dict) else []
        public_ok = isinstance(payload, dict) and payload.get("public_ok") is True
        if not isinstance(answers, list) or len(answers) != len(case_ids):
            answers = []
        error = "grader_sandbox_failed" if result.stderr.startswith("bwrap:") else None
    except OSError:
        answers, error = [], "grader_worker_unavailable"
    except (ValueError, subprocess.TimeoutExpired):
        answers, error = [], None
    passed = [key for key, got, want in zip(case_ids, answers, expected)
              if json.dumps(got, sort_keys=True) == json.dumps(want, sort_keys=True)]
    return {"passed": len(passed), "total": len(case_ids), "pristine": pristine, "public_ok": public_ok, "grader_error": error,
            "failed_cases": [key for key in case_ids if key not in passed]}


def json_lines(path):
    if not path.is_file():
        return
    with path.open(encoding="utf-8", errors="replace") as source:
        for line in source:
            try:
                record = json.loads(line)
                if isinstance(record, dict):
                    yield record
            except ValueError:
                continue


def known_status(text, fallback):
    text = text.lower()
    matches = (
        ("rate_limit", r"rate.limit|too many requests|usage limit|лимит.{0,22}(исчерпан|достигнут)|\b429\b"),
        ("auth_error", r"unauthorized|authentication|token refresh|войдите в chatgpt|\b401\b"),
        ("model_unverified", r"model_not_found|not supported.*model|model.*not supported|доступные уровни:|не сообщило уровни"),
        ("network_error", r"каталог аккаунта chatgpt недоступен|workspace routing discovery|failed to connect|sending request for url|could not resolve host|econnreset|enotfound|error trying to connect"),
        ("sandbox_error", r"bwrap:|permission denied.*namespace|failed to create namespace"),
    )
    return next((status for status, pattern in matches if re.search(pattern, text)), fallback)


def usage(value, fields):
    return {label: value.get(key) if isinstance(value.get(key), int) else None for label, key in fields.items()}


def codex_model_matches(context):
    collaboration = context.get("collaboration_mode") or {}
    settings = collaboration.get("settings") or {}
    levels = {value for value in (context.get("effort"), settings.get("reasoning_effort"))
              if isinstance(value, str)}
    return context.get("model") == MODEL and levels == {EFFORT}


def codex_run(command, prompt, home, deadline):
    codex = home / ".codex"
    stdout, stderr = home / "codex.jsonl", home / "stderr.txt"
    with stdout.open("wb") as out, stderr.open("wb") as err:
        process = subprocess.Popen(command + [
            "-a", "never", "exec", "--ignore-user-config", "--ignore-rules", "--json", "--color", "never",
            "--sandbox", "danger-full-access", "--model", MODEL,
            "-c", f'model_reasoning_effort="{EFFORT}"',
            "-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"',
            "-c", 'cli_auth_credentials_store="file"', "-c", 'web_search="disabled"',
            "-c", 'features.multi_agent=false', "-c", 'features.multi_agent_v2=false',
            "-c", 'features.plugins=false', "-c", 'features.hooks=false',
            "-c", 'features.apps=false', "-c", 'analytics.enabled=false', "-",
        ], stdin=subprocess.PIPE, stdout=out, stderr=err, start_new_session=True)
        try:
            process.communicate(prompt.encode(), timeout=max(0.1, deadline - time.monotonic()))
            expired = False
        except subprocess.TimeoutExpired:
            stop(process.pid)
            process.wait(timeout=5)
            expired = True
        except KeyboardInterrupt:
            stop(process.pid)
            process.wait(timeout=5)
            raise
    events = list(json_lines(stdout))
    errors = [str(item.get("message", item.get("error", ""))) for item in events
              if item.get("type") in {"error", "turn.failed"}]
    config = [item["payload"] for path in (codex / "sessions").rglob("*.jsonl")
              for item in json_lines(path)
              if item.get("type") == "turn_context" and isinstance(item.get("payload"), dict)]
    verified = bool(config) and all(map(codex_model_matches, config))
    completed = [event for event in events if event.get("type") == "turn.completed"]
    status = "timeout" if expired else known_status("\n".join(errors) + stderr.read_text(errors="replace")[-12000:], "agent_failed" if config else "adapter_error")
    if len(completed) == 1 and process.returncode == 0 and not expired:
        status = "completed" if verified else "model_unverified"
    tools = [event.get("item", {}) for event in events if event.get("type") == "item.completed"]
    tools = [item for item in tools if item.get("type") in {
        "command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call"}]
    counts = usage(completed[-1].get("usage", {}) if completed else {},
                   {"input": "input_tokens", "output": "output_tokens", "cache_read": "cached_input_tokens"})
    return {"status": status, "verified": verified, "tokens": counts,
            "tools": len(tools) if events else None, "tool_errors": sum(
                item.get("status") == "failed" or item.get("exit_code") not in (None, 0) for item in tools
            ) if events else None, "exit": process.returncode}


def stop(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def terminal_text(raw):
    return ANSI.sub(b"", raw).decode(errors="ignore")


def read_pty(fd, wait=0.15):
    if not select.select([fd], [], [], wait)[0]:
        return b""
    try:
        return os.read(fd, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return None
        raise


def send_line(fd, text):
    os.write(fd, b"\x1b[200~" + text.encode() + b"\x1b[201~")
    time.sleep(0.12)
    os.write(fd, b"\r")


def find_chisel_session(home):
    directory = home / ".local/share/chiselcode/sessions/projects"
    for file in directory.glob("*/*.json"):
        if not re.fullmatch(r"[0-9a-f-]{36}\.json", file.name):
            continue
        try:
            value = load(file)
        except (OSError, ValueError):
            continue
        if value.get("requestTimings"):
            return value
    return {}


def chisel_run(command, prompt, home, deadline, profile):
    pid, fd = pty.fork()
    if pid == 0:
        os.execv(command[0], command + [
            "--profile", profile, "--model", MODEL, "--cwd", "/arena", "--mode", "build",
            "--approval", "acceptEdits", "--allow", "run_shell", "--no-external-extensions", "--no-pause",
        ])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 46, 160, 0, 0))
    tail, stage, status, saved, exit_code = b"", "startup", "timeout", {}, None
    key = json.dumps([profile, MODEL], separators=(",", ":"))
    startup_deadline = min(deadline, time.monotonic() + 60)
    seen_terminal = None
    checked_at = 0.0
    check_tail = b""
    trace = (home / "terminal.log").open("wb")

    def read_output(wait=0.15):
        output = read_pty(fd, wait)
        if output:
            trace.write(output)
        return output

    try:
        while time.monotonic() < deadline:
            data = read_output()
            if data is None:
                status = known_status(terminal_text(tail), "adapter_error" if stage != "task" else "agent_failed")
                break
            if data:
                tail = (tail + data)[-90000:]
                if stage in {"verify_effort", "close_effort"}:
                    check_tail = (check_tail + data)[-50000:]
            screen = terminal_text(tail)
            if stage == "startup" and data and seen_terminal is None and (
                    MODEL in screen or "GPT-6.2 Sol" in screen or ("Build" in screen and "arena" in screen)):
                seen_terminal = time.monotonic()
            if stage == "startup" and seen_terminal is not None and time.monotonic() - seen_terminal >= 0.25:
                send_line(fd, "/effort high")
                checked_at = time.monotonic()
                stage = "set_effort"
            if stage == "set_effort" and time.monotonic() - checked_at > 0.9:
                if "Ошибка команды" in screen:
                    status = known_status(screen, "model_unverified")
                    break
                send_line(fd, "/effort")
                checked_at = time.monotonic()
                stage = "verify_effort"
            if stage == "verify_effort":
                panel = terminal_text(check_tail)
                chosen = re.search(r"(?<![a-z])high[ \t]*\+ текущий", panel)
                if "Глубина рассуждений" in panel and chosen:
                    # Applying the selected level closes the menu and clears the slash command.
                    os.write(fd, b"\r")
                    stage = "close_effort"
                    check_tail = b""
                elif "Ошибка команды" in panel:
                    status = known_status(screen, "model_unverified")
                    break
                elif time.monotonic() - checked_at > 4:
                    # Reopen a loaded menu to observe a late catalog response.
                    if "Глубина рассуждений" in panel:
                        # Apply the current row so the picker closes and clears its input.
                        os.write(fd, b"\r")
                        time.sleep(0.4)
                    send_line(fd, "/effort high")
                    checked_at = time.monotonic()
                    stage = "set_effort"
                    check_tail = b""
            if stage == "close_effort" and "Опишите задачу" in terminal_text(check_tail):
                send_line(fd, prompt)
                stage = "task"
            if stage != "task" and time.monotonic() >= startup_deadline:
                status = known_status(screen, "adapter_error" if stage == "startup" else "model_unverified")
                break
            if stage == "task":
                saved = find_chisel_session(home)
                if saved.get("requestTimings"):
                    timings = saved["requestTimings"]
                    status = timings[-1].get("status", "agent_failed")
                    if status not in {"completed", "approval_required", "failed", "cancelled"}:
                        status = "adapter_error"
                    if status != "completed":
                        error = timings[-1].get("error", {})
                        status = known_status(str(error), status)
                    verified = (saved.get("model"), saved.get("providerId"), saved.get("profileId"),
                                saved.get("reasoningEfforts", {}).get(key)) == (MODEL, "chatgpt", profile, EFFORT)
                    # TUI may persist preferences separately shortly after the request timing.
                    if status == "completed" and not verified:
                        for _ in range(12):
                            time.sleep(0.08)
                            updated = find_chisel_session(home)
                            if updated.get("reasoningEfforts", {}).get(key) == EFFORT:
                                saved = updated
                                break
                    try:
                        send_line(fd, "/exit")
                        for _ in range(15):
                            read_output(0.06)
                            waited, code = os.waitpid(pid, os.WNOHANG)
                            if waited:
                                exit_code = os.waitstatus_to_exitcode(code)
                                break
                    except (OSError, ChildProcessError):
                        pass
                    break
    finally:
        if exit_code is None:
            stop(pid)
            try:
                _, code = os.waitpid(pid, 0)
                exit_code = os.waitstatus_to_exitcode(code)
            except ChildProcessError:
                pass
        trace.close()
        os.close(fd)
    verified = (saved.get("model"), saved.get("providerId"), saved.get("profileId"),
                saved.get("reasoningEfforts", {}).get(key)) == (MODEL, "chatgpt", profile, EFFORT)
    if status == "completed" and not verified:
        status = "model_unverified"
    if status == "timeout":
        status = known_status(terminal_text(tail), status)
    blocks = [block for message in saved.get("messages", []) for block in message.get("content", [])]
    return {"status": status, "verified": verified, "exit": exit_code,
            "tokens": usage(saved.get("totalTokens", {}),
                            {"input": "inputTokens", "output": "outputTokens", "cache_read": "cacheReadTokens"}),
            "tools": sum(block.get("type") == "tool_use" for block in blocks) if saved else None,
            "tool_errors": sum(block.get("type") == "tool_result" and block.get("isError") is True
                               for block in blocks) if saved else None}


def adapters(args):
    paths = {agent: executable(getattr(args, agent)) for agent in AGENTS}
    manifest = {agent: {"version": version(path), "launcher_sha256": digest(path.resolve())}
                for agent, path in paths.items()}
    required = {"chisel": ("--profile", "--allow", "--no-external-extensions"),
                "codex": ("--ignore-user-config", "--ignore-rules", "--json")}
    for agent, path in paths.items():
        help_args = ["exec", "--help"] if agent == "codex" else ["--help"]
        help_text = subprocess.check_output([str(path), *help_args], text=True, timeout=18)
        missing = [flag for flag in required[agent] if flag not in help_text]
        if missing:
            raise SystemExit(f"Установленная CLI {agent} не поддерживает флаги: {', '.join(missing)}.")
        command = mounts(path, args.runtime_dir, online=True) + ["--", str(path), "--version"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        if result.returncode or result.stdout.strip() != manifest[agent]["version"]:
            raise SystemExit(f"Не запускается {agent} в bubblewrap. Проверь bubblewrap, пути и --runtime-dir.")
    return paths, manifest


def stage(home, args, agent):
    node = shutil.which("node") or shutil.which("bun")
    if not node:
        raise SystemExit("Нужен node или bun для чтения штатного локального формата авторизации.")
    base = args.chisel_config or Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "chiselcode"
    codex = args.codex_home or Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    result = subprocess.run([node, str(ROOT / "auth.mjs"), str(base), str(codex), args.profile or "", str(home), agent, str(args.timeout)],
                            text=True, capture_output=True, timeout=15)
    if result.returncode:
        raise SystemExit(result.stderr.strip() or "Ошибка подготовки локального входа ChatGPT.")
    private = json.loads(result.stdout)
    profile = private["profile"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", profile):
        raise SystemExit("Клиент вернул недопустимый ID профиля.")
    return profile, [*private["privateValues"], profile, str(Path.home())]


def run_one(agent, task, args, paths, log_dir=None):
    with tempfile.TemporaryDirectory(prefix="chisel-bench-") as scratch:
        scratch = Path(scratch)
        repo, home = scratch / "repo", scratch / "home"
        home.mkdir(mode=0o700)
        prepare(repo, task)
        profile, private = stage(home, args, agent)
        command = sandbox(repo, online=True, home=home, agent_bin=paths[agent], extra=args.runtime_dir)
        command += ["--", str(paths[agent])]
        prompt = PROMPT if task != "probe" else (
            "Локальная проверка перед бенчмарком. Замени OLD на BENCH_READY в probe.txt с переводом строки. "
            "Затем один раз запусти команду python3 -c \"from pathlib import Path; "
            "Path('shell.ok').write_text('BENCH_READY')\". "
            "Эта команда должна создать shell.ok. Используй только локальные инструменты."
        )
        started = time.monotonic()
        deadline = started + (120 if task == "probe" else args.timeout)
        try:
            result = (chisel_run(command, prompt, home, deadline, profile) if agent == "chisel"
                      else codex_run(command, prompt, home, deadline))
        except KeyboardInterrupt:
            result = {"status": "cancelled", "verified": False, "exit": None,
                      "tokens": {}, "tools": None, "tool_errors": None}
        result["seconds"] = round(time.monotonic() - started, 3)
        if log_dir is not None:
            result["logs"] = capture_logs(home, agent, log_dir, private)
        if task == "probe":
            result["probe_ok"] = (
                (repo / "probe.txt").is_file() and (repo / "probe.txt").read_bytes() == b"BENCH_READY\n"
                and (repo / "shell.ok").is_file() and (repo / "shell.ok").read_bytes() == b"BENCH_READY"
            )
        else:
            result["grade"] = grade(repo, task)
        if log_dir is not None:
            dump(log_dir / "attempt.json", result)
        return result


def schedule(repeats, seed):
    random = Random(seed)
    base = list(sorted(APIS))
    random.shuffle(base)
    work = []
    for repeat in range(1, repeats + 1):
        tasks = base[:]
        random.shuffle(tasks)
        for task in tasks:
            order = AGENTS if (base.index(task) + repeat) % 2 else tuple(reversed(AGENTS))
            for agent in order:
                work.append({"task": task, "repeat": repeat, "agent": agent, "position": order.index(agent) + 1})
    return work


@contextmanager
def lock(out):
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (out / ".lock").open("a") as path:
        try:
            fcntl.flock(path, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Этот каталог уже занят другим прогоном.")
        yield


def row_path(out, item):
    return out / "rows" / f"{item['repeat']:02}-{item['task']}-{item['agent']}.json"


def selftest():
    with tempfile.TemporaryDirectory(prefix="chisel-selftest-") as tmp:
        for task in APIS:
            repo = Path(tmp) / task
            prepare(repo, task)
            subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests"],
                           cwd=repo, capture_output=True, check=True, timeout=12)
            grade_result = grade(repo, task, trusted=True)
            assert grade_result["public_ok"] and 0 < grade_result["passed"] < grade_result["total"], (task, grade_result)
            assert len(list(build(task))) == grade_result["total"]
            print(f"{task}: baseline {grade_result['passed']}/{grade_result['total']}")
    assert len(schedule(3, 6212)) == 48
    assert sum(item["agent"] == "codex" and item["position"] == 1 for item in schedule(3, 6212)) == 12
    print(f"Self-test OK. Набор {fingerprint()}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("selftest", "preflight", "run", "report", "export"))
    parser.add_argument("--out", type=Path)
    parser.add_argument("--dest", type=Path, help="Новая папка публикации для export")
    parser.add_argument("--profile", help="ID ChatGPT-профиля ChiselCode; при единственном выбирается автоматически")
    parser.add_argument("--chisel-config", type=Path, help="Папка config.json и credentials.enc")
    parser.add_argument("--codex-home", type=Path, help="Папка Codex с auth.json")
    parser.add_argument("--chisel", default="chisel")
    parser.add_argument("--codex", default="codex")
    parser.add_argument("--runtime-dir", action="append", type=Path, default=[])
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seed", type=int, default=6212)
    parser.add_argument("--timeout", type=int, default=720)
    args = parser.parse_args()
    if args.action == "selftest":
        return selftest()
    if args.action == "export":
        if not args.out or not args.dest:
            parser.error("export требует --out и --dest")
        from evidence import export_run
        return export_run(args.out.resolve(), args.dest)
    if args.action == "report":
        if not args.out:
            parser.error("report требует --out")
        from report import write_report
        return write_report(args.out)
    if not 1 <= args.repeats <= 12 or not 60 <= args.timeout <= 3600:
        parser.error("repeats 1..12, timeout 60..3600 секунд")
    args.runtime_dir = [path.resolve(strict=True) for path in args.runtime_dir]
    if args.action == "run" and not args.out:
        parser.error("run требует --out")
    paths, versions = adapters(args)
    with tempfile.TemporaryDirectory(prefix="chisel-check-") as empty:
        check = subprocess.run(sandbox(Path(empty)) + ["--", "/usr/bin/python3", "-I", "-c", "import sqlite3"],
                               capture_output=True, timeout=15)
        if check.returncode:
            raise SystemExit("Bubblewrap не может запустить офлайн-оценщик (--unshare-net). Проверь user namespaces.")
    if args.action == "preflight":
        ok = True
        for agent in AGENTS:
            result = run_one(agent, "probe", args, paths)
            print(agent, result["status"], f"probe_ok={result['probe_ok']}", flush=True)
            ok &= result["status"] == "completed" and result["probe_ok"]
        return 0 if ok else 2
    out = args.out.resolve()
    from report import write_report
    with lock(out):
        plan = {"suite_sha256": fingerprint(), "seed": args.seed, "repeats": args.repeats,
                "timeout_seconds": args.timeout, "model": MODEL, "effort": EFFORT,
                "clients": versions, "platform": platform.system(), "kernel": platform.release(),
                "machine": platform.machine(), "python": platform.python_version(),
                "git": version(executable("git")), "bubblewrap": version(executable("bwrap")),
                "plan": schedule(args.repeats, args.seed)}
        if (out / "manifest.json").exists():
            previous = load(out / "manifest.json")
            if any(previous.get(key) != value for key, value in plan.items()):
                raise SystemExit("Изменилась конфигурация прогона. Для новых параметров используй новый --out.")
        else:
            for agent in AGENTS:
                result = run_one(agent, "probe", args, paths, out / "logs" / "preflight" / agent)
                print(agent, result["status"], f"probe_ok={result['probe_ok']}", flush=True)
                if result["status"] != "completed" or not result["probe_ok"]:
                    raise SystemExit("Контрольный запрос не прошёл. Задания не запущены.")
            dump(out / "manifest.json", {**plan, "started_utc": datetime.now(timezone.utc).isoformat()})
        (out / "rows").mkdir(exist_ok=True)
        for item in plan["plan"]:
            filename = row_path(out, item)
            if filename.exists():
                continue
            log_dir = out / "logs" / f"r{item['repeat']:02}" / item["task"] / item["agent"]
            result = run_one(item["agent"], item["task"], args, paths, log_dir)
            print(item, result["status"], f"{result['grade']['passed']}/{result['grade']['total']}", flush=True)
            dump(filename, {**item, **result})
            write_report(out)
            if result["status"] in INFRA | {"cancelled"} or result["grade"]["grader_error"]:
                raise SystemExit(f"Прогон приостановлен ({result['status']}). Возобнови с тем же --out после восстановления.")
        write_report(out)
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
