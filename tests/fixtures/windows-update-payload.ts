import { existsSync, renameSync, writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  console.log("9.9.9");
} else {
  const marker = process.env.CHISEL_UPDATE_RELAUNCH_MARKER;
  if (!marker) throw new Error("Missing isolated update marker");
  writeFileSync(
    `${marker}.tmp`,
    JSON.stringify({
      pid: process.pid,
      argv: process.argv.slice(2),
      executable: process.execPath,
      stdin: !!process.stdin.isTTY,
      stdout: !!process.stdout.isTTY,
      cleanup: existsSync(process.env.CHISEL_UPDATE_CLEANUP_MARKER ?? ""),
    }),
  );
  renameSync(`${marker}.tmp`, marker);
}
