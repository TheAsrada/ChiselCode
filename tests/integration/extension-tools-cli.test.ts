import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { smokeManifestCli } from "../fixtures/manifest-cli.js";

test("ordinary owned CLI composition exposes and executes the real manifest contribution in Plan", async () => {
  expect(
    await smokeManifestCli(process.execPath, [resolve("src/cli.ts")]),
  ).toEqual({
    calls: 2,
    canonicalName: "ext:builtin.project:manifest",
    status: "completed",
  });
}, 35000);
