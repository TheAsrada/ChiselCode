"""Runs inside the grader sandbox and receives inputs without expected answers."""
from copy import deepcopy
import contextlib
import json
import os
import importlib.util
import unittest
from unittest.mock import patch
import sys


def objects(value):
    if isinstance(value, (list, dict)):
        items = value.values() if isinstance(value, dict) else value
        return {id(value)}.union(*(objects(item) for item in items))
    return set()


def run():
    repo, api, public_test = sys.argv[1:]
    sys.path.insert(0, repo)
    cases = json.load(sys.stdin)
    answers = []
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        tracker = contextlib.nullcontext()
        if api == "post":
            import ledger_db
            tracker = patch.object(ledger_db, "open_ledger", wraps=ledger_db.open_ledger)
        with tracker as helper:
            import solution
            for args in cases:
                before = deepcopy(args)
                try:
                    if helper is not None:
                        helper.reset_mock()
                    result = getattr(solution, api)(*args)
                    if args != before:
                        answers.append({"violation": "input_mutated"})
                    elif api == "resolve" and objects(args) & objects(result):
                        answers.append({"violation": "shared_mutable_input"})
                    elif helper is not None and not helper.called:
                        answers.append({"violation": "ledger_helper_unused"})
                    else:
                        answers.append({"value": result})
                except ValueError:
                    answers.append({"error": "ValueError"} if args == before else {"violation": "input_mutated"})
                except Exception:
                    answers.append({"error": "candidate_exception"})
            spec = importlib.util.spec_from_file_location("original_public_test", public_test)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            suite = unittest.defaultTestLoader.loadTestsFromModule(module)
            public_ok = unittest.TextTestRunner(stream=sink).run(suite).wasSuccessful()
    print(json.dumps({"answers": answers, "public_ok": public_ok}, allow_nan=False))


if __name__ == "__main__":
    run()
