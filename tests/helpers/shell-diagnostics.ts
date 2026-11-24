import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProcessLog } from "../../src/processes/log.js";
import type { ApprovalResolver } from "../../src/security/approval.js";
import type { ToolCall, ToolExecutionResult } from "../../src/types/domain.js";
import { quoteShellArg } from "./shell.js";

export function shellDiagnosticApproval(root: string): ApprovalResolver {
  return {
    async requestApproval(request) {
      if (request.preview.includes("cwd-after-approval"))
        await rm(join(root, "cwd-after-approval"), { recursive: true });
      return "approved";
    },
  };
}

/** Real processes through the ordinary executor, shared by both ownership paths. */
export async function verifyShellDiagnostics(
  root: string,
  execute: (
    call: ToolCall,
    signal?: AbortSignal,
  ) => Promise<ToolExecutionResult>,
  readArtifact: (uri: string) => Promise<string>,
) {
  const marker = join(root, "unexpected-shell-start");
  const script = join(root, "cwd-check.cjs");
  await writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
  );
  const command = `${quoteShellArg(process.execPath)} ${quoteShellArg(script)}`;
  const invalidCwd = async (cwd: string, reason: RegExp) => {
    const result = await execute({
      id: `diagnostic-${cwd}`,
      name: "run_shell",
      input: { command, cwd },
    });
    assert.equal(result.errorCode, "INVALID_TOOL_INPUT", result.output);
    assert.match(result.output, /cwd/);
    assert.ok(result.output.includes(cwd), result.output);
    assert.match(result.output, reason);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  };
  await invalidCwd("cwd-missing", /каталог не существует/);
  await invalidCwd("cwd-check.cjs", /не является каталогом/);
  await mkdir(join(root, "cwd-after-approval"));
  await invalidCwd("cwd-after-approval", /каталог не существует/);

  // Delete the directory after validation, at the real supervisor spawn.
  const race = join(root, "cwd-at-spawn");
  await mkdir(race);
  const createLog = ProcessLog.prototype.create;
  const execPath = Object.getOwnPropertyDescriptor(process, "execPath");
  assert.ok(execPath?.configurable);
  ProcessLog.prototype.create = async function () {
    await createLog.call(this);
    Object.defineProperty(process, "execPath", {
      configurable: true,
      get() {
        if (new Error().stack?.includes("new ManagedProcess")) {
          Object.defineProperty(process, "execPath", execPath);
          rmSync(race, { recursive: true });
        }
        return execPath.value;
      },
    });
  };
  try {
    await invalidCwd("cwd-at-spawn", /Причина запуска: .+/);
  } finally {
    ProcessLog.prototype.create = createLog;
    Object.defineProperty(process, "execPath", execPath);
  }
  await mkdir(join(root, "cwd-valid"));
  const next = await execute({
    id: "diagnostic-cwd-valid",
    name: "run_shell",
    input: { command: "echo cwd-valid", cwd: "cwd-valid" },
  });
  assert.equal(next.isError, false, next.output);
  assert.equal(next.details?.exitCode, 0);
  assert.ok(next.output.includes("cwd-valid"), next.output);

  let ordinal = 0;
  const run = async (source: string, timeout = 10000, signal?: AbortSignal) => {
    const file = join(root, `diagnostic-${ordinal++}.cjs`);
    await writeFile(file, source);
    return execute(
      {
        id: `diagnostic-${ordinal}`,
        name: "run_shell",
        input: {
          command: `${quoteShellArg(process.execPath)} ${quoteShellArg(file)}`,
          timeout,
        },
      },
      signal,
    );
  };
  const shell = (result: ToolExecutionResult) => {
    const data = result.details?.shell as Record<string, unknown>;
    assert.ok(data, result.output);
    assert.ok(result.output.includes(String(data.summary)), result.output);
    assert.ok(Number(data.waitMs) >= 0);
    assert.ok(Number(data.cleanupMs) >= 0);
    return data;
  };
  for (const code of [0, 7]) {
    const result = await run(`console.log('итог'); process.exitCode=${code}`);
    assert.equal(shell(result).exitCode, code);
    assert.equal(result.isError, code !== 0);
    assert.equal(shell(result).captureComplete, true);
  }
  if (process.platform !== "win32") {
    const result = await execute({
      id: "diagnostic-signal",
      name: "run_shell",
      input: {
        command: "printf 'сигнал\\n'; kill -TERM $$",
      },
    });
    assert.equal(shell(result).signal, "SIGTERM");
    assert.equal(shell(result).exitCode, null);
    assert.equal(shell(result).reason, "signal");
    assert.equal(result.isError, true);
    assert.ok(!result.output.includes("143"));
  }
  const limit = process.platform === "win32" ? 4000 : 1200;
  const timeout = await run(
    "console.log('частичный вывод'); setTimeout(()=>{},60000)",
    limit,
  );
  assert.equal(timeout.errorCode, "TOOL_TIMEOUT");
  assert.equal(shell(timeout).reason, "timed_out");
  assert.equal(shell(timeout).timeoutMs, limit);
  assert.ok(timeout.output.includes("частичный вывод"), timeout.output);
  const ready = join(root, "diagnostic-ready");
  const abort = new AbortController();
  const pending = run(
    `console.log('до отмены');require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},60000)`,
    10000,
    abort.signal,
  );
  const deadline = Date.now() + 8000;
  while ((await readFile(ready, "utf8").catch(() => "")) !== "ready") {
    assert.ok(
      Date.now() < deadline,
      "Command did not become ready for cancellation",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  abort.abort();
  const cancelled = await pending;
  assert.equal(cancelled.errorCode, "CANCELLED");
  assert.equal(shell(cancelled).reason, "cancelled");
  assert.ok(cancelled.output.includes("до отмены"));

  const close = ProcessLog.prototype.close;
  ProcessLog.prototype.close = async function () {
    await close.call(this);
    throw new Error("fixture: capture flush failed");
  };
  try {
    const failed = await run(
      "console.log('сохранённый вывод');console.log('я€🙂'.repeat(40000))",
    );
    assert.equal(failed.isError, true);
    assert.equal(shell(failed).reason, "capture_failed");
    assert.equal(shell(failed).exitCode, 0);
    assert.equal(shell(failed).captureComplete, false);
    assert.ok(failed.output.includes("сохранённый вывод"));
    assert.ok(failed.artifact);
    assert.ok(failed.output.includes("захват неполный"));
    assert.ok(!failed.output.includes("Полный захваченный лог"));
  } finally {
    ProcessLog.prototype.close = close;
  }

  const create = ProcessLog.prototype.create;
  ProcessLog.prototype.create = async function () {
    this.narrowLimit(1024);
    await create.call(this);
  };
  try {
    const overflow = await run("console.log('я'.repeat(50000))");
    assert.equal(overflow.isError, true);
    assert.equal(shell(overflow).reason, "output_limit");
    assert.equal(shell(overflow).captureComplete, false);
  } finally {
    ProcessLog.prototype.create = create;
  }

  const large = await run(
    "console.log('я€🙂'.repeat(40000));process.exitCode=7",
  );
  assert.equal(shell(large).reason, "nonzero_exit");
  assert.equal(shell(large).captureComplete, true);
  assert.ok(large.artifact, large.output);
  assert.ok(large.output.includes("Полный захваченный лог"));
  assert.ok(!large.output.includes("�"));
  const log = await readArtifact(large.artifact.uri);
  assert.ok(log.includes("я€🙂"));
  assert.ok(!log.includes("�"));
  assert.ok(!log.includes("Exit code"));
}
