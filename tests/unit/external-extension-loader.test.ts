import { afterEach, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExtensionCommand } from "../../src/app/run-command.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { ExternalExtensionLoader } from "../../src/extensions/external/loader.js";
import {
  extensionsDirectory,
  inspectPackage,
  runtimeSnapshot,
} from "../../src/extensions/external/package.js";
import {
  approvePackage,
  extensionRecords,
} from "../../src/extensions/external/registry.js";
import { ExtensionHost } from "../../src/extensions/host.js";

const keys = ["XDG_DATA_HOME", "LOCALAPPDATA"] as const;
const saved = keys.map((key) => process.env[key]);
const roots: string[] = [],
  hosts: ExtensionHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose().catch(() => {});
  for (let i = 0; i < keys.length; i++) {
    if (saved[i] === undefined) delete process.env[keys[i]!];
    else process.env[keys[i]!] = saved[i];
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(code = "", id = "fixture.external") {
  const root = await mkdtemp(join(tmpdir(), "chisel-external-"));
  roots.push(root);
  for (const key of keys) process.env[key] = join(root, "Данные пользователя");
  const dir = join(await extensionsDirectory(), "Пакет с пробелами"),
    sentinel = join(root, "sentinel.txt");
  await mkdir(dir);
  const manifest = {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    apiVersion: 1,
    entry: "index.mjs",
    displayName: "Внешняя проверка",
  };
  await writeFile(join(dir, "chisel-extension.json"), JSON.stringify(manifest));
  await writeFile(
    join(dir, "index.mjs"),
    `import {appendFile} from 'node:fs/promises'; await appendFile(${JSON.stringify(sentinel)},'import\\n'); export default ({sdk,manifest})=>{ return {id:manifest.id,version:manifest.version,apiVersion:1,entry:manifest.entry,activate(ctx){${code}}}; };`,
  );
  await writeFile(join(dir, "asset.txt"), "bytes");
  return { root, dir, sentinel, manifest };
}
test("inspect/trust/status never import; all asset bytes are trusted and modified packages do not execute", async () => {
  const f = await fixture(),
    candidate = await inspectPackage(f.dir);
  await expect(access(f.sentinel)).rejects.toBeDefined();
  await expect(
    approvePackage(f.dir, candidate.manifest.id, "0".repeat(64), true),
  ).rejects.toThrow();
  await approvePackage(f.dir, candidate.manifest.id, candidate.digest, true);
  expect((await extensionRecords())[0]?.digest).toBe(candidate.digest);
  await expect(access(f.sentinel)).rejects.toBeDefined();
  await writeFile(join(f.dir, "asset.txt"), "changed");
  const loader = await ExternalExtensionLoader.create(() => {}),
    host = new ExtensionHost(loader.definitions([]));
  hosts.push(host);
  await host.open(f.root);
  expect(loader.metadata()[0]?.state).toBe("modified");
  await expect(access(f.sentinel)).rejects.toBeDefined();
  await expect(runtimeSnapshot(candidate)).rejects.toThrow("изменилось");
});
test("approved external module imports once, activates per canonical root; private SDK token does not resolve another token by string", async () => {
  const f = await fixture(
    `const a=sdk.createServiceToken('state'), b=sdk.createServiceToken('state'); ctx.services.provide(a,{root:ctx.workspaceRoot}); if(ctx.services.lookup(b)!==undefined)throw Error('shadow'); ctx.contextProviders.register({id:'cached',collect(){return {text:ctx.workspaceRoot}}});`,
  );
  const candidate = await inspectPackage(f.dir);
  await approvePackage(f.dir, candidate.manifest.id, candidate.digest, true);
  const loader = await ExternalExtensionLoader.create(() => {}),
    host = new ExtensionHost(loader.definitions([]));
  hosts.push(host);
  const [a, b] = await Promise.all([
    host.open(f.root),
    host.open(join(f.root, ".")),
  ]);
  expect(a).toBe(b);
  const other = join(f.root, "Другой проект");
  await mkdir(other);
  expect(await host.open(other)).not.toBe(a);
  expect(await readFile(f.sentinel, "utf8")).toBe("import\n");
  expect(loader.metadata().every((item) => item.state === "active")).toBe(true);
  await a.dispose();
  expect(loader.metadata()).toHaveLength(1);
  expect(loader.metadata()[0]?.workspaceRoot).toBe(other);
  expect(loader.metadata()[0]?.state).toBe("active");
});
test("partial optional activation rolls back own registrations/resources; required linked failure remains strict", async () => {
  const f = await fixture(
    `ctx.contextProviders.register({id:'bad',collect(){return {text:'must disappear'}}}); ctx.add({dispose(){throw Error('cleanup')}}); throw Error('activation');`,
  );
  const candidate = await inspectPackage(f.dir);
  await approvePackage(f.dir, candidate.manifest.id, candidate.digest, true);
  const required = [
    {
      id: "builtin.healthy",
      activate(
        ctx: import("../../src/extensions/contracts.js").ExtensionContext,
      ) {
        ctx.contextProviders.register({
          id: "ok",
          collect() {
            return { text: "healthy" };
          },
        });
      },
    },
  ];
  const loader = await ExternalExtensionLoader.create(() => {}),
    host = new ExtensionHost([...required, ...loader.definitions(required)]);
  hosts.push(host);
  const scope = await host.open(f.root);
  expect(loader.metadata()[0]?.state).toBe("cleanup_failed");
  const result = await scope.contextProviders.collect(
    {
      sessionId: crypto.randomUUID(),
      turnId: "turn",
      iteration: 0,
      attempt: 0,
      mode: "build",
      userPrompt: "test",
    },
    undefined,
    (text) => text,
  );
  expect(JSON.stringify(result)).toContain("healthy");
  expect(JSON.stringify(result)).not.toContain("must disappear");
  const strict = new ExtensionHost([
    {
      id: "required",
      activate() {
        throw Error("required");
      },
    },
  ]);
  hosts.push(strict);
  await expect(strict.open(f.root)).rejects.toThrow("activation failed");
});
test("external tool contexts are rebuilt and effects stay bound to the approved path; normal Plan/schema/stale/checkpoint checks apply", async () => {
  const f = await fixture(`
    let lastPlan;
    for(const effect of ['read','workspace_write'])ctx.tools.register(sdk.defineTool({
      name:effect==='read'?'read_it':'write_it',description:'Проверка SDK',effect,
      inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'},reuse:{type:'boolean'}},required:['path'],additionalProperties:false},
      async prepare(invocation,input){
        for(const key of ['session','editing','sandbox','events','checkpoint','worktrees','executionConstraint','networkAuthorization'])if(key in invocation)throw Error('broad prepare');
        if(!Object.isFrozen(invocation))throw Error('mutable invocation');
        if(input.reuse)return lastPlan;
        lastPlan=effect==='read'?await invocation.plan.readText(input.path):await invocation.plan.writeText(input.path,input.content);return lastPlan;
      },
      execute(invocation){for(const key of ['session','editing','sandbox','events','checkpoint','worktrees','networkAuthorization'])if(key in invocation)throw Error('broad execute');return invocation.effects.run({path:'foreign.txt',content:'forbidden'});}
    }));
    ctx.commands.register({name:'sdk-check',description:'Проверить invocation',parse:JSON.parse,async execute(invocation,input){
      if(input.foreign)return invocation.tools.execute('ext:foreign.plugin:write',{});
      if(input.write){await invocation.tools.execute('read_file',{path:input.path});return invocation.tools.execute('ext:'+manifest.id+':write_it',{path:input.path,content:input.content});}
      return invocation.tools.execute('ext:'+manifest.id+':read_it',input);
    }});
  `);
  await writeFile(join(f.root, "note.txt"), "original\n");
  const configPath = join(f.root, "global.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      profiles: {},
      lsp: { mode: "off", servers: {} },
      web: { enabled: false },
    }),
  );
  const candidate = await inspectPackage(f.dir);
  await approvePackage(f.dir, candidate.manifest.id, candidate.digest, true);
  const builtins = defaultExtensions([], { configPath }),
    loader = await ExternalExtensionLoader.create(() => {}),
    host = new ExtensionHost([...builtins, ...loader.definitions(builtins)]);
  hosts.push(host);
  const scope = await host.open(f.root);
  const command = scope.commands.get("sdk-check");
  const run = (
    input: unknown,
    mode: "build" | "plan" = "build",
    resolver: () => Promise<"approved"> = async () => "approved",
  ) =>
    runExtensionCommand(
      { command, input },
      scope,
      { cwd: f.root, configPath, mode, interactive: true },
      { requestApproval: resolver },
    );
  const read = await run({ path: "note.txt" });
  expect(read.result.output).toContain("original");
  expect((await run({ path: "note.txt", reuse: true })).result.isError).toBe(
    true,
  );
  expect(
    (await run({ path: "note.txt", extra: "invalid" })).result.errorCode,
  ).toBe("INVALID_TOOL_INPUT");
  expect((await run({ foreign: true })).result.errorCode).toBe(
    "PERMISSION_DENIED",
  );
  const written = await run({
    write: true,
    path: "note.txt",
    content: "approved\n",
  });
  expect(written.result.requiresApproval).not.toBe(true);
  expect(written.result.isError).not.toBe(true);
  expect(await readFile(join(f.root, "note.txt"), "utf8")).toBe("approved\n");
  expect(written.session.undoStack.at(-1)?.after).toBe("approved\n");
  await expect(access(join(f.root, "foreign.txt"))).rejects.toBeDefined();
  const plan = await run(
    { write: true, path: "note.txt", content: "plan forbidden" },
    "plan",
  );
  expect(plan.result.errorCode).toBe("MODE_RESTRICTION");
  const stale = await run(
    { write: true, path: "note.txt", content: "stale forbidden" },
    "build",
    async () => {
      await writeFile(join(f.root, "note.txt"), "changed during approval\n");
      return "approved";
    },
  );
  expect(stale.result.isError).toBe(true);
  expect(await readFile(join(f.root, "note.txt"), "utf8")).toBe(
    "changed during approval\n",
  );
});

test("late activation after its ten-second budget cannot register or replace healthy frames", async () => {
  const f = await fixture();
  const barrierKey = `p31_late_${crypto.randomUUID()}`;
  let finished!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finished = resolve;
  });
  (globalThis as unknown as Record<string, unknown>)[barrierKey] = finished;
  // Use a package-local event barrier; no timing sleep can manufacture a completed cleanup.
  const entry = `import {appendFile} from 'node:fs/promises'; export default ({manifest})=>({id:manifest.id,version:manifest.version,apiVersion:1,entry:manifest.entry,activate(ctx){return new Promise(resolve=>ctx.signal.addEventListener('abort',async()=>{let rejected=false;try{ctx.contextProviders.register({id:'late',collect(){return {text:'late forbidden'}}})}catch{rejected=true}await appendFile(${JSON.stringify(f.sentinel)},rejected?'late-rejected':'unsafe');globalThis[${JSON.stringify(barrierKey)}]();resolve();},{once:true}));}});`;
  await writeFile(join(f.dir, "index.mjs"), entry);
  const candidate = await inspectPackage(f.dir);
  await approvePackage(f.dir, candidate.manifest.id, candidate.digest, true);
  const healthy = [
    {
      id: "builtin.healthy",
      activate(
        ctx: import("../../src/extensions/contracts.js").ExtensionContext,
      ) {
        ctx.contextProviders.register({
          id: "healthy",
          collect() {
            return { text: "healthy" };
          },
        });
      },
    },
  ];
  const loader = await ExternalExtensionLoader.create(() => {}),
    host = new ExtensionHost([...healthy, ...loader.definitions(healthy)]);
  hosts.push(host);
  const scope = await host.open(f.root);
  expect(loader.metadata()[0]?.state).toBe("activation_failed");
  await barrier;
  delete (globalThis as unknown as Record<string, unknown>)[barrierKey];
  expect(await readFile(f.sentinel, "utf8")).toBe("late-rejected");
  const result = await scope.contextProviders.collect(
    {
      sessionId: crypto.randomUUID(),
      turnId: "turn",
      iteration: 0,
      attempt: 0,
      mode: "build",
      userPrompt: "test",
    },
    undefined,
    (text) => text,
  );
  expect(JSON.stringify(result)).toContain("healthy");
  expect(JSON.stringify(result)).not.toContain("late forbidden");
}, 15000);

test("four loader operations bound imports; closing a queued workspace never executes its top-level code", async () => {
  const f = await fixture();
  const gateKey = `p31_gate_${crypto.randomUUID()}`,
    seenKey = `p31_seen_${crypto.randomUUID()}`;
  let release!: () => void, four!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const ready = new Promise<void>((done) => {
    four = done;
  });
  const global = globalThis as unknown as Record<string, unknown>,
    seen = new Set<string>();
  global[gateKey] = gate;
  global[seenKey] = (id: string) => {
    seen.add(id);
    if (seen.size === 4) four();
  };
  const ids = Array.from({ length: 5 }, (_, i) => `fixture.queued-${i}`),
    workspaces: string[] = [];
  for (const [i, id] of ids.entries()) {
    const directory = join(await extensionsDirectory(), `package-${i}`),
      workspace = join(f.root, `workspace-${i}`);
    await mkdir(directory);
    await mkdir(workspace);
    workspaces.push(workspace);
    await writeFile(
      join(directory, "chisel-extension.json"),
      JSON.stringify({ ...f.manifest, id }),
    );
    await writeFile(
      join(directory, "index.mjs"),
      `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(join(f.root, `import-${i}.txt`))},'import'); globalThis[${JSON.stringify(seenKey)}](${JSON.stringify(id)}); export default async ({manifest})=>{await globalThis[${JSON.stringify(gateKey)}]; return {id:manifest.id,version:manifest.version,apiVersion:1,entry:manifest.entry,activate(){}};};`,
    );
    const candidate = await inspectPackage(directory);
    await approvePackage(directory, id, candidate.digest, true);
    await writeFile(
      join(workspace, ".chiselrc"),
      JSON.stringify({
        externalExtensions: {
          disabledIds: ids.filter((other) => other !== id),
        },
      }),
    );
  }
  const loader = await ExternalExtensionLoader.create(() => {}),
    host = new ExtensionHost(loader.definitions([]));
  hosts.push(host);
  const running = workspaces.slice(0, 4).map((root) => host.open(root));
  let queued: Promise<unknown> | undefined;
  try {
    await ready;
    expect(seen.size).toBe(4);
    queued = host.open(workspaces[4]!);
    queued.catch(() => {});
    const deadline = Date.now() + 3000;
    while (
      !loader
        .metadata()
        .some(
          (item) =>
            item.workspaceRoot === workspaces[4] &&
            item.id === ids[4] &&
            item.state === "loading",
        )
    ) {
      if (Date.now() > deadline)
        throw Error("Queued import did not reach admission");
      await new Promise<void>((done) => setImmediate(done));
    }
    await host.closeWorkspace(workspaces[4]!);
    release();
    await Promise.all(running);
    await queued.catch(() => {});
    await expect(access(join(f.root, "import-4.txt"))).rejects.toBeDefined();
    expect(seen.size).toBe(4);
  } finally {
    release();
    await Promise.allSettled(running);
    await queued?.catch(() => {});
    delete global[gateKey];
    delete global[seenKey];
  }
}, 15000);

test("canonical Home ancestor aliases work while package junction/symlink children remain forbidden", async () => {
  const f = await fixture();
  const data = process.env.XDG_DATA_HOME!,
    alias = join(f.root, "Home alias");
  await symlink(data, alias, process.platform === "win32" ? "junction" : "dir");
  for (const key of keys) process.env[key] = alias;
  const canonical = await extensionsDirectory();
  const relativeHome =
    process.platform === "win32" ? "ChiselCode" : "chiselcode";
  const candidate = await inspectPackage(
    join(alias, relativeHome, "extensions", "Пакет с пробелами"),
  );
  expect(candidate.location).toBe(join(canonical, "Пакет с пробелами"));
  const bad = join(canonical, "Package link");
  await symlink(f.dir, bad, process.platform === "win32" ? "junction" : "dir");
  await expect(inspectPackage(bad)).rejects.toThrow("Ссылки");
});

test("project narrowing, disabled and reserved identities reject before top-level code; paths/junctions cannot escape", async () => {
  const f = await fixture(),
    candidate = await inspectPackage(f.dir);
  await approvePackage(f.dir, candidate.manifest.id, candidate.digest, true);
  await writeFile(
    join(f.root, ".chiselrc"),
    JSON.stringify({ externalExtensions: { disabled: true } }),
  );
  const loader = await ExternalExtensionLoader.create(() => {}),
    host = new ExtensionHost(loader.definitions([]));
  hosts.push(host);
  await host.open(f.root);
  await expect(access(f.sentinel)).rejects.toBeDefined();
  await writeFile(
    join(f.dir, "chisel-extension.json"),
    JSON.stringify({ ...f.manifest, id: "builtin.invalid" }),
  );
  await expect(inspectPackage(f.dir)).rejects.toThrow();
  await writeFile(
    join(f.dir, "chisel-extension.json"),
    JSON.stringify(f.manifest),
  );
  const link = join(f.dir, "escape");
  await symlink(
    f.root,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(inspectPackage(f.dir)).rejects.toThrow("ссылку");
});
