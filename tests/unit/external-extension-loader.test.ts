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
    `import {appendFile} from 'node:fs/promises'; await appendFile(${JSON.stringify(sentinel)},'import\\n'); export default ({sdk,manifest})=>{ return {id:manifest.id,version:manifest.version,apiVersion:1,activate(ctx){${code}}}; };`,
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
