import type { ShellRuntime } from "./shell.js";

/** Self-contained helper, serialized into the ordinary Bun/compiled runtime.
 * No project imports, configuration, model calls or user stdin are available. */
export async function processSupervisor(
  runtime: ShellRuntime,
  windowsTransport: string,
): Promise<void> {
  const { spawn, execFile } = await import("node:child_process");
  const { createWriteStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  // Linux adopts orphaned descendants, including a fast double fork. Census
  // can then detect a changed process group and keep a recovery fence.
  let orphanTracking = process.platform !== "linux";
  if (process.platform === "linux") {
    try {
      const { dlopen, FFIType } = await import("bun:ffi");
      const libc = dlopen("libc.so.6", {
        prctl: {
          args: [
            FFIType.i32,
            FFIType.u64,
            FFIType.u64,
            FFIType.u64,
            FFIType.u64,
          ],
          returns: FFIType.i32,
        },
      });
      orphanTracking = libc.symbols.prctl(36, 1, 0, 0, 0) === 0;
      libc.close();
    } catch {
      /* Without proof Linux retains a recovery fence. */
    }
  }
  const control = createWriteStream("", { fd: 3, autoClose: false });
  const send = (value: unknown) => control.write(`${JSON.stringify(value)}\n`);
  const input = createInterface({ input: process.stdin });
  let shell: ReturnType<typeof spawn> | undefined;
  let exited = false;
  let stdoutDone = false;
  let stderrDone = false;
  let code: number | null = null;
  let signal: string | null = null;
  let stopping = false;
  let sampling = false;
  let finished = false;
  let escaped = !orphanTracking;
  let commandPid: number | undefined;
  let commandEof = false;
  let transportExited = false;
  let transportEnding = false;
  let transportError = Buffer.alloc(0);
  const descendants = new Map<number, string>();
  const startedAt = Date.now();
  type Row = {
    pid: number;
    parent: number;
    group: number;
    zombie: boolean;
    start: string;
    name?: string;
    executable?: string;
  };
  async function census(): Promise<Row[]> {
    const windows = process.platform === "win32";
    const args = windows
      ? [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath | ConvertTo-Json -Compress",
        ]
      : ["-axo", "pid=,ppid=,pgid=,stat=,lstart="];
    let probe: ReturnType<typeof execFile>;
    const output = await new Promise<string>((resolve, reject) => {
      probe = execFile(
        windows ? "powershell.exe" : "ps",
        args,
        { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const rows: Row[] = windows
      ? (Array.isArray(JSON.parse(output))
          ? JSON.parse(output)
          : [JSON.parse(output)]
        ).map(
          (row: {
            ProcessId: number;
            ParentProcessId: number;
            CreationDate: string;
            Name: string;
            ExecutablePath?: string;
          }) => ({
            pid: row.ProcessId,
            parent: row.ParentProcessId,
            group: 0,
            zombie: false,
            start: String(row.CreationDate),
            name: row.Name,
            executable: row.ExecutablePath,
          }),
        )
      : output
          .trim()
          .split("\n")
          .map((line) => {
            const [pid, parent, group, state, ...start] = line
              .trim()
              .split(/\s+/);
            return {
              pid: Number(pid),
              parent: Number(parent),
              group: Number(group),
              zombie: state?.startsWith("Z") ?? false,
              start: start.join(" "),
            };
          });
    const probes = new Set([probe!.pid]);
    for (let count = 0; count < rows.length; count++) {
      let changed = false;
      for (const row of rows)
        if (probes.has(row.parent) && !probes.has(row.pid)) {
          probes.add(row.pid);
          changed = true;
        }
      if (!changed) break;
    }
    const consoleHost =
      `${process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows"}\\System32\\conhost.exe`.toLowerCase();
    return rows.filter(
      (row) =>
        row.pid !== process.pid &&
        !probes.has(row.pid) &&
        !row.zombie &&
        // Bun's supervisor can own its own hidden Windows console. It remains
        // alive until the supervisor exits, and is not a user-command writer.
        // Do not ignore similarly named user programs or command descendants.
        !(
          windows &&
          (row.parent === process.pid || row.parent === shell?.pid) &&
          row.executable?.toLowerCase() === consoleHost
        ),
    );
  }
  const finish = async (cleanup: boolean) => {
    if (finished) return;
    finished = true;
    send({ type: "cleanup_phase", phase: "flush" });
    clearInterval(clock);
    input.close();
    send({
      type: "done",
      exitCode: code,
      signal,
      cleanup,
      escaped,
      durationMs: Date.now() - startedAt,
    });
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) =>
          new Promise<void>((resolve) => stream.write("", () => resolve())),
      ),
    );
    control.end(() => process.exit(0));
  };
  const finishWindowsTransport = () => {
    // After command exit + EOF + an empty owned-tree census, the fixed
    // transport only disposes handles and exits. Its exit/pipe events are
    // enough to finish that handshake; another expensive CIM query cannot
    // add command-writer evidence and can exhaust a child's drain budget.
    if (transportEnding && transportExited && stdoutDone && stderrDone)
      void finish(!escaped);
  };
  const sample = async () => {
    if (sampling || finished || !shell?.pid) return;
    if (transportEnding) {
      finishWindowsTransport();
      return;
    }
    sampling = true;
    try {
      const commandEndedBeforeCensus = exited && commandEof;
      const rows = await census();
      const leader = rows.find((row) => row.pid === shell!.pid);
      if (
        leader &&
        !descendants.has(leader.pid) &&
        (leader.parent === process.pid ||
          (process.platform !== "win32" && leader.group === process.pid))
      )
        descendants.set(leader.pid, leader.start);
      for (const [pid, start] of descendants)
        if (!rows.some((row) => row.pid === pid && row.start === start))
          descendants.delete(pid);
      for (let count = 0; count < rows.length; count++) {
        let changed = false;
        for (const row of rows)
          if (
            (descendants.has(row.parent) ||
              row.parent === commandPid ||
              row.parent === process.pid ||
              (process.platform !== "win32" && row.group === process.pid)) &&
            !descendants.has(row.pid)
          ) {
            if (descendants.size >= 4096 || !row.start) {
              escaped = true;
              send({ type: "ownership_unknown" });
              continue;
            }
            descendants.set(row.pid, row.start);
            changed = true;
          }
        if (!changed) break;
      }
      const live = rows.filter(
        (row) =>
          (descendants.has(row.pid) &&
            !(
              runtime.kind === "cmd" &&
              exited &&
              commandEof &&
              row.pid === shell?.pid
            )) ||
          (process.platform !== "win32" && row.group === process.pid),
      );
      if (exited)
        send({
          type: "cleanup_phase",
          phase: stdoutDone && stderrDone ? "tree" : "pipes",
          detail: live
            .slice(0, 12)
            .map((row) => row.name ?? "process")
            .join(", "),
        });
      if (
        process.platform !== "win32" &&
        live.some((row) => row.group !== process.pid) &&
        !escaped
      ) {
        escaped = true;
        send({ type: "ownership_unknown" });
      }
      if (runtime.kind === "cmd" && commandEndedBeforeCensus && !live.length) {
        if (!transportEnding) {
          transportEnding = true;
          send({ type: "cleanup_phase", phase: "transport" });
          if (!transportExited) shell.stdin?.write("finish\n");
        }
        finishWindowsTransport();
      } else if (
        runtime.kind !== "cmd" &&
        exited &&
        stdoutDone &&
        stderrDone &&
        !live.length
      )
        finish(!escaped);
      else if (
        process.platform !== "win32" &&
        exited &&
        stdoutDone &&
        stderrDone &&
        escaped &&
        live.every((row) => row.group !== process.pid)
      )
        finish(false);
      else if (stopping && process.platform === "win32") {
        // The helper remains the tracked tree root even after the shell leader exits.
        // Never accept a caller-provided PID or a restored record here.
        for (const row of live)
          await new Promise<void>((resolve) => {
            execFile(
              "taskkill",
              ["/pid", String(row.pid), "/T", "/F"],
              { windowsHide: true, timeout: 2000 },
              () => resolve(),
            );
          });
      }
    } catch (error) {
      // A failed census is not evidence that writers disappeared. Retry until
      // the parent's bounded cleanup deadline, then retain a recovery fence.
      send({
        type: "cleanup_phase",
        phase: "census_error",
        detail:
          error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    } finally {
      sampling = false;
    }
  };
  const clock = setInterval(
    () => {
      void sample();
    },
    process.platform === "win32" ? 1000 : 250,
  );
  const stop = () => {
    if (stopping || finished) return;
    stopping = true;
    if (process.platform !== "win32") {
      try {
        process.kill(-process.pid, "SIGTERM");
      } catch {
        /* Parent checks cleanup. */
      }
    }
    void sample();
  };
  // Keep the supervisor available while ordinary descendants receive TERM.
  process.on("SIGTERM", () => {
    stopping = true;
    void sample();
  });
  input.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.type === "stop") {
        stop();
        return;
      }
      if (
        shell ||
        message.type !== "start" ||
        typeof message.command !== "string" ||
        typeof message.cwd !== "string" ||
        !Number.isSafeInteger(message.ownerPid) ||
        message.ownerPid <= 0
      )
        return;
      const env = { ...process.env };
      delete env.BUN_BE_BUN;
      const windows = runtime.kind === "cmd";
      if (windows) {
        // CMD diagnostics and Python's redirected streams must agree with the
        // UTF-8 capture pipeline. Explicit caller overrides remain possible.
        env.PYTHONIOENCODING ??= "utf-8";
        env.PYTHONUTF8 ??= "1";
        env.CHISEL_SHELL_COMMAND = message.command;
        env.CHISEL_SHELL_EXECUTABLE = runtime.executable;
        env.CHISEL_SHELL_CWD = message.cwd;
        env.CHISEL_SHELL_OWNER_PID = String(message.ownerPid);
      }
      shell = spawn(
        windows ? "powershell.exe" : runtime.executable,
        windows
          ? [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(windowsTransport, "utf16le").toString("base64"),
            ]
          : ["-c", message.command],
        {
          cwd: message.cwd,
          shell: false,
          windowsVerbatimArguments: false,
          windowsHide: true,
          env,
          stdio: [windows ? "pipe" : "ignore", "pipe", "pipe"],
        },
      );
      shell.on("spawn", () => {
        if (!orphanTracking) send({ type: "ownership_unknown" });
        if (!windows)
          send({ type: "ready", pid: shell?.pid, supervisorPid: process.pid });
      });
      if (windows) {
        void (async () => {
          let pending = "";
          for await (const chunk of shell!.stdout!) {
            pending += Buffer.from(chunk).toString("utf8");
            let end = pending.indexOf("\n");
            while (end !== -1) {
              const frame = JSON.parse(pending.slice(0, end));
              pending = pending.slice(end + 1);
              end = pending.indexOf("\n");
              if (frame.type === "started") {
                commandPid = frame.pid;
                send({
                  type: "ready",
                  pid: commandPid,
                  supervisorPid: process.pid,
                });
              } else if (frame.type === "output") {
                const target =
                  frame.stream === "stderr" ? process.stderr : process.stdout;
                await new Promise<void>((resolve, reject) =>
                  target.write(Buffer.from(frame.data, "base64"), (error) =>
                    error ? reject(error) : resolve(),
                  ),
                );
              } else if (frame.type === "exit") {
                exited = true;
                code = frame.code;
                send({ type: "exit", exitCode: code, signal: null });
                void sample();
              } else if (frame.type === "eof") {
                commandEof = true;
                void sample();
              } else if (frame.type === "owner_gone") {
                // A native owner handle observes crash even if an inherited
                // Windows pipe remains open. Stop only this live owned tree.
                input.close();
              } else if (frame.type === "error") {
                escaped = true;
                send({ type: "error", message: frame.message });
                send({ type: "ownership_unknown" });
                stop();
              }
            }
            if (pending.length > 16384)
              throw new Error("Внутренний канал Windows переполнен.");
          }
          stdoutDone = true;
          if (transportEnding) finishWindowsTransport();
          else void sample();
        })().catch((error) => {
          escaped = true;
          send({ type: "error", message: String(error) });
          send({ type: "ownership_unknown" });
          stop();
        });
      } else shell.stdout!.pipe(process.stdout, { end: false });
      if (windows) {
        void (async () => {
          for await (const chunk of shell!.stderr!)
            transportError = Buffer.concat([
              transportError,
              Buffer.from(chunk),
            ]).subarray(-2048);
          stderrDone = true;
          if (transportEnding) finishWindowsTransport();
          else void sample();
        })().catch(() => {
          stderrDone = true;
          escaped = true;
          stop();
        });
      } else shell.stderr!.pipe(process.stderr, { end: false });
      shell.stdout!.on("end", () => {
        if (!windows) stdoutDone = true;
        void sample();
      });
      shell.stderr!.on("end", () => {
        if (!windows) stderrDone = true;
        void sample();
      });
      shell.on("exit", (exitCode, exitSignal) => {
        if (windows) {
          transportExited = true;
          if (!exited || !commandEof) {
            escaped = !stopping && !!commandPid;
            if (!exited) {
              exited = true;
              code = commandPid ? null : exitCode;
            }
            commandEof = true;
            if (!stopping)
              send({
                type: "error",
                message: `Windows helper завершился до подтверждения вывода. ${transportError.toString("utf8").slice(0, 500)}`,
              });
            if (escaped) send({ type: "ownership_unknown" });
          }
          if (transportEnding) finishWindowsTransport();
          else void sample();
          return;
        }
        exited = true;
        code = exitCode;
        signal = exitSignal;
        send({ type: "exit", exitCode, signal: exitSignal });
        void sample();
      });
      shell.on("error", (error) => {
        exited = stdoutDone = stderrDone = true;
        send({ type: "error", message: error.message });
        finish(true);
      });
    } catch {
      send({
        type: "error",
        message: "Некорректный внутренний запрос процесса.",
      });
    }
  });
  input.on("close", () => {
    if (!finished) {
      stop();
      setTimeout(
        () => {
          if (finished) return;
          if (process.platform !== "win32") {
            try {
              process.kill(-process.pid, "SIGKILL");
            } catch {
              process.exit(1);
            }
          } else process.exit(1);
        },
        process.platform === "win32" ? 10000 : 2000,
      );
    }
  });
  // A crashed application can close output/control before stdin. Keep the
  // supervisor alive to stop its group rather than dying on an unhandled EPIPE.
  const parentGone = () => input.close();
  control.on("error", parentGone);
  process.stdout.on("error", parentGone);
  process.stderr.on("error", parentGone);
}
