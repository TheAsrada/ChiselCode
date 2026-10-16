import { expect, test } from "bun:test";
import {
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
import { extensionRecords } from "../../src/extensions/external/registry.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { PackageManagementService } from "../../src/extensions/packages/service.js";
import { UiExtensionRuntime } from "../../src/extensions/ui-runtime.js";

test("live UI reload is isolated by extension/root, ordinary boot excludes UI, failed activation rolls back and disabling external code is honored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-ui-lifetimes-"));
  const envName =
      process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME",
    previous = process.env[envName];
  process.env[envName] = join(directory, "home");
  const firstRoot = join(directory, "one"),
    secondRoot = join(directory, "two"),
    marker = join(directory, "imports.txt");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const packages = new PackageManagementService(),
    runtime = new UiExtensionRuntime(),
    ordinary = new ExtensionHost();
  let boot: ExtensionHost | undefined;
  async function install(id: string, fail = false, failCleanup = false) {
    const source = join(directory, id);
    await mkdir(source);
    await writeFile(
      join(source, "chisel-extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        version: "1.0.0",
        apiVersion: 1,
        kind: "ui",
        entry: "index.mjs",
        displayName: id,
      }),
    );
    const code = `import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(marker)},${JSON.stringify(id + "\n")});export default({manifest})=>({id:manifest.id,version:manifest.version,entry:manifest.entry,apiVersion:1,activate(ctx){ctx.ui.register({id:'panel',slot:'render',surfaces:['AbovePrompt'],scope:'workspace',title:'Panel',source:{snapshot:()=>(${JSON.stringify({ revision: 1, state: "ready", render: { mode: "before", content: { type: "text", text: id } } })})}});${fail ? "ctx.services.provide({}, {});" : ""}${failCleanup ? "ctx.add({dispose(){throw Error('cleanup failed')}});" : ""}}});`;
    new Bun.Transpiler({ loader: "js" }).transformSync(code);
    await writeFile(join(source, "index.mjs"), code);
    const candidate = await packages.prepareInstall(source);
    await packages.commitCandidate(candidate, {
      digest: candidate.preview.digest,
      acknowledgeProcessAccess: true,
      enabled: true,
    });
  }
  try {
    await install("personal.first");
    await install("personal.second");
    await install("personal.invalid", true);
    boot = new ExtensionHost(
      (await ExternalExtensionLoader.create(() => {}, "standard")).definitions(
        [],
      ),
    );
    await boot.open(firstRoot);
    expect(await Bun.file(marker).exists()).toBe(false);
    const core = await ordinary.open(firstRoot);
    const first = await runtime.open(firstRoot),
      second = await runtime.open(secondRoot);
    const alias = join(directory, "alias");
    await symlink(
      firstRoot,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(await runtime.open(alias)).toEqual(first);
    expect(
      runtime.diagnostics(alias).find((item) => item.id === "personal.invalid")
        ?.state,
    ).toBe("activation_failed");
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    const find = (scopes: typeof first, id: string) =>
      scopes.find((scope) =>
        scope.externalDiagnostics().some((diagnostic) => diagnostic.id === id),
      )!;
    const firstA = find(first, "personal.first"),
      firstB = find(first, "personal.second"),
      secondA = find(second, "personal.first"),
      secondB = find(second, "personal.second");
    expect(find(first, "personal.invalid").ui.descriptors()).toHaveLength(0);
    expect(
      runtime
        .diagnostics(firstRoot)
        .find((diagnostic) => diagnostic.id === "personal.invalid")?.state,
    ).toBe("activation_failed");
    const record = (await packages.list()).find(
      (record) => record.id === "personal.first",
    )!;
    await packages.setEnabled(record.id, false, {
      digest: record.selected!.digest,
      revision: record.revision,
    });
    await runtime.changed(record.id);
    expect(firstA.signal.aborted).toBe(true);
    expect(secondA.signal.aborted).toBe(true);
    expect(firstB.signal.aborted).toBe(false);
    expect(core.signal.aborted).toBe(false);
    const live = await runtime.open(firstRoot);
    expect(find(live, "personal.second")).toBe(firstB);
    expect(live).toHaveLength(2);
    await runtime.closeWorkspace(alias);
    expect(firstB.signal.aborted).toBe(true);
    expect(secondB.signal.aborted).toBe(false);
    const denied = new UiExtensionRuntime(true);
    expect(await denied.open(firstRoot)).toEqual([]);
    expect(await denied.changed("personal.second")).toBe(false);
    await denied.dispose();
    const bootIdentity = new ExtensionHost(
      ["personal.first", "personal.second", "personal.invalid"].map((id) => ({
        id,
        activate() {},
      })),
    );
    const blocked = new UiExtensionRuntime(
      false,
      (id) => !bootIdentity.hasDefinition(id),
    );
    expect(await blocked.open(firstRoot)).toEqual([]);
    expect(await blocked.changed("personal.second")).toBe(false);
    await blocked.dispose();
    await bootIdentity.dispose();
    expect((await readFile(marker, "utf8")).trim().split("\n").sort()).toEqual([
      "personal.first",
      "personal.invalid",
      "personal.second",
    ]);
    expect(
      (await extensionRecords()).find(
        (record) => record.id === "personal.first",
      )?.enabled,
    ).toBe(false);
    await install("personal.cleanup", false, true);
    await runtime.changed("personal.cleanup");
    const cleanup = (await packages.list()).find(
      (item) => item.id === "personal.cleanup",
    )!;
    await packages.setEnabled(cleanup.id, false, {
      digest: cleanup.selected!.digest,
      revision: cleanup.revision,
    });
    await expect(runtime.changed(cleanup.id)).rejects.toThrow();
    expect(runtime.canApply(cleanup.id)).toBe(false);
    expect(
      runtime.diagnostics().find((item) => item.id === cleanup.id)?.state,
    ).toBe("cleanup_failed");
    expect(secondB.signal.aborted).toBe(false);
  } finally {
    await runtime.dispose();
    await boot?.dispose();
    await ordinary.dispose();
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
