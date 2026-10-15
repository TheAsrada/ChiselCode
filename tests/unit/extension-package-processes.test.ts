import { afterEach, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa, type ResultPromise } from "execa";
import {
  readExtensionRegistry,
  registryPath,
} from "../../src/extensions/external/registry.js";
import { readJournal } from "../../src/extensions/packages/journal.js";
import { PackageManagementService } from "../../src/extensions/packages/service.js";

const keys = ["XDG_DATA_HOME", "LOCALAPPDATA"] as const,
  saved = keys.map((key) => process.env[key]),
  roots: string[] = [],
  children: ResultPromise[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.catch(() => {});
  }
  keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key];
    else process.env[key] = saved[i];
  });
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-package-process-")),
  );
  roots.push(root);
  const data = join(root, "Home");
  for (const key of keys) process.env[key] = data;
  const source = async (version: string, id = "fixture.process") => {
    const path = join(root, id + version);
    await mkdir(path);
    await writeFile(
      join(path, "chisel-extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        version,
        apiVersion: 1,
        entry: "index.mjs",
        displayName: "Запущенная версия",
      }),
    );
    await writeFile(
      join(path, "index.mjs"),
      `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(join(root, "sentinel"))},${JSON.stringify(version + "\n")}); export default ({manifest})=>({...manifest,activate(){}});`,
    );
    return path;
  };
  const service = new PackageManagementService();
  const install = async (path: string) => {
    const candidate = await service.prepareInstall(path);
    return service.commitCandidate(candidate, {
      digest: candidate.preview.digest,
      acknowledgeProcessAccess: true,
      enabled: true,
    });
  };
  return { root, data, source, service, install };
}
async function worker(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: string,
  source = "",
  fault = "",
) {
  const child = execa(
    process.execPath,
    [
      resolve("tests/fixtures/extension-packages-worker.ts"),
      mode,
      f.root,
      source,
      fault,
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !["XDG_DATA_HOME", "LOCALAPPDATA"].includes(key.toUpperCase()),
          ),
        ),
        XDG_DATA_HOME: f.data,
        LOCALAPPDATA: f.data,
      },
      extendEnv: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
      timeout: 90000,
    },
  );
  children.push(child);
  let output = "";
  const ready = new Promise<Record<string, unknown>>((done, reject) => {
    child.stdout!.on("data", (bytes) => {
      output += String(bytes);
      if (output.includes("\n")) {
        try {
          done(JSON.parse(output.split("\n")[0]!));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.then((result) => {
      if (!output.includes("\n"))
        reject(
          new Error(result.stderr || "Worker exited without ready barrier"),
        );
    });
  });
  return { child, ready };
}
test("actual applications pin two immutable versions; graceful exit permits cleanup but a crash remains unknown", async () => {
  const f = await fixture(),
    a = await f.install(await f.source("1.0.0"));
  const first = await worker(f, "use"),
    ready = await first.ready;
  expect(ready.ready).toBe(true);
  expect(JSON.stringify(ready.diagnostics)).toContain('"state":"active"');
  const candidate = await f.service.prepareUpdate(
      "fixture.process",
      await f.source("2.0.0"),
    ),
    b = await f.service.commitCandidate(candidate, {
      digest: candidate.preview.digest,
      acknowledgeProcessAccess: true,
    });
  const second = await worker(f, "use");
  expect(JSON.stringify((await second.ready).diagnostics)).toContain(
    '"state":"active"',
  );
  expect(await readFile(join(f.root, "sentinel"), "utf8")).toBe(
    "1.0.0\n2.0.0\n",
  );
  const status = await f.service.status("fixture.process");
  expect(status.uses).toHaveLength(2);
  const removed = await f.service.remove(status.id, {
    digest: status.selected!.digest,
    revision: status.revision,
  });
  expect(removed.deferred).toBe(true);
  await access(a.location!);
  await access(b.location!);
  first.child.stdin!.end("exit\n");
  expect((await first.child).exitCode).toBe(0);
  await f.service.recover();
  await expect(access(a.location!)).rejects.toBeDefined();
  await access(b.location!);
  second.child.kill("SIGKILL");
  await second.child;
  await f.service.recover();
  await access(b.location!);
  expect((await f.service.status(status.id)).uses[0]?.confidence).toBe(
    "unknown",
  );
}, 30000);
for (const point of ["published", "registry_committed"] as const)
  test(`real SIGKILL at ${point} recovers without replay/trust and preserves the atomic commit boundary`, async () => {
    const f = await fixture(),
      source = await f.source("1.0.0"),
      running = await worker(f, "fault", source, point),
      ready = await running.ready;
    running.child.kill("SIGKILL");
    await running.child;
    // The worker has really exited. Age only its isolated lock, as after downtime;
    // exercise stale-lock recovery without waiting 30 real seconds per fault point.
    const old = new Date(Date.now() - 60000);
    await utimes(`${await registryPath()}.lock`, old, old);
    const recovered = await f.service.recover();
    const state = await readExtensionRegistry(),
      journal = await readJournal(String(ready.operationId));
    if (point === "published") {
      expect(state.records).toHaveLength(0);
      expect(journal.phase).toBe("aborted");
    } else {
      expect(state.records[0]?.enabled).toBe(true);
      expect(journal.phase).toBe("committed");
      expect(journal.result?.outcome).toBe("committed");
    }
    expect(recovered.some((row) => row.operationId === ready.operationId)).toBe(
      true,
    );
    await expect(readFile(join(f.root, "sentinel"))).rejects.toBeDefined();
  }, 65000);

test("two real writers preserve different IDs and reject replacement of the same installed ID", async () => {
  const f = await fixture(),
    left = await f.source("1.0.0", "fixture.left"),
    right = await f.source("1.0.0", "fixture.right");
  const pair = await Promise.all([
    worker(f, "install", left),
    worker(f, "install", right),
  ]);
  expect(
    (await Promise.all(pair.map((value) => value.ready))).every(
      (value) => value.outcome === "committed",
    ),
  ).toBe(true);
  await Promise.all(pair.map((value) => value.child));
  expect(
    (await f.service.list()).filter((value) => !value.removed),
  ).toHaveLength(2);
  const same = await f.source("1.0.0", "fixture.same"),
    collision = await Promise.all([
      worker(f, "install", same),
      worker(f, "install", same),
    ]);
  const outcomes = await Promise.all(collision.map((value) => value.ready));
  await Promise.all(collision.map((value) => value.child));
  expect(
    outcomes.filter((value) => value.outcome === "committed"),
  ).toHaveLength(1);
  expect(outcomes.filter((value) => value.outcome === "conflict")).toHaveLength(
    1,
  );
  expect(
    (await f.service.list()).filter((value) => value.id === "fixture.same"),
  ).toHaveLength(1);
}, 30000);
