import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  composeCommandProjection,
  parseSlashCommand,
  resolveSlashCommand,
  SLASH_COMMANDS,
  splitSlashCommand,
} from "../../src/commands/slash.js";
import {
  COMMAND_DESCRIPTION_LIMIT,
  COMMAND_USAGE_LIMIT,
} from "../../src/extensions/commands.js";
import {
  type ChiselExtension,
  type ExtensionCommandContribution,
  type ExtensionContext,
  ExtensionHost,
} from "../../src/extensions/index.js";
import { userSkillsDir } from "../../src/paths/home.js";
import {
  MAX_VISIBLE_SUGGESTIONS,
  matchingCommands,
  suggestSimilarCommand,
} from "../../src/ui/commands.js";
import { WorkspaceCommands } from "../../src/ui/workspace-commands.js";

const hosts: ExtensionHost[] = [];
const roots: string[] = [];
const env = {
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
};
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose().catch(() => {});
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), "chisel-commands-"));
  roots.push(value);
  return value;
}
function command(name = "inspect"): ExtensionCommandContribution<string> {
  return {
    name,
    description: "Inspect the workspace",
    usage: `/${name} [text]`,
    parse: (args) => args,
    execute: (_ctx, input) => ({ output: input }),
  };
}
function host(definitions: ChiselExtension[]) {
  const value = new ExtensionHost(definitions);
  hosts.push(value);
  return value;
}
function definition(
  id: string,
  commands: ExtensionCommandContribution<string>[],
): ChiselExtension {
  return {
    id,
    activate: (ctx) => {
      for (const command of commands) ctx.commands.register(command);
    },
  };
}

test("one projection resolves, completes and suggests commands with source attribution", async () => {
  const scope = await host([definition("Vendor/a", [command()])]).open(
    await root(),
  );
  const projection = composeCommandProjection(
    [{ name: "review", description: "Review" }],
    scope.commands.descriptors(),
  );
  expect(resolveSlashCommand(projection, " /inspect value ")?.source).toEqual({
    type: "extension",
    extensionId: "Vendor/a",
    name: "inspect",
  });
  expect(resolveSlashCommand(projection, "/inspect")).toMatchObject({
    description: "Inspect the workspace",
    usage: "/inspect [text]",
  });
  expect(resolveSlashCommand(projection, "/review")?.source.type).toBe("skill");
  expect(
    matchingCommands("/ins", projection).map((command) => command.name),
  ).toEqual(["/inspect"]);
  expect(suggestSimilarCommand("/inspec arg", projection)).toBe("/inspect");
  expect(MAX_VISIBLE_SUGGESTIONS).toBe(6);
  expect(resolveSlashCommand(projection, "/sidebar")?.source.type).toBe(
    "builtin",
  );
});

test("slash parsing preserves quotes, backslashes and inner whitespace without case aliases", async () => {
  const scope = await host([definition("args", [command()])]).open(
    await root(),
  );
  const projection = composeCommandProjection([], scope.commands.descriptors());
  const text = ' \t/inspect\n  "a  b"\\c\tsecond  ';
  expect(splitSlashCommand(text)).toEqual({
    name: "/inspect",
    args: '"a  b"\\c\tsecond',
  });
  expect(parseSlashCommand(text, projection)).toEqual(splitSlashCommand(text));
  expect(parseSlashCommand("/Inspect", projection)).toBeUndefined();
  expect(parseSlashCommand("/ins", projection)).toBeUndefined();
  expect(splitSlashCommand("Explain /inspect")).toBeUndefined();
});

test("command snapshots bind methods and outlive mutations of registration metadata/functions", async () => {
  const contribution = command();
  contribution.parse = function (args) {
    expect(this).toBe(contribution);
    return args;
  };
  const scope = await host([definition("stable", [contribution])]).open(
    await root(),
  );
  const stored = scope.commands.get("inspect");
  contribution.name = "other";
  contribution.description = "Changed";
  contribution.parse = () => {
    throw new Error("replaced");
  };
  contribution.execute = () => {
    throw new Error("replaced");
  };
  expect(stored.parse("captured")).toBe("captured");
  expect(scope.commands.descriptors()[0]?.description).toBe(
    "Inspect the workspace",
  );
  expect(Object.isFrozen(scope.commands.descriptors()[0]?.source)).toBe(true);
  const invocation = {
    workspaceRoot: scope.workspaceRoot,
    sessionId: "fixture-session",
    invocationId: "fixture-command",
    mode: "build" as const,
    approvalMode: "default" as const,
    signal: new AbortController().signal,
    tools: { execute: async () => ({ output: "Unused" }) },
  };
  expect(await stored.execute(invocation, "captured")).toEqual({
    output: "captured",
  });
  await scope.dispose();
  expect(() => stored.parse("late")).toThrow();
  expect(() => scope.commands.descriptors()).toThrow();
  await expect(stored.execute(invocation, "late")).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("invalid names, metadata, callbacks and forged ownership never publish registrations", async () => {
  const invalid: object[] = [
    ...["/inspect", "Inspect", "a b", "a:b", "a/b", "x".repeat(65), "a\n"].map(
      (name) => ({ name }),
    ),
    { description: "" },
    { description: "\x1b[31mhello" },
    { description: "line\nline" },
    { description: "x".repeat(COMMAND_DESCRIPTION_LIMIT + 1) },
    { usage: "" },
    { usage: "x".repeat(COMMAND_USAGE_LIMIT + 1) },
    { parse: undefined },
    { execute: undefined },
    { source: { type: "builtin" } },
    { owner: "other" },
    { override: true },
    { privileged: true },
    { ui: {} },
  ];
  const workspace = await root();
  for (const patch of invalid) {
    const owner = host([
      definition("invalid", [Object.assign(command(), patch)]),
    ]);
    await expect(owner.open(workspace)).rejects.toMatchObject({
      extensionId: "invalid",
    });
  }
});

test("every real built-in head is reserved, including aliases and sidebar", async () => {
  const workspace = await root();
  for (const builtin of SLASH_COMMANDS) {
    const owner = host([
      definition("conflict", [command(builtin.name.slice(1))]),
    ]);
    await expect(owner.open(workspace)).rejects.toMatchObject({
      extensionId: "conflict",
    });
  }
});

test("duplicates across owners roll back the whole scope and a failed open can retry cleanly", async () => {
  const cleanup: string[] = [];
  let duplicate = true;
  let oldContext: ExtensionContext | undefined;
  const owner = host([
    {
      id: "first",
      activate(ctx) {
        oldContext = ctx;
        ctx.add({
          dispose: () => {
            cleanup.push("first");
          },
        });
        ctx.commands.register(command());
      },
    },
    {
      id: "second",
      activate(ctx) {
        ctx.add({
          dispose: () => {
            cleanup.push("second");
          },
        });
        ctx.commands.register(command(duplicate ? "inspect" : "second"));
      },
    },
  ]);
  const workspace = await root();
  await expect(owner.open(workspace)).rejects.toMatchObject({
    extensionId: "second",
  });
  expect(cleanup).toEqual(["second", "first"]);
  expect(() => oldContext?.commands.register(command("late"))).toThrow(
    "closed",
  );
  duplicate = false;
  const scope = await owner.open(workspace);
  expect(scope.commands.descriptors().map((command) => command.name)).toEqual([
    "inspect",
    "second",
  ]);
  expect(() => oldContext?.commands.register(command("late"))).toThrow(
    "closed",
  );
  await Promise.all([scope.dispose(), scope.dispose()]);
  expect(cleanup).toEqual(["second", "first", "second", "first"]);
  expect(() => oldContext?.commands.register(command("late"))).toThrow();
  await expect(
    host([definition("same", [command(), command()])]).open(workspace),
  ).rejects.toMatchObject({ extensionId: "same" });
});

test("aliases/concurrent callers reuse one activation; cancelled waiting does not cancel another caller", async () => {
  const workspace = await root();
  const alias = `${workspace}-alias`;
  roots.push(alias);
  await symlink(
    workspace,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  let release = () => {};
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let activations = 0;
  const owner = host([
    {
      id: "shared",
      async activate(ctx) {
        activations++;
        ctx.commands.register(command());
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    },
  ]);
  const cancelled = new AbortController();
  const manager = new WorkspaceCommands(owner);
  const first = manager.load(workspace, cancelled.signal);
  const second = manager.load(relative(process.cwd(), alias));
  await ready;
  expect(
    resolveSlashCommand(manager.current(workspace).projection, "/cwd")?.source
      .type,
  ).toBe("builtin");
  expect(
    resolveSlashCommand(manager.current(workspace).projection, "/inspect"),
  ).toBeUndefined();
  cancelled.abort();
  expect((await first).error).toContain("cancelled");
  release();
  const snapshot = await second;
  expect(snapshot.error).toBeUndefined();
  expect(activations).toBe(1);
  expect(
    resolveSlashCommand(snapshot.projection, "/inspect")?.source.type,
  ).toBe("extension");
  expect(
    resolveSlashCommand(
      manager.current(relative(process.cwd(), alias)).projection,
      "/inspect",
    )?.source.type,
  ).toBe("extension");
});

test("fresh invocable skill conflicts reject the extension layer atomically without disposing services/tools", async () => {
  const storage = await root();
  process.env.XDG_DATA_HOME = storage;
  process.env.LOCALAPPDATA = storage;
  const workspace = await root();
  const owner = host([
    definition("skills", [command("inspect"), command("another")]),
  ]);
  const manager = new WorkspaceCommands(owner);
  const initial = await manager.load(workspace);
  expect(resolveSlashCommand(initial.projection, "/inspect")?.source.type).toBe(
    "extension",
  );
  const directory = join(userSkillsDir(), "inspect");
  await mkdir(directory, { recursive: true });
  const skill = (invocable: boolean) =>
    `---\nname: inspect\ndescription: Inspect skill\nuser-invocable: ${invocable}\n---\nRead fixture.\n`;
  await writeFile(join(directory, "SKILL.md"), skill(true));
  const conflict = await manager.load(workspace);
  expect(conflict.error).toContain(
    "extension skills conflicts with skill /inspect",
  );
  expect(
    resolveSlashCommand(conflict.projection, "/inspect")?.source.type,
  ).toBe("skill");
  expect(resolveSlashCommand(conflict.projection, "/another")).toBeUndefined();
  expect(
    resolveSlashCommand(conflict.projection, "/settings")?.source.type,
  ).toBe("builtin");
  initial.scope?.assertUsable();
  await writeFile(join(directory, "SKILL.md"), skill(false));
  const restored = await manager.load(workspace);
  expect(restored.scope).toBe(initial.scope);
  expect(
    resolveSlashCommand(restored.projection, "/inspect")?.source.type,
  ).toBe("extension");
});
