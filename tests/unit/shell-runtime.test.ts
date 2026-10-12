import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostShell, shellFailureHint } from "../../src/processes/shell.js";
import { HostSandboxExecutor } from "../../src/security/sandbox.js";

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
  const result = await new HostSandboxExecutor().execute({
    command: `"${process.execPath}" "${script}" "Аргумент с  пробелами; буквально"`,
    cwd,
    timeout: 10000,
  });
  expect(result.exitCode).toBe(7);
  expect(result.output).toContain("Аргумент с  пробелами; буквально");
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
