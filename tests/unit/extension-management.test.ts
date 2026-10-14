import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import { DesktopServer } from "../../src/desktop/server.js";
import { ExternalExtensionLoader } from "../../src/extensions/external/loader.js";
import { ExtensionManifestSchema } from "../../src/extensions/external/manifest.js";
import { readExtensionRegistry } from "../../src/extensions/external/registry.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ExtensionManagementService } from "../../src/extensions/management.js";
import { ExtensionSettingsStore } from "../../src/extensions/settings-store.js";
import { SecretRedactor } from "../../src/security/redaction.js";

const keys = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "LOCALAPPDATA",
  "APPDATA",
  "CHISEL_DEMO_IMPORTS",
] as const;
const saved = keys.map((k) => process.env[k]),
  cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key];
    else process.env[key] = saved[i];
  });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-settings-")),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  for (const key of keys.slice(0, 4)) process.env[key] = join(root, "home");
  process.env.CHISEL_DEMO_IMPORTS = join(root, "imports.txt");
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "README.md"), "Настоящий проект\n");
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      profiles: {},
      lsp: { mode: "off", servers: {} },
    }),
  );
  const make = async (version: string, patch: Record<string, unknown> = {}) => {
    const source = join(root, `source-${version}-${randomUUID()}`);
    await cp(resolve("tests/fixtures/extensions/settings-demo"), source, {
      recursive: true,
    });
    const manifest = {
      ...JSON.parse(
        await readFile(join(source, "chisel-extension.json"), "utf8"),
      ),
      version,
      ...patch,
    };
    await writeFile(
      join(source, "chisel-extension.json"),
      JSON.stringify(manifest),
    );
    const zip = source + ".zip";
    await writeFile(
      zip,
      zipSync({
        "chisel-extension.json": Buffer.from(JSON.stringify(manifest)),
        "index.mjs": await readFile(join(source, "index.mjs")),
      }),
    );
    return { source, zip, manifest };
  };
  let host: ExtensionHost | undefined;
  const service = new ExtensionManagementService({
    configPath,
    diagnostics: () =>
      host?.readyScopes().flatMap((s) => s.externalDiagnostics()) ?? [],
    scopeReady: () => !!host?.readyScopes().length,
  });
  cleanup.push(() => service.dispose());
  const start = async () => {
    host = new ExtensionHost(
      (await ExternalExtensionLoader.create(() => {})).definitions([]),
    );
    cleanup.push(() => host?.dispose() ?? Promise.resolve());
    await host.open(project);
  };
  const prepare = (
    input: Omit<Parameters<typeof service.prepare>[0], "requestId">,
  ) => service.prepare({ ...input, requestId: randomUUID() });
  const item = async () =>
    (await service.list(project)).items.find(
      (i) => i.id === "example.settings-demo",
    )!;
  return { root, project, configPath, service, make, prepare, item, start };
}
test("one real package: passive folder/ZIP review, exact trust, settings, loaded/desired, update/rollback, disable and deferred removal", async () => {
  const f = await fixture(),
    v1 = await f.make("1.0.0");
  const review = await f.prepare({ kind: "install", source: v1.source });
  expect(review.contents.map((file) => file.path)).toContain("index.mjs");
  expect(await Bun.file(process.env.CHISEL_DEMO_IMPORTS!).exists()).toBe(false);
  await expect(
    f.service.commit({
      ...review,
      requestId: review.requestId,
      digest: "a".repeat(64),
      trust: true,
    }),
  ).rejects.toThrow("digest/revision");
  await f.service.cancel(review.requestId);
  await expect(f.service.commit({ ...review, trust: true })).rejects.toThrow(
    "Review закрыт",
  );
  const unsigned = await f.prepare({ kind: "install", source: v1.zip });
  await f.service.commit({ ...unsigned, trust: false, enable: false });
  expect((await f.item()).state).toBe("not_trusted");
  expect(await Bun.file(process.env.CHISEL_DEMO_IMPORTS!).exists()).toBe(false);
  const trust = await f.prepare({ kind: "trust", id: unsigned.id });
  await expect(f.service.commit({ ...trust, trust: false })).rejects.toThrow(
    "доверие",
  );
  const confirmations = await Promise.all([
    f.service.commit({ ...trust, trust: true, enable: true }),
    f.service.commit({ ...trust, trust: true, enable: true }),
  ]);
  expect(confirmations[0]).toEqual(confirmations[1]);
  await f.start();
  expect((await f.item()).state).toBe("working");
  expect(await readFile(process.env.CHISEL_DEMO_IMPORTS!, "utf8")).toBe(
    "import\n",
  );
  let item = await f.item(),
    settings = await f.service.settings({
      id: item.id,
      digest: item.digest!,
      revision: item.revision,
    });
  settings = await f.service.settings(
    { id: item.id, digest: item.digest!, revision: item.revision },
    {
      id: item.id,
      digest: item.digest!,
      revision: item.revision,
      settingsRevision: settings.revision,
      values: { ...settings.values, message: "Изменено" },
      secrets: { access: "fixture-private-setting-7294" },
    },
  );
  expect(settings.secretSet.access).toBe(true);
  expect(JSON.stringify(settings)).not.toContain(
    "fixture-private-setting-7294",
  );
  expect(settings.values.message).toBe("Изменено");
  expect(new SecretRedactor().text("fixture-private-setting-7294")).toBe(
    "[секрет скрыт]",
  );
  expect((await f.item()).state).toBe("restart_required");
  await expect(
    f.service.settings(
      { id: item.id, digest: item.digest!, revision: item.revision },
      {
        id: item.id,
        digest: item.digest!,
        revision: item.revision,
        settingsRevision: 0,
        values: {},
      },
    ),
  ).rejects.toThrow("Настройки изменились");
  await expect(
    f.service.settings(
      { id: item.id, digest: item.digest!, revision: item.revision },
      {
        id: item.id,
        digest: item.digest!,
        revision: item.revision,
        settingsRevision: settings.revision,
        values: { count: 99 },
      },
    ),
  ).rejects.toThrow("Недопустимое");
  const v2 = await f.make("1.1.0"),
    update = await f.prepare({ kind: "update", id: item.id, source: v2.zip });
  await expect(f.service.commit({ ...update, trust: false })).rejects.toThrow(
    "доверие",
  );
  expect((await f.item()).version).toBe("1.0.0");
  await f.service.commit({ ...update, trust: true });
  expect((await f.item()).version).toBe("1.1.0");
  expect((await f.item()).state).toBe("restart_required");
  expect(
    (await f.item()).versions.find((v) => v.version === "1.0.0")?.inUse,
  ).toBe(true);
  const rollback = await f.prepare({
    kind: "rollback",
    id: item.id,
    versionKey: unsigned.digest,
  });
  await f.service.commit({ ...rollback, trust: false });
  expect((await f.item()).version).toBe("1.0.0");
  item = await f.item();
  await f.service.setEnabled({
    id: item.id,
    digest: item.digest!,
    revision: item.revision,
    enabled: false,
    path: f.project,
  });
  expect((await f.item()).actualState).toBe("active");
  expect((await f.item()).state).toBe("restart_required");
  const remove = await f.prepare({ kind: "remove", id: item.id });
  expect((await f.service.commit({ ...remove, trust: false })).deferred).toBe(
    true,
  );
  expect((await f.item()).deferredRemoval).toBe(true);
  expect(await readFile(join(f.project, "README.md"), "utf8")).toBe(
    "Настоящий проект\n",
  );
  expect(
    (
      await new ExtensionSettingsStore(
        ExtensionManifestSchema.parse(v1.manifest),
      ).read()
    ).values.message,
  ).toBe("Изменено");
});
test("stale review, corrupted/changed/incompatible package and project restriction preserve the selected version", async () => {
  const f = await fixture(),
    source = await f.make("1.0.0"),
    installed = await f.prepare({ kind: "install", source: source.source });
  await f.service.commit({ ...installed, trust: true, enable: true });
  const next = await f.make("1.1.0"),
    review = await f.prepare({
      kind: "update",
      id: installed.id,
      source: next.zip,
    });
  let item = await f.item();
  await f.service.setEnabled({
    id: item.id,
    digest: item.digest!,
    revision: item.revision,
    enabled: false,
  });
  await expect(f.service.commit({ ...review, trust: true })).rejects.toThrow(
    "изменился",
  );
  expect((await f.item()).version).toBe("1.0.0");
  const wrong = await f.make("2.0.0", { chiselVersion: ">=9.0.0" }),
    incompatible = await f.prepare({
      kind: "update",
      id: installed.id,
      source: wrong.zip,
    });
  expect(incompatible.incompatible).toBeTruthy();
  await expect(
    f.service.commit({ ...incompatible, trust: true }),
  ).rejects.toThrow("не подходит");
  await f.service.cancel(incompatible.requestId);
  await writeFile(join(f.root, "broken.zip"), "broken");
  await expect(
    f.prepare({
      kind: "update",
      id: installed.id,
      source: join(f.root, "broken.zip"),
    }),
  ).rejects.toThrow();
  item = await f.item();
  await f.service.setEnabled({
    id: item.id,
    digest: item.digest!,
    revision: item.revision,
    enabled: true,
  });
  await writeFile(
    join(f.project, ".chiselrc"),
    JSON.stringify({ externalExtensions: { disabledIds: [installed.id] } }),
  );
  expect((await f.item()).projectBlocked).toBe(true);
  await f.start();
  expect((await f.item()).state).toBe("disabled");
  expect(await Bun.file(process.env.CHISEL_DEMO_IMPORTS!).exists()).toBe(false);
  const selected = (await readExtensionRegistry()).records[0]!.versions[0]!;
  await writeFile(join(selected.location, "index.mjs"), "changed");
  expect((await f.item()).state).toBe("error");
  await expect(f.prepare({ kind: "trust", id: installed.id })).rejects.toThrow(
    "изменена",
  );
});
test("settings preserve unknown keys across schemas, reset known values and isolate secrets; failed activation is actual error", async () => {
  const f = await fixture(),
    initial = await f.make("1.0.0"),
    manifest = ExtensionManifestSchema.parse(initial.manifest),
    store = new ExtensionSettingsStore(manifest);
  await store.save({ revision: 0, values: { message: "Сохранить", count: 3 } });
  const changed = {
    ...manifest,
    settings: {
      fields: manifest.settings!.fields.filter(
        (field) => field.name !== "message",
      ),
    },
  };
  const later = new ExtensionSettingsStore(changed);
  expect((await later.read()).unknownKeys).toEqual(["message"]);
  await later.save({ revision: 1, values: {}, reset: true });
  expect((await store.read()).values.message).toBe("Сохранить");
  const failure = await f.make("1.2.0");
  await writeFile(
    join(failure.source, "index.mjs"),
    "export default ({manifest})=>({...manifest, activate(){throw Error('Activation failure')}})",
  );
  const review = await f.prepare({ kind: "install", source: failure.source });
  await f.service.commit({ ...review, trust: true, enable: true });
  await f.start();
  expect((await f.item()).state).toBe("error");
  expect((await f.item()).actualState).toBe("activation_failed");
});
test("desktop public adapter is passive and rejects unvalidated DTOs; builtin forms use core validation and project ceilings", async () => {
  const f = await fixture(),
    server = new DesktopServer(() => {}, f.configPath);
  cleanup.push(() => server.dispose());
  const hello = (await server.dispatch("initialize", {
    protocolMajor: 1,
    clientVersion: "test",
  })) as { capabilities: string[] };
  expect(hello.capabilities).toContain("extension-management");
  const source = await f.make("1.0.0"),
    requestId = randomUUID(),
    input = { requestId, kind: "install", source: source.zip };
  const reviews = await Promise.all([
    server.dispatch("extensions/prepare", input),
    server.dispatch("extensions/prepare", input),
  ]);
  expect(reviews[0]).toEqual(reviews[1]);
  expect(await Bun.file(process.env.CHISEL_DEMO_IMPORTS!).exists()).toBe(false);
  await expect(
    server.dispatch("extensions/commit", {
      requestId,
      digest: "wrong",
      revision: 0,
      trust: true,
    }),
  ).rejects.toThrow("digest");
  await server.dispatch("extensions/cancel", { requestId });
  const state = await f.service.builtinRead("builtin.subagents", f.project);
  await expect(
    f.service.builtinSave({
      id: state.id,
      path: f.project,
      scope: "global",
      revision: state.globalRevision,
      value: { enabled: true, maxActive: 99 },
    }),
  ).rejects.toThrow();
  const global = await f.service.builtinSave({
    id: state.id,
    path: f.project,
    scope: "global",
    revision: state.globalRevision,
    value: { enabled: false },
  });
  const project = await f.service.builtinSave({
    id: state.id,
    path: f.project,
    scope: "project",
    revision: global.projectRevision,
    value: { enabled: true },
  });
  expect(project.effective).toMatchObject({ enabled: false });
  expect(
    (await f.service.list(f.project)).items.find(
      (i) => i.id === "builtin.subagents",
    )?.state,
  ).toBe("disabled");
});
