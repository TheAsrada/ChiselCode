---
name: code-review
description: >
  Review a specific set of code changes for correctness, regressions, security
  vulnerabilities, data loss, error handling, API compatibility, concurrency,
  credible performance problems and missing tests that could hide real failures.
  Use when asked to review or audit a diff, PR, commit, branch, staged or
  uncommitted changes, find bugs in changes, or assess merge readiness. Do not
  use merely because ordinary code was edited.
---

# Code review

Review a concrete change set. An ordinary coding task includes its own checks;
this workflow is for a user request to inspect changes.

## Scope

1. Use the exact diff, PR, commit, branch, or files specified by the user.
   Do not silently expand to a repository-wide review.
2. Without an explicit scope, inspect the current working tree against HEAD.
   Call `git_status` for staged, unstaged and untracked files, then
   `git_diff({"scope":"all"})` for tracked changes. Read relevant untracked
   files separately. For a staged-only request, use `git_diff` with `staged`;
   for an unstaged-only request, use `unstaged`.
3. If the requested scope is empty, say so. Never invent findings.
4. The structured Git tools take argv safely. Use `run_shell` only when a
   requested review scope cannot be obtained with those tools.

## Inspect context

Start with the diff. Then read only the surrounding code needed to understand
changed logic: callers, callees, types, validation, error paths, related state,
tests, configuration and API contracts. Trace actual inputs to effects. Do not
read the whole repository without a reason.

Look for correctness errors, wrong defaults, off-by-one and null handling,
async ordering and lost errors, backward-compatibility breaks, security trust
boundary mistakes with a concrete exploit path, data loss or partial writes,
races and retries, resource leaks and credible performance problems. A missing
test is a finding only when it hides a specific plausible failure. Skip style,
naming, formatting and speculative micro-optimizations.

Before reporting each finding, check the execution path, nearby implementation,
call sites and existing tests. Confirm that the issue was introduced or made
relevant by the reviewed change. Prefer a few high-confidence findings to a
large speculative list.

## Severity and output

- P0: catastrophic security compromise, major data loss, or a universally
  broken critical path.
- P1: serious plausible production bug, security flaw, corruption or major
  regression.
- P2: concrete correctness or regression bug under plausible conditions.
- P3: concrete minor defect with limited impact.

Put findings first, sorted P0 to P3. Each finding should use this form:

```text
[P1] Short actionable title — src/path/file.ts:42
What is wrong: ...
Concrete failure scenario / evidence: ...
Suggested fix: ...
```

Point to the smallest relevant range in changed code. Mention related sites in
the explanation. After findings, report scope, checks run, checks not run and
residual risks. If none are supported, write "No concrete findings." and the
same review summary. Do not create a finding to fill the report.

Review is read-only by default. If the user asks to review and fix, establish
findings first, then fix confirmed issues within the user's scope and verify
them. This skill does not grant permission to expand the task or bypass tool
security.

Additional user context: $ARGUMENTS
