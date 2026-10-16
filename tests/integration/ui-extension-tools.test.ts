import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runExtensionCommand } from "../../src/app/run-command.js";
import { prepareUiToolInvocation } from "../../src/app/ui-tool.js";
import { defineTool, ExtensionHost } from "../../src/extensions/index.js";

test("a live UI tool inherits core guards and Plan, and scope disposal cancels a pending approval", async () => {
  const storage = await mkdtemp(join(tmpdir(), "chisel-ui-tools-"));
  const envName =
      process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME",
    previous = process.env[envName];
  process.env[envName] = storage;
  const root = join(storage, "project");
  await mkdir(root);
  const configPath = join(storage, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({ schemaVersion: 2, profiles: {}, web: { enabled: false } }),
  );
  let deny = true,
    executions = 0,
    after = 0,
    before = 0;
  const core = new ExtensionHost([
    {
      id: "policy",
      activate(ctx) {
        ctx.guards.afterPrepare(() => {
          after++;
          return { action: "continue" };
        });
        ctx.guards.beforeExecute(() => {
          before++;
          return deny
            ? { action: "deny", reason: "Core guard denies the UI write" }
            : { action: "continue" };
        });
      },
    },
  ]);
  const ui = new ExtensionHost([
    {
      id: "personal.controls",
      activate(ctx) {
        ctx.tools.register(
          defineTool(
            {
              name: "write",
              description: "UI write",
              effect: "workspace_write",
              permission: "write",
              parallelSafe: false,
            },
            z.object({}),
            async () => ({ data: {}, preview: "UI write", resources: [] }),
            async () => {
              executions++;
              return { output: "executed" };
            },
          ),
        );
      },
    },
  ]);
  try {
    const base = await core.open(root),
      overlay = await ui.open(root);
    const prepared = await prepareUiToolInvocation(
      base,
      "personal.controls",
      "write",
      {},
      () => {},
      overlay,
    );
    const run = (
      mode: "plan" | "build",
      resolver = { requestApproval: async () => "approved" as const },
    ) =>
      runExtensionCommand(
        prepared,
        base,
        { cwd: root, configPath, interactive: true, mode },
        resolver,
      );
    const blocked = await run("build");
    expect(blocked.result.isError).toBe(true);
    expect(executions).toBe(0);
    expect(after).toBe(1);
    expect(before).toBe(1);
    deny = false;
    const planned = await run("plan");
    expect(planned.result.isError).toBe(true);
    expect(executions).toBe(0);
    const approved = await run("build");
    expect(approved.result.isError, approved.result.output).not.toBe(true);
    expect(executions).toBe(1);
    let requested = false;
    const pending = run("build", {
      requestApproval: async () => {
        requested = true;
        return new Promise<"approved">(() => {});
      },
    });
    const deadline = Date.now() + 4000;
    while (!requested) {
      if (Date.now() > deadline) throw Error("No approval request");
      await Bun.sleep(10);
    }
    await ui.dispose();
    await pending.catch(() => {});
    expect(executions).toBe(1);
    expect(base.signal.aborted).toBe(false);
  } finally {
    await ui.dispose();
    await core.dispose();
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await rm(storage, { recursive: true, force: true });
  }
}, 15000);
