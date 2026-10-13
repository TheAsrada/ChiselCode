import { test } from "bun:test";
import { join } from "node:path";
import { smokeDesktopEngine } from "../fixtures/desktop-server.js";

test("desktop uses real runtime and survives cross-process history access", async () => {
  await smokeDesktopEngine(process.execPath, [
    join(import.meta.dir, "../../src/desktop/entry.ts"),
  ]);
}, 90_000);
