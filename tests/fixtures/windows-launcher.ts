import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

assert.equal(process.platform, "win32");
async function cleanup(path: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (cause) {
      if (
        !["EBUSY", "EPERM", "ENOTEMPTY"].includes(
          (cause as NodeJS.ErrnoException).code ?? "",
        ) ||
        Date.now() >= deadline
      )
        throw cause;
      await Bun.sleep(50);
    }
  }
}
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-launcher-")),
);
const destination = join(directory, "Папка приложения с пробелами");
const marker = join(directory, "launch.json");
await mkdir(destination);
const env = { CHISEL_LAUNCH_MARKER: marker };
const launched = async () => {
  const deadline = Date.now() + 10_000;
  while (!(await Bun.file(marker).exists())) {
    assert.ok(
      Date.now() < deadline,
      "Не получен argv/cwd запущенного приложения.",
    );
    await Bun.sleep(10);
  }
  const result = JSON.parse(await readFile(marker, "utf8"));
  assert.deepEqual(result.argv, ["--launcher"]);
  assert.equal(result.cwd.toLowerCase(), destination.toLowerCase());
  for (;;) {
    try {
      process.kill(result.pid, 0);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH") break;
      throw cause;
    }
    assert.ok(Date.now() < deadline, "Контрольный процесс не завершился.");
    await Bun.sleep(10);
  }
  await rm(marker);
};
try {
  await execa(process.execPath, [
    "build",
    "tests/fixtures/windows-launcher-payload.ts",
    "--compile",
    `--outfile=${join(destination, "chisel.exe")}`,
  ]);
  await copyFile("installer/assets/icon.ico", join(destination, "icon.ico"));
  const installer = join(directory, "launcher-setup.exe");
  await execa("makensis", [
    "/V2",
    `/DOUTPUT=${installer}`,
    `/DDESTINATION=${destination}`,
    "tests/fixtures/windows-launcher.nsi",
  ]);
  await execa(installer, ["/S"], { env });
  await launched();
  for (const name of ["Start Menu.lnk", "Desktop.lnk"]) {
    const link = join(destination, name);
    const inspected = await execa(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $shortcutShell = New-Object -ComObject WScript.Shell; $shortcut = $shortcutShell.CreateShortcut($env:CHISEL_LAUNCH_LINK); @{ TargetPath=$shortcut.TargetPath; Arguments=$shortcut.Arguments; WorkingDirectory=$shortcut.WorkingDirectory } | ConvertTo-Json -Compress",
      ],
      { env: { CHISEL_LAUNCH_LINK: link } },
    );
    const details = JSON.parse(inspected.stdout);
    assert.equal(
      details.TargetPath.toLowerCase(),
      join(destination, "chisel.exe").toLowerCase(),
    );
    assert.equal(details.Arguments, "--launcher");
    assert.equal(
      details.WorkingDirectory.toLowerCase(),
      destination.toLowerCase(),
    );
    await execa(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Start-Process -FilePath $env:CHISEL_LAUNCH_LINK -WindowStyle Hidden",
      ],
      { env: { ...env, CHISEL_LAUNCH_LINK: link } },
    );
    await launched();
  }
  console.log(
    "Windows launcher: real NSIS shortcuts, TargetPath/Arguments/WorkingDirectory, finish-page handler and ShellExecute argv/cwd verified",
  );
} finally {
  await cleanup(directory);
}
