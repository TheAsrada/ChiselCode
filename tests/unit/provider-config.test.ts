import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/load.js";
import { migrateConfig } from "../../src/config/migrate.js";
import { builtinDefinitions } from "../../src/providers/definitions/index.js";
import {
  resolveProfileModel,
  selectProfile,
} from "../../src/providers/profiles.js";
import { createBuiltinProviderRegistry } from "../../src/providers/runtime.js";

test("Bypass opt-in persists in user settings, defaults off and rejects invalid values without overwriting config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chisel-permission-config-"));
  const path = join(dir, "config.json");
  try {
    const original = await loadGlobalConfig(path);
    expect(original.permissions?.allowBypassPermissions ?? false).toBe(false);
    for (const allowed of [true, false]) {
      await saveGlobalConfig(
        { ...original, permissions: { allowBypassPermissions: allowed } },
        path,
      );
      expect(
        (await loadGlobalConfig(path)).permissions?.allowBypassPermissions,
      ).toBe(allowed);
    }
    const source = await readFile(path, "utf8");
    await expect(
      saveGlobalConfig(
        { ...original, permissions: { allowBypassPermissions: "true" } },
        path,
      ),
    ).rejects.toThrow("Invalid ChiselCode config");
    expect(await readFile(path, "utf8")).toBe(source);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const d of builtinDefinitions)
  test(`legacy config ${d.id} preserves refs, endpoint, unknown fields and is idempotent`, () => {
    const raw = {
      defaultProvider: d.id,
      defaultModel: "global-model",
      future: { v: 1 },
      providers: {
        [d.id]: {
          provider: d.id,
          apiKeyRef: "unchanged-ref",
          baseUrl: "https://gateway.example/v1",
          futureProfile: true,
        },
      },
    };
    const m = migrateConfig(raw);
    expect(m.profiles[`${d.id}-default`]).toMatchObject({
      providerId: d.id,
      apiKeyRef: "unchanged-ref",
      defaultModel: "global-model",
      futureProfile: true,
    });
    expect(m.future).toEqual({ v: 1 });
    expect(migrateConfig(m)).toEqual(m);
  });
test("global model moves only to default profile and preserves existing model", () => {
  const m = migrateConfig({
    defaultProvider: "anthropic",
    defaultModel: "global",
    providers: {
      anthropic: { defaultModel: "own" },
      openai: { apiKeyRef: "oa" },
    },
  });
  expect(m.profiles["anthropic-default"]?.defaultModel).toBe("own");
  expect(m.profiles["openai-default"]?.defaultModel).toBeUndefined();
  expect(
    resolveProfileModel(
      selectProfile(m, { provider: "openai" }).profile,
      createBuiltinProviderRegistry(),
    ),
  ).toBe("gpt-5");
});
test("two profiles remain independent; provider selection is ambiguous", () => {
  const c = migrateConfig({
    schemaVersion: 2,
    defaultProfileId: "work",
    profiles: {
      work: {
        providerId: "openai",
        apiKeyRef: "work",
        defaultModel: "work-model",
        baseUrl: "https://work.example",
      },
      personal: {
        providerId: "openai",
        apiKeyRef: "personal",
        defaultModel: "personal-model",
        baseUrl: "https://personal.example",
      },
      missing: { providerId: "vendor/removed" },
    },
  });
  expect(selectProfile(c).profileId).toBe("work");
  expect(selectProfile(c, { profile: "personal" }).profile.defaultModel).toBe(
    "personal-model",
  );
  expect(() => selectProfile(c, { provider: "openai" })).toThrow("--profile");
  expect(migrateConfig(c).profiles.missing?.providerId).toBe("vendor/removed");
});
test("lazy migration writes backup only on save, credentials bytes unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chisel-config-v2-"));
  try {
    const path = join(dir, "config.json");
    const source = JSON.stringify({
      defaultProvider: "openai",
      providers: { openai: { apiKeyRef: "original" } },
      future: 123,
    });
    await writeFile(path, source);
    await writeFile(join(dir, "credentials.enc"), "opaque-encrypted-data");
    const c = await loadGlobalConfig(path);
    expect(await readFile(path, "utf8")).toBe(source);
    expect(await readdir(dir)).not.toContain("config.v1.backup.json");
    await saveGlobalConfig({ ...c, ui: { sidebarMode: "show" } }, path);
    expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(2);
    expect(await readFile(join(dir, "config.v1.backup.json"), "utf8")).toBe(
      source,
    );
    expect(await readFile(join(dir, "credentials.enc"), "utf8")).toBe(
      "opaque-encrypted-data",
    );
    await saveGlobalConfig(await loadGlobalConfig(path), path);
    expect(await readFile(join(dir, "config.v1.backup.json"), "utf8")).toBe(
      source,
    );
    await writeFile(path, '{"schemaVersion":999}');
    await expect(loadGlobalConfig(path)).rejects.toThrow(path);
    await expect(saveGlobalConfig(c, path)).rejects.toThrow(path);
    expect(await readFile(path, "utf8")).toBe('{"schemaVersion":999}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
