#!/usr/bin/env bun
import { VERSION } from "../version.js";
import { serveDesktopStdio } from "./stdio.js";

if (process.argv.includes("--version")) process.stdout.write(`${VERSION}\n`);
else {
  const index = process.argv.indexOf("--config");
  try {
    await serveDesktopStdio(index >= 0 ? process.argv[index + 1] : undefined);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Ядро завершилось с ошибкой."}\n`,
    );
    process.exitCode = 1;
  }
}
