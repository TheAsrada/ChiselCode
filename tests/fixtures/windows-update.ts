import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { execa } from "execa";
import {
  encodeNsisArguments,
  windowsUpdateArguments,
} from "../../src/commands/update.js";

assert.equal(
  process.platform,
  "win32",
  "This is an actual Windows/NSIS regression, not a simulation",
);
const root = await mkdtemp(join(tmpdir(), "chisel-update-native-"));
let lock: ReturnType<typeof execa> | undefined;
const until = async (ready: () => Promise<boolean>, message: string) => {
  const deadline = Date.now() + 30000;
  while (!(await ready())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((done) => setTimeout(done, 30));
  }
};
const exists = async (file: string) => Bun.file(file).exists();
const exited = async (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
try {
  const destination = join(root, "Custom Apps & каталог");
  const project = join(root, "Проект & demo");
  const data = join(root, "data");
  await Promise.all([mkdir(destination), mkdir(project), mkdir(data)]);
  const client = join(destination, "chisel.exe");
  const fresh = join(root, "new.exe");
  const setup = join(root, "setup.exe");
  const marker = join(root, "relaunch.json");
  const cleanup = join(root, "cleanup.json");
  await execa(process.execPath, [
    "build",
    "tests/fixtures/windows-update-payload.ts",
    "--compile",
    `--outfile=${fresh}`,
  ]);
  await execa(process.execPath, [
    "build",
    "tests/fixtures/tui-update-restart.ts",
    "--compile",
    `--outfile=${client}`,
  ]);
  const old = await readFile(client);
  await mkdir(join(destination, "skills"));
  await cp("skills/bundled", join(destination, "skills/bundled"), {
    recursive: true,
  });
  await execa("makensis", [
    "/V2",
    `/DPAYLOAD=${fresh}`,
    `/DOUTPUT=${setup}`,
    `/DDESTINATION=${destination}`,
    "tests/fixtures/windows-update.nsi",
  ]);
  const env = {
    LOCALAPPDATA: data,
    APPDATA: data,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: data,
    CHISEL_UPDATE_PROJECT: project,
    CHISEL_UPDATE_TEST_INSTALLER: setup,
    CHISEL_UPDATE_RELAUNCH_MARKER: marker,
    CHISEL_UPDATE_CLEANUP_MARKER: cleanup,
    CHISEL_UPDATE_CAPTURES: resolve("dist/update-captures"),
  };
  await execa(client, [], { env, timeout: 60000 });
  await until(
    () => exists(marker),
    "No relaunch after the old application exited",
  );
  const launched = JSON.parse(await readFile(marker, "utf8"));
  await until(() => exited(launched.pid), "New console process did not exit");
  assert.ok(launched.cleanup, "Relaunch happened before application cleanup");
  assert.equal(
    resolve(launched.argv[1]),
    project,
    "NSIS lost the project path",
  );
  assert.ok(
    launched.stdin && launched.stdout,
    "Relaunch inherited ignored stdio instead of opening a console",
  );
  assert.deepEqual(
    await readFile(client),
    await readFile(fresh),
    "Installer did not replace the running executable",
  );
  assert.match(
    (await readFile(join(destination, "update.log"))).toString("utf16le"),
    /success: 9\.9\.9/,
  );

  // A second open handle must cause an honest, bounded failure and preserve bytes.
  await writeFile(client, old);
  const locked = join(root, "locked");
  lock = execa(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$f=[IO.File]::Open($env:CHISEL_LOCK_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [IO.File]::WriteAllText($env:CHISEL_LOCK_READY,'ready'); [Console]::ReadLine() | Out-Null; $f.Dispose()",
    ],
    {
      env: { CHISEL_LOCK_PATH: client, CHISEL_LOCK_READY: locked },
      stdin: "pipe",
      reject: false,
    },
  );
  await until(() => exists(locked), "No locked executable");
  const failed = await execa(
    setup,
    encodeNsisArguments(["/S", `/D=${destination}`]),
    { env, windowsVerbatimArguments: true, reject: false, timeout: 20000 },
  );
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(
    await readFile(client),
    old,
    "A failed update removed the old executable",
  );
  lock.kill();
  await lock;
  lock = undefined;
  const diagnostic = await execa(client, ["--inspect-update-failure"], {
    env,
    timeout: 10000,
  });
  assert.match(
    diagnostic.stdout,
    /Предыдущее обновление не завершено.*Закройте другие окна/,
  );

  // Windows root paths must survive both NSIS parsing and ShellExecute argv.
  await rm(marker);
  const drive = parse(project).root;
  await execa(
    setup,
    encodeNsisArguments([
      ...windowsUpdateArguments(drive, "saved-123"),
      `/D=${destination}`,
    ]),
    { env, windowsVerbatimArguments: true, timeout: 20000 },
  );
  await until(() => exists(marker), "No relaunch for root project path");
  const resumed = JSON.parse(await readFile(marker, "utf8"));
  await until(() => exited(resumed.pid), "Root-path process did not exit");
  assert.deepEqual(resumed.argv, [
    "--cwd",
    `${drive}\\.`,
    "--resume",
    "saved-123",
  ]);
  assert.equal(resolve(resumed.argv[1]), drive);
  console.log(
    "Windows update: production OpenTUI → verified download → cleanup/exit without pause → real NSIS replacement → new console; locked-file preservation/error recovery and root path/session resume passed",
  );
} finally {
  if (lock) {
    lock.kill();
    await lock;
  }
  await rm(root, { recursive: true, force: true });
}
