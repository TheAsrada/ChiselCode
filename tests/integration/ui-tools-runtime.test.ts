import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtensionCommand } from "../../src/app/run-command.js";
import { prepareUiToolInvocation } from "../../src/app/ui-tool.js";
import { ExtensionHost } from "../../src/extensions/index.js";
import { workspaceCoordinator } from "../../src/tools/workspace-coordinator.js";
import { uiExtension } from "../fixtures/ui-extension.js";

test("own UI tools preserve Plan, denial, guards, background fences, schema and checkpoint contracts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-ui-policy-"));
  const root = join(directory, "project");
  await mkdir(root);
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      profiles: {},
      web: { enabled: false },
      permissions: { allowBypassPermissions: true },
    }),
  );
  const fixture = uiExtension();
  let guard = false;
  const host = new ExtensionHost([
    fixture.extension,
    {
      id: "policy",
      activate(ctx) {
        ctx.guards.beforeExecute(() =>
          guard
            ? { action: "deny", reason: "UI guard veto" }
            : { action: "continue" },
        );
      },
    },
  ]);
  const previous = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  Object.assign(process.env, {
    XDG_DATA_HOME: directory,
    LOCALAPPDATA: directory,
  });
  try {
    const scope = await host.open(root);
    const prepare = () =>
      prepareUiToolInvocation(
        scope,
        fixture.extension.id,
        "save",
        { value: "Подтверждённый выбор" },
        () => {},
      );
    await expect(
      prepareUiToolInvocation(
        scope,
        fixture.extension.id,
        "save",
        { cwd: root, value: "x" },
        () => {},
      ),
    ).rejects.toThrow();
    await expect(
      prepareUiToolInvocation(
        scope,
        fixture.extension.id,
        "ext:foreign:save",
        {},
        () => {},
      ),
    ).rejects.toThrow();
    const run = async (
      mode: "plan" | "build",
      decision: "approved" | "denied",
      signal?: AbortSignal,
    ) =>
      runExtensionCommand(
        await prepare(),
        scope,
        { cwd: root, configPath, interactive: true, mode },
        { requestApproval: async () => decision },
        {},
        signal,
      );
    expect((await run("plan", "approved")).result.errorCode).toBe(
      "MODE_RESTRICTION",
    );
    expect((await run("build", "denied")).result.errorCode).toBe(
      "PERMISSION_DENIED",
    );
    expect(fixture.writes()).toBe(0);
    guard = true;
    expect((await run("build", "approved")).result.errorCode).toBe(
      "EXTENSION_HOOK_DENIED",
    );
    guard = false;
    const lease = await workspaceCoordinator.acquirePlanLease([
      { resource: scope.workspaceRoot, mode: "write" },
    ]);
    const retained = await lease.transfer({
      taskId: crypto.randomUUID(),
      ownerId: "parent",
      label: "Длительная проверка",
      state: "running",
    });
    try {
      expect((await run("build", "approved")).result.errorCode).toBe(
        "BACKGROUND_RESOURCE_BUSY",
      );
      expect(fixture.writes()).toBe(0);
    } finally {
      await retained.release();
    }
    const result = await run("build", "approved");
    expect(result.result.isError).toBeUndefined();
    expect(await readFile(join(root, "ui-result.txt"), "utf8")).toBe(
      "Подтверждённый выбор",
    );
    expect(fixture.writes()).toBe(1);
    expect(result.session.messages).toHaveLength(0);
    expect(
      Object.values(result.session.runtime?.invocations ?? {}).some(
        (invocation) =>
          invocation.name === "ext:fixture.interface:save" &&
          invocation.result?.output === "Выбор сохранён",
      ),
    ).toBe(true);
    await expect(
      prepareUiToolInvocation(
        scope,
        fixture.extension.id,
        "save",
        { value: "x" },
        () => {
          throw new Error("owner replaced");
        },
      ),
    ).rejects.toThrow("owner replaced");
  } finally {
    await host.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
