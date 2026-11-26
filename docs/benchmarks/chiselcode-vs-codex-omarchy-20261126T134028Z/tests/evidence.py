"""Preserve replayable benchmark evidence without publishing credentials."""
import gzip
import json
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import quote

PRIVATE_FIELDS = {
    "authorization", "apikey", "accesstoken", "refreshtoken", "idtoken", "token",
    "password", "clientsecret", "cookie", "setcookie", "email", "accountid",
    "chatgptaccountid", "chatgptuserid", "userid", "workspaceid", "profileid",
    "encryptedcontent", "baseinstructions",
}
TEXT_SECRETS = re.compile(
    r"(?P<auth>\b(?:Bearer|Basic) +)[a-zA-Z0-9+_./=-]{8,}"
    r"|\b(?:sk-(?:proj-|live-|svcacct-)?|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{12,}"
    r"|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r"|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
    r"|(?P<assignment>\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|"
    r"client[_-]?secret|password)\s*[:=]\s*)[^\s,;]+",
    re.IGNORECASE,
)
SESSION = re.compile(r"[0-9a-f-]{36}\.json")
REDACTED = "<redacted>"
COMPRESS_AT = 8 * 1024 * 1024
PUBLISH_MAX = 90 * 1024 * 1024


def redact_text(value, secrets):
    for secret in secrets:
        if secret.isalnum() and len(secret) < 12:
            value = re.sub(rf"(?<!\w){re.escape(secret)}(?!\w)", REDACTED, value)
        else:
            value = value.replace(secret, REDACTED)
    return TEXT_SECRETS.sub(
        lambda match: (match.group("auth") or match.group("assignment") or "") + REDACTED,
        value,
    )


def redact_record(record, secrets):
    if isinstance(record, dict):
        return {
            redact_text(key, secrets): (
                REDACTED
                if re.sub(r"[^a-z0-9]", "", key.lower()) in PRIVATE_FIELDS and value is not None
                else redact_record(value, secrets)
            )
            for key, value in record.items()
        }
    if isinstance(record, list):
        return [redact_record(value, secrets) for value in record]
    if isinstance(record, str):
        return redact_text(record, secrets)
    return record


def sanitize_line(line, secrets):
    try:
        data = json.loads(line)
    except ValueError:
        return redact_text(line, secrets)
    cleared = redact_record(data, secrets)
    if cleared == data:
        return line
    return json.dumps(cleared, ensure_ascii=False, separators=(",", ":")) + ("\n" if line.endswith("\n") else "")


def log_sources(home, agent):
    if agent == "codex":
        paths = [(home / "codex.jsonl", "stdout.jsonl"), (home / "stderr.txt", "stderr.log")]
        sessions = sorted((home / ".codex/sessions").rglob("*.jsonl"))
    else:
        paths = [(home / "terminal.log", "terminal.log")]
        sessions = sorted(
            path for path in (home / ".local/share/chiselcode/sessions/projects").glob("*/*.json")
            if SESSION.fullmatch(path.name)
        )
    paths.extend((path, f"session-{index:02}{path.suffix}") for index, path in enumerate(sessions, 1))
    return [(path, name) for path, name in paths
            if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(home.resolve())]


def capture_logs(home, agent, destination, private_values):
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    sources = log_sources(home, agent)
    variants = {variant for secret in private_values if isinstance(secret, str) and len(secret) >= 4
                for variant in (secret, quote(secret, safe=""))}
    secrets = sorted(variants, key=lambda value: (-len(value), value))
    written = []
    for source, name in sources:
        compressed = source.stat().st_size > COMPRESS_AT
        written_name = name + ".gz" if compressed else name
        target = destination / written_name
        open_output = gzip.open if compressed else open
        with source.open(encoding="utf-8", errors="replace", newline="") as raw, open_output(
            target, "wt", encoding="utf-8", newline="",
        ) as output:
            if source.suffix == ".json":
                text = raw.read()
                try:
                    data = json.loads(text)
                except ValueError:
                    output.write(redact_text(text, secrets))
                else:
                    output.write(json.dumps(redact_record(data, secrets), ensure_ascii=False, indent=2) + "\n")
            elif source.suffix == ".jsonl":
                for line in raw:
                    output.write(sanitize_line(line, secrets))
            else:
                for line in raw:
                    output.write(redact_text(line, secrets))
        written.append(written_name)
    # A retried, unrecorded preflight can have a different set of streams.
    for old in destination.iterdir():
        if old.name != "attempt.json" and old.name not in written and old.is_file():
            old.unlink()
    return written


def export_run(out, destination):
    from report import write_report
    from run import ROOT, benchmark_files, fingerprint, load, lock

    with lock(out):
        manifest = load(out / "manifest.json")
        if manifest["suite_sha256"] != fingerprint():
            raise SystemExit("Набор изменился после запуска. Для экспорта нужна исходная копия.")
        write_report(out)
        destination = destination.resolve()
        if destination.exists():
            raise SystemExit("Папка отчёта уже существует. Укажи новый путь назначения.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".benchmark-export-", dir=destination.parent) as temporary:
            staging = Path(temporary) / "report"
            tests = staging / "tests"
            tests.mkdir(parents=True)
            shutil.copyfile(out / "REPORT.md", staging / "README.md")
            shutil.copyfile(out / "RESULTS.json", staging / "RESULTS.json")
            for source in [*benchmark_files(), ROOT / "README.md", ROOT / "PROMPT_LOCAL_AGENT.md"]:
                target = tests / source.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
            log_root = out / "logs"
            for source in sorted(log_root.rglob("*")):
                if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(log_root.resolve()):
                    continue
                if source.stat().st_size > PUBLISH_MAX:
                    raise SystemExit(f"Слишком большой файл для GitHub: {source.relative_to(out)}. Журнал сохранён локально.")
                target = staging / source.relative_to(out)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
            if not (staging / "logs").is_dir():
                raise SystemExit("Экспорт остановлен: отсутствуют журналы прогона.")
            staging.rename(destination)
    print(destination)
