import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { ContextManager } from "../../src/context/context-manager.js";
import { AgentEventPipeline } from "../../src/extensions/agent-events.js";
import { hostShell, shellFailureHint } from "../../src/processes/shell.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { HostSandboxExecutor } from "../../src/security/sandbox.js";
import { SessionV3Schema } from "../../src/sessions/schema.js";
import { createSession } from "../../src/sessions/store.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import type { ProviderAdapter } from "../../src/types/domain.js";
import { quoteShellArg } from "../helpers/shell.js";
import { verifyShellDiagnostics } from "../helpers/shell-diagnostics.js";

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

test("real run_shell batches overlap in independent projects with isolated cwd, streams and exit codes", async () => {
  const projects = await Promise.all([root(), root()]);
  const commands = await Promise.all(
    projects.map(async (project, index) => {
      const cwd = join(project, "рабочая папка");
      await mkdir(cwd);
      const script = join(project, "parallel.cjs");
      const peer = index === 0 ? projects[1] : projects[0];
      // Neither process may finish until its peer has actually started.
      // A global shell lock would fail this barrier instead of passing sequentially.
      await writeFile(
        script,
        `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(project, "ready"))}, 'ready');
const deadline = Date.now() + 5000;
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(join(peer, "ready"))})) {
    clearInterval(timer);
    console.log(JSON.stringify({ cwd: process.cwd(), project: ${index} }));
    console.error('stderr-${index}');
    fs.writeFileSync('finished', '${index}');
    process.exitCode = ${index === 0 ? 7 : 3};
  } else if (Date.now() > deadline) {
    clearInterval(timer);
    throw new Error('Independent shell did not start');
  }
}, 10);
`,
      );
      const following = join(project, "following.cjs");
      await writeFile(
        following,
        `const fs = require('node:fs');
if (fs.readFileSync('finished', 'utf8') !== '${index}') throw new Error('Shell batch ran out of order');
console.log('following-${index}');
`,
      );
      const runtime = createLocalToolRuntime(
        project,
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
        createSession(project, "fixture", "model"),
        [],
        { artifactDirectory: join(project, "artifacts") },
      );
      return {
        cwd: await realpath(cwd),
        run: () =>
          runtime.scheduler.execute(
            [script, following].map((file, call) => ({
              id: `shell-${index}-${call}`,
              name: "run_shell",
              input: {
                cwd: "рабочая папка",
                command: `${quoteShellArg(process.execPath)} ${quoteShellArg(file)}`,
                timeout: 10000,
              },
            })),
          ),
      };
    }),
  );
  const batches = await Promise.all(commands.map((command) => command.run()));
  for (const [index, batch] of batches.entries()) {
    const first = batch[0];
    if (!first) throw new Error("Missing first shell result");
    expect(first.details?.exitCode).toBe(index === 0 ? 7 : 3);
    expect(first.isError).toBe(true);
    expect(first.errorCode).toBe("TOOL_EXECUTION_FAILURE");
    expect(first.output).toContain(
      JSON.stringify({ cwd: commands[index]?.cwd, project: index }),
    );
    expect(first.output).toContain(`stderr-${index}`);
    expect(first.output).not.toContain(`stderr-${1 - index}`);
    expect(batch[1]?.details?.exitCode).toBe(0);
    expect(batch[1]?.isError).not.toBe(true);
    expect(batch[1]?.output.trim()).toEndWith(`following-${index}`);
    expect(batch[1]?.output).toContain("Exit code: 0");
  }
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

test("fallback managed shell retains observed outcomes and partial sanitized logs", async () => {
  const cwd = await root();
  const session = createSession(cwd, "fixture", "model");
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
    session,
    [],
    {
      mode: "build",
      artifactDirectory: join(cwd, "artifacts"),
      maxInlineTokens: 1000,
    },
  );
  await verifyShellDiagnostics(
    cwd,
    async (call, signal) => {
      const [result] = await runtime.scheduler.execute([call], signal);
      if (!result) throw new Error("Missing result");
      if (result.errorCode === "CANCELLED")
        expect(session.runtime?.invocations[call.id]?.state).toBe("cancelled");
      return result;
    },
    (uri) => runtime.context.artifacts.read(uri),
  );
}, 60000);

test("foreground managed shell uses the same diagnostics through the application runtime", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/shell-diagnostics.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Foreground shell diagnostics: passed");
}, 60000);

test("model receives shell failure after offload and saved sessions accept optional diagnostics", async () => {
  const cwd = await root();
  const session = createSession(cwd, "anthropic", "fixture");
  session.mode = "build";
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
    session,
    [],
    {
      mode: "build",
      artifactDirectory: join(cwd, "artifacts"),
      maxInlineTokens: 1000,
    },
  );
  const script = join(cwd, "model.cjs");
  await writeFile(
    script,
    "console.log('я€🙂'.repeat(40000));process.exitCode=7",
  );
  let requests = 0;
  const provider: ProviderAdapter = {
    providerId: "anthropic",
    async *streamChat(request) {
      requests++;
      if (requests === 2) {
        const block = request.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === "tool_result");
        expect(block?.type).toBe("tool_result");
        if (block?.type !== "tool_result")
          throw new Error("Missing model tool result");
        expect(block.isError).toBe(true);
        expect(block.content).toContain("Ненулевой выход");
        expect(block.content).toContain("Exit code: 7");
        expect(block.content).toContain("tool-result://");
        expect(block.content).not.toContain("�");
      }
      yield {
        type: "turn_complete",
        stopReason: requests === 1 ? "tool_use" : "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        message: {
          role: "assistant",
          content:
            requests === 1
              ? [
                  {
                    type: "tool_use",
                    id: "model-shell",
                    name: "run_shell",
                    input: {
                      command: `${quoteShellArg(process.execPath)} ${quoteShellArg(script)}`,
                    },
                  },
                ]
              : [{ type: "text", text: "готово" }],
        },
      };
    },
  };
  const agent = new AgentRuntime(
    provider,
    new ContextManager({}, runtime.context.events),
    {
      selectForTurn: () => runtime.catalog.selectForTurn(),
      execute: (calls, signal) => runtime.scheduler.execute(calls, signal),
    },
    "system",
    runtime.context.events,
  );
  const answer = await agent.run(session, "проверь", { mode: "build" });
  expect(answer.status, answer.error).toBe("completed");
  expect(requests).toBe(2);
  const persisted = SessionV3Schema.parse(
    JSON.parse(JSON.stringify({ ...session, schemaVersion: 3 })),
  );
  const savedResult = Object.values(persisted.runtime?.invocations ?? {}).find(
    (record) => record.name === "run_shell",
  )?.result;
  expect(savedResult?.details?.shell).toBeDefined();
  const legacy = structuredClone(persisted);
  for (const record of Object.values(legacy.runtime?.invocations ?? {}))
    if (record.result?.details) delete record.result.details.shell;
  expect(SessionV3Schema.safeParse(legacy).success).toBe(true);
}, 15000);

test.each([false, true])(
  "tool.result hooks preserve confirmed shell status (abort=%s)",
  async (cancelHook) => {
    const cwd = await root();
    const abort = new AbortController();
    const hooks = new AgentEventPipeline(cwd, new AbortController().signal);
    hooks.on("fixture", "tool.result", async ({ data: { result } }) => {
      expect(result.details?.shell).toBeDefined();
      if (cancelHook) abort.abort();
      return {
        result: {
          ...result,
          output: "formatted",
          rawOutput: "invented",
          isError: true,
          errorCode: "CANCELLED",
          details: { shell: { exitCode: 99 } },
        },
      };
    });
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
      {
        mode: "build",
        artifactDirectory: join(cwd, "artifacts"),
        signal: abort.signal,
        agentEvents: hooks,
      },
    );
    const result = await runtime.executor.execute({
      id: "hook-shell",
      name: "run_shell",
      input: { command: "echo confirmed" },
    });
    expect(result.isError).toBe(false);
    expect(result.details?.exitCode).toBe(0);
    expect(result.output).toContain("Exit code: 0");
    expect(
      (result.details?.shell as { reason: string } | undefined)?.reason,
    ).toBe("exited");
  },
  15000,
);
