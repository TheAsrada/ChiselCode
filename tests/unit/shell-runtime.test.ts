import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { hostShell, shellFailureHint } from "../../src/processes/shell.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { HostSandboxExecutor } from "../../src/security/sandbox.js";
import { createSession } from "../../src/sessions/store.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import { quoteShellArg } from "../helpers/shell.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "chisel-shell-"));
  roots.push(directory);
  const cwd = join(directory, "Проект с  пробелами");
  await mkdir(cwd);
  return cwd;
}
test("the real default shell preserves a quoted Unicode path, arguments, both streams and exit 7", async () => {
  const cwd = await root();
  const script = join(cwd, "проверка.cjs");
  await writeFile(
    script,
    "console.log(process.argv[2]);console.error('Русский stderr');process.exitCode=7;",
  );
  const argument = 'Аргумент с  пробелами; буквально\\n "кавычки"';
  const result = await new HostSandboxExecutor().execute({
    command: `${quoteShellArg(process.execPath)} ${quoteShellArg(script)} ${quoteShellArg(argument)}`,
    cwd,
    timeout: 10000,
  });
  expect(result.exitCode).toBe(7);
  expect(result.output).toContain(argument);
  expect(result.output).toContain("Русский stderr");
  expect(result.output).not.toContain("\uFFFD");
}, 15000);

test.skipIf(process.platform !== "win32")(
  "real CMD chains commands with &, emits UTF-8 diagnostics and retains the final failure",
  async () => {
    const cwd = await root();
    const executor = new HostSandboxExecutor();
    const result = await executor.execute({
      command: "echo Первая команда & echo Вторая команда & exit /b 7",
      cwd,
      timeout: 10000,
    });
    expect(result.exitCode).toBe(7);
    expect(result.output).toContain("Первая команда");
    expect(result.output).toContain("Вторая команда");
    expect(result.output).not.toContain("\uFFFD");
    const missing = await executor.execute({
      command: "chisel_missing_command_0623",
      cwd,
      timeout: 10000,
    });
    expect(missing.exitCode).not.toBe(0);
    expect(
      shellFailureHint("chisel_missing_command_0623", missing.output),
    ).toContain("CMD");
  },
  20000,
);

test.skipIf(process.platform !== "win32")(
  "real Windows Python redirected output agrees with the UTF-8 capture pipeline",
  async () => {
    const cwd = await root();
    const file = join(cwd, "utf8.py");
    await writeFile(
      file,
      "import sys\nprint('Привет из Python')\nprint('Ошибка по-русски', file=sys.stderr)\nsys.exit(3)\n",
    );
    const result = await new HostSandboxExecutor().execute({
      command: `python "${file}"`,
      cwd,
      timeout: 10000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("Привет из Python");
    expect(result.output).toContain("Ошибка по-русски");
    expect(result.output).not.toContain("\uFFFD");
  },
  15000,
);

test("CMD errors explain semicolons and missing programs without interpreting quoted arguments", () => {
  const cmd = hostShell("win32", {});
  expect(
    shellFailureHint(
      'git ls-files | findstr /I "placeholder"; echo next; git status',
      "error",
      cmd,
    ),
  ).toContain("; не разделяет");
  expect(
    shellFailureHint('python -c "print(1); print(2)"', "test failed", cmd),
  ).toBeUndefined();
  expect(shellFailureHint("echo literal^;value", "error", cmd)).toBeUndefined();
  expect(
    shellFailureHint(
      "python -m unittest | tail -60",
      "'tail' is not recognized as an internal or external command",
      cmd,
    ),
  ).toContain("Unix-утилиты");
  expect(
    shellFailureHint("python test.py", "AssertionError: expected 0", cmd),
  ).toBeUndefined();
});

test("CMD diagnoses a Unix pipeline even when localized output cannot be read", () => {
  const cmd = hostShell("win32", {});
  expect(
    shellFailureHint("python -m pytest tests -q 2>&1 | tail -30", "����", cmd),
  ).toContain("tail");
  expect(
    shellFailureHint("python -c \"print('tail')\"", "AssertionError", cmd),
  ).toBeUndefined();
  expect(shellFailureHint("echo tail", "error", cmd)).toBeUndefined();
});

test("fallback run_shell preserves failing test file, line, assertion and real exit code", async () => {
  const cwd = await root();
  const traceback = [
    "ERROR: test_menu_animation_is_stable (test_ui.AppTests)",
    "Traceback (most recent call last):",
    '  File "tests/test_ui.py", line 75, in test_menu_animation_is_stable',
    '    self.assertTrue(self.app.menu.find_withtag("anim"))',
    "AttributeError: 'ArcadeApp' object has no attribute 'menu'",
    "FAIL: test_arrow_navigation_moves_selection (test_ui.AppTests)",
    '  File "tests/test_ui.py", line 85, in test_arrow_navigation_moves_selection',
    "    self.assertEqual(self.app.selected, (start + 1) % count)",
    "AssertionError: 0 != 1",
    "Ran 95 tests in 2.980s",
    "FAILED (failures=2, errors=1)",
  ].join("\n");
  const script = join(cwd, "failing-tests.cjs");
  await writeFile(
    script,
    `process.stderr.write(${JSON.stringify(traceback)});process.exitCode=1;`,
  );
  const runtime = createLocalToolRuntime(
    cwd,
    [],
    new ApprovalGate(
      DEFAULT_PROJECT_CONFIG,
      {
        autoApprove: false,
        nonInteractive: true,
        allowedTools: new Set(["run_shell"]),
      },
      { requestApproval: async () => "unavailable" },
    ),
    createSession(cwd, "fixture", "model"),
    [],
    { mode: "build", artifactDirectory: join(cwd, "artifacts") },
  );
  const result = await runtime.executor.execute({
    id: "failing-tests",
    name: "run_shell",
    input: {
      command: `${quoteShellArg(process.execPath)} ${quoteShellArg(script)}`,
    },
  });
  expect(result.isError).toBe(true);
  expect(result.errorCode).toBe("TOOL_EXECUTION_FAILURE");
  expect(result.details?.exitCode).toBe(1);
  expect(result.output).toContain(traceback);
}, 15000);
