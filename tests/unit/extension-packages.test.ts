import { afterEach, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { ExternalExtensionLoader } from "../../src/extensions/external/loader.js";
import {
  extensionsDirectory,
  inspectPackage,
} from "../../src/extensions/external/package.js";
import {
  readExtensionRegistry,
  registryPath,
} from "../../src/extensions/external/registry.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { readJournal } from "../../src/extensions/packages/journal.js";
import {
  type PackageFaultPoint,
  PackageManagementService,
} from "../../src/extensions/packages/service.js";
import { versionUses } from "../../src/extensions/packages/use.js";

const keys = ["XDG_DATA_HOME", "LOCALAPPDATA"] as const,
  saved = keys.map((key) => process.env[key]);
const roots: string[] = [],
  hosts: ExtensionHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose().catch(() => {});
  keys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key];
    else process.env[key] = saved[index];
  });
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chisel-package-")));
  roots.push(root);
  for (const key of keys) process.env[key] = join(root, "Данные пользователя");
  const sentinel = join(root, "imports.txt");
  const source = async (version: string, id = "author.package") => {
    const path = join(root, `${id}-${version}`);
    await mkdir(path);
    const entries = {
      "chisel-extension.json": Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id,
          version,
          apiVersion: 1,
          entry: "index.mjs",
          displayName: "Пакет пользователя",
        }),
      ),
      "index.mjs": Buffer.from(
        `import {appendFile} from 'node:fs/promises';await appendFile(${JSON.stringify(sentinel)},${JSON.stringify(version + "\n")});export default ({manifest})=>({...manifest,activate(ctx){ctx.contextProviders.register({id:'version',collect(){return {text:${JSON.stringify(version)}}}})}});`,
      ),
      "assets/пример.txt": Buffer.from("Самостоятельные bytes " + version),
    };
    for (const [name, bytes] of Object.entries(entries)) {
      await mkdir(join(path, name, ".."), { recursive: true });
      await writeFile(join(path, name), bytes);
    }
    const zip = path + ".zip";
    await writeFile(zip, zipSync(entries, { level: 6 }));
    return { path, zip };
  };
  return { root, sentinel, source, service: new PackageManagementService() };
}
async function install(
  f: Awaited<ReturnType<typeof fixture>>,
  path: string,
  trusted = true,
) {
  const candidate = await f.service.prepareInstall(path);
  const result = await f.service.commitCandidate(
    candidate,
    trusted
      ? {
          digest: candidate.preview.digest,
          acknowledgeProcessAccess: true,
          enabled: true,
        }
      : {},
  );
  return { candidate, result };
}
test("folder/ZIP install captures independent immutable bytes; untrusted remains disabled and no code executes", async () => {
  const f = await fixture(),
    source = await f.source("1.0.0"),
    inspected = await f.service.inspectSource(source.zip);
  const { candidate, result } = await install(f, source.path, false);
  expect(result.trusted).toBe(false);
  expect(result.enabled).toBe(false);
  expect(candidate.preview.digest).toBe(inspected.digest);
  await rm(source.path, { recursive: true });
  await rm(source.zip);
  expect((await inspectPackage(result.location!)).digest).toBe(
    candidate.preview.digest,
  );
  expect((await f.service.status("author.package")).state).toBe("not_trusted");
  await expect(access(f.sentinel)).rejects.toBeDefined();
  const loader = await ExternalExtensionLoader.create(() => {}),
    host = new ExtensionHost(loader.definitions([]));
  hosts.push(host);
  await host.open(f.root);
  await expect(access(f.sentinel)).rejects.toBeDefined();
  expect(await f.service.commitCandidate(candidate)).toEqual(result);
  await expect(
    f.service.commitCandidate({ preview: candidate.preview }),
  ).rejects.toThrow("Preview");
  await expect(
    f.service.setEnabled("author.package", true, {
      digest: result.digest!,
      revision: (await f.service.status("author.package")).revision,
    }),
  ).rejects.toThrow("trust");
});
test("exact update/rollback and CAS preserve working selection; new startup loads only approved version", async () => {
  const f = await fixture(),
    v1 = await f.source("1.0.0"),
    a = await install(f, v1.zip);
  const loader = await ExternalExtensionLoader.create(() => {}),
    host = new ExtensionHost(loader.definitions([]));
  hosts.push(host);
  await host.open(f.root);
  expect(await readFile(f.sentinel, "utf8")).toBe("1.0.0\n");
  const v2 = await f.source("2.0.0"),
    update = await f.service.prepareUpdate("author.package", v2.path),
    competing = await f.service.prepareUpdate("author.package", v2.zip);
  await expect(f.service.commitCandidate(update)).rejects.toThrow("доверия");
  expect((await f.service.status("author.package")).selected?.digest).toBe(
    a.result.digest,
  );
  const b = await f.service.commitCandidate(update, {
    digest: update.preview.digest,
    acknowledgeProcessAccess: true,
  });
  await expect(
    f.service.commitCandidate(competing, {
      digest: competing.preview.digest,
      acknowledgeProcessAccess: true,
    }),
  ).rejects.toThrow("изменился");
  await f.service.abortCandidate(competing);
  expect(await readFile(f.sentinel, "utf8")).toBe("1.0.0\n");
  const loader2 = await ExternalExtensionLoader.create(() => {}),
    host2 = new ExtensionHost(loader2.definitions([]));
  hosts.push(host2);
  await host2.open(f.root);
  expect(await readFile(f.sentinel, "utf8")).toBe("1.0.0\n2.0.0\n");
  const current = await f.service.status("author.package");
  const back = await f.service.rollback(current.id, a.result.digest!, {
    digest: b.digest!,
    revision: current.revision,
  });
  expect(back.digest).toBe(a.result.digest);
  expect(back.enabled).toBe(true);
  const rows = await versionUses("author.package");
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.confidence === "live")).toBe(true);
  const removed = await f.service.remove(current.id, {
    digest: back.digest!,
    revision: (await f.service.status(current.id)).revision,
  });
  expect(removed.deferred).toBe(true);
  await access(a.result.location!);
  await access(b.location!);
  expect((await f.service.status(current.id)).state).toBe("removed");
  await host.dispose();
  expect(
    (await versionUses(current.id)).some(
      (row) => row.phase === "shutdown_pending_exit",
    ),
  ).toBe(true);
  await access(a.result.location!); // Imported module cache remains in this live process.
});
test("a failure after registry commit reports committed cleanup and passive recovery preserves selection", async () => {
  const f = await fixture(),
    v1 = await f.source("1.0.0");
  const service = new PackageManagementService({
    fault: async (point) => {
      if (point === "registry_committed") throw new Error("fault");
    },
  });
  const candidate = await service.prepareInstall(v1.path),
    result = await service.commitCandidate(candidate);
  expect(result.outcome).toBe("committed");
  expect(result.deferred).toBe(true);
  expect((await service.status(result.id)).selected?.digest).toBe(
    result.digest,
  );
  expect((await readJournal(result.operationId)).phase).toBe("committed");
  await service.recover();
  expect((await readJournal(result.operationId)).reservedBytes).toBe(0);
  expect((await readExtensionRegistry()).records[0]?.selected).toBe(
    result.digest,
  );
  await expect(access(f.sentinel)).rejects.toBeDefined();
});
test("schema1 manual receipts migrate without granting new trust or deleting source", async () => {
  const f = await fixture(),
    original = await f.source("1.0.0"),
    manual = join(await extensionsDirectory(), "manual");
  const { cp } = await import("node:fs/promises");
  await cp(original.path, manual, { recursive: true });
  const candidate = await inspectPackage(manual),
    receipt = {
      id: candidate.manifest.id,
      version: "1.0.0",
      apiVersion: 1,
      entry: "index.mjs",
      location: candidate.location,
      digest: candidate.digest,
      enabled: true,
      approvedAt: new Date().toISOString(),
    };
  await writeFile(
    await registryPath(),
    JSON.stringify({ schemaVersion: 1, revision: 7, records: [receipt] }),
  );
  const before = await f.service.status(receipt.id);
  expect(before.selected?.kind).toBe("legacy");
  expect(before.trusted).toBe(true);
  await f.service.setEnabled(receipt.id, false, {
    digest: receipt.digest,
    revision: before.revision,
  });
  expect(
    JSON.parse(await readFile(await registryPath(), "utf8")).schemaVersion,
  ).toBe(2);
  expect((await f.service.status(receipt.id)).selected?.approvedAt).toBe(
    receipt.approvedAt,
  );
  await f.service.remove(receipt.id, {
    digest: receipt.digest,
    revision: (await f.service.status(receipt.id)).revision,
  });
  await access(manual);
  await writeFile(
    await registryPath(),
    JSON.stringify({ schemaVersion: 99, records: [] }),
  );
  await expect(f.service.list()).rejects.toThrow();
  expect(
    JSON.parse(await readFile(await registryPath(), "utf8")).schemaVersion,
  ).toBe(99);
});

test("captured candidate does not reread a changed/deleted source and cancellation before commit preserves prior", async () => {
  const f = await fixture(),
    source = await f.source("1.0.0"),
    candidate = await f.service.prepareInstall(source.path);
  await rm(source.path, { recursive: true });
  const accepted = await f.service.commitCandidate(candidate);
  const next = await f.source("2.0.0"),
    update = await f.service.prepareUpdate(accepted.id, next.path),
    cancel = new AbortController();
  cancel.abort();
  await expect(
    f.service.commitCandidate(update, {
      digest: update.preview.digest,
      acknowledgeProcessAccess: true,
      signal: cancel.signal,
    }),
  ).rejects.toThrow();
  expect((await f.service.status(accepted.id)).selected?.digest).toBe(
    accepted.digest,
  );
  await f.service.abortCandidate(update);
});

test("atomic staging reservations refuse overflow without evicting selected/unknown bytes", async () => {
  const f = await fixture(),
    working = await install(f, (await f.source("1.0.0")).path, false);
  const held = [];
  try {
    for (let i = 0; i < 7; i++)
      held.push(
        await f.service.prepareInstall(
          (await f.source("1.0.0", `fixture.pending-${i}`)).path,
        ),
      );
    await expect(
      f.service.prepareInstall(
        (await f.source("1.0.0", "fixture.overflow")).path,
      ),
    ).rejects.toThrow("1 GiB");
    expect((await f.service.status(working.result.id)).selected?.digest).toBe(
      working.result.digest,
    );
    await access(working.result.location!);
  } finally {
    for (const candidate of held) await f.service.abortCandidate(candidate);
  }
});

test("failed optional resource cleanup keeps a recovery use after host disposal", async () => {
  const f = await fixture(),
    source = await f.source("1.0.0");
  await writeFile(
    join(source.path, "index.mjs"),
    "export default ({manifest})=>({...manifest,activate(ctx){ctx.add({dispose(){throw Error('failed cleanup')}});throw Error('activate')}});",
  );
  const installed = await install(f, source.path),
    loader = await ExternalExtensionLoader.create(() => {}),
    host = new ExtensionHost(loader.definitions([]));
  hosts.push(host);
  await host.open(f.root);
  expect(loader.metadata()[0]?.state).toBe("cleanup_failed");
  await host.dispose();
  expect((await versionUses(installed.result.id))[0]?.phase).toBe("recovery");
  const status = await f.service.status(installed.result.id);
  expect(
    (
      await f.service.remove(status.id, {
        digest: status.selected!.digest,
        revision: status.revision,
      })
    ).deferred,
  ).toBe(true);
  await access(installed.result.location!);
});
for (const point of [
  "reserved",
  "captured",
  "ready",
  "publishing",
  "published",
  "committed",
  "cleanup",
] satisfies PackageFaultPoint[])
  test(`fault at ${point} keeps trust/selection atomic and recovery releases owned staging`, async () => {
    const f = await fixture(),
      source = await f.source("1.0.0");
    let operationId = "";
    const service = new PackageManagementService({
      fault: async (current, id) => {
        if (current === point) {
          operationId = id;
          throw new Error("controlled fault");
        }
      },
    });
    let committed = false;
    try {
      const candidate = await service.prepareInstall(source.path);
      const result = await service.commitCandidate(candidate);
      committed = result.outcome === "committed";
    } catch {
      expect(["committed", "cleanup"].includes(point)).toBe(false);
    }
    const state = await readExtensionRegistry();
    expect(state.records.length).toBe(committed ? 1 : 0);
    await service.recover();
    const journal = await readJournal(operationId);
    expect(journal.phase).toBe(committed ? "committed" : "aborted");
    expect(journal.reservedBytes).toBe(0);
    if (!committed && journal.candidate)
      await expect(access(journal.candidate.location)).rejects.toBeDefined();
    await expect(access(f.sentinel)).rejects.toBeDefined();
  });
