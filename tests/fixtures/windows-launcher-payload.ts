import { rename, writeFile } from "node:fs/promises";

const marker = process.env.CHISEL_LAUNCH_MARKER;
if (!marker) throw new Error("Нет marker изолированной проверки.");
await writeFile(
  `${marker}.tmp`,
  JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    execPath: process.execPath,
    pid: process.pid,
  }),
);
await rename(`${marker}.tmp`, marker);
