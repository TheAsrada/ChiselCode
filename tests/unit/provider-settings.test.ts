import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/load.js";
import { createProviderCatalog } from "../../src/providers/catalog.js";
import { createBuiltinProviderRegistry } from "../../src/providers/runtime.js";
import { CredentialStore } from "../../src/security/credentials.js";
import {
  connectProviderAccount,
  removeProviderProfile,
  saveProviderSettings,
  selectorWindow,
  settingsDraft,
} from "../../src/ui/provider-settings.js";

test("custom provider appears in settings and profile creation; independent credentials/models/endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-settings-profiles-"));
  try {
    await mkdir(join(root, "custom"));
    await writeFile(
      join(root, "custom", "provider.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "example/gateway",
        label: "Gateway",
        driver: "openai-chat",
        auth: { required: true, envVars: [] },
        endpoint: {
          required: false,
          defaultBaseUrl: "https://gateway.example/v1",
          normalization: "openai-v1",
        },
        defaults: { model: "coder" },
        capabilities: {
          modelListing: true,
          tokenCounting: "unsupported",
          usageReporting: "stream",
          toolCalling: true,
          thinking: false,
        },
      }),
    );
    const { registry } = await createProviderCatalog({ root });
    const configPath = join(root, "config.json");
    const keys = new Map<string, string>();
    const credentials = {
      async get(id: string) {
        return keys.get(id);
      },
      async set(id: string, key: string) {
        keys.set(id, key);
      },
    };
    expect(
      settingsDraft(await loadGlobalConfig(configPath), registry, {
        provider: "example/gateway",
        profile: "corp-work",
      }),
    ).toMatchObject({
      provider: "example/gateway",
      profileId: "corp-work",
      model: "coder",
    });
    for (const profileId of ["corp-work", "corp-personal"])
      expect(
        await saveProviderSettings(
          {
            provider: "example/gateway",
            profileId,
            model: profileId,
            baseUrl: `https://${profileId}.example`,
            apiKey: profileId,
          },
          registry,
          { configPath, credentials },
        ),
      ).toBe("saved");
    const c = await loadGlobalConfig(configPath);
    expect(c.profiles["corp-work"]).toMatchObject({
      apiKeyRef: "corp-work",
      defaultModel: "corp-work",
      baseUrl: "https://corp-work.example/v1",
    });
    expect(c.profiles["corp-personal"]?.apiKeyRef).toBe("corp-personal");
    expect(keys.get("corp-work")).toBe("corp-work");
    expect(c.defaultProfileId).toBe("corp-personal");
    expect(
      settingsDraft(c, registry, { provider: "example/gateway" }).profileId,
    ).toBeUndefined();
    expect(settingsDraft(c, registry, { profile: "corp-work" }).model).toBe(
      "corp-work",
    );
    await expect(
      saveProviderSettings(
        { provider: "openai", profileId: "corp-work", model: "gpt-5" },
        registry,
        { configPath, credentials },
      ),
    ).rejects.toThrow("belongs to another provider");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("setup model defaults use selected definition and window limits scale", () => {
  const registry = createBuiltinProviderRegistry();
  const config = {
    defaultProfileId: "anthropic-default",
    profiles: {
      "anthropic-default": {
        providerId: "anthropic",
        defaultModel: "claude-opus-5",
      },
    },
  };
  expect(settingsDraft(config, registry, { provider: "openai" }).model).toBe(
    "gpt-5",
  );
  expect(
    selectorWindow(
      Array.from({ length: 500 }, (_, i) => i),
      499,
      15,
    ),
  ).toHaveLength(8);
  expect(
    selectorWindow(
      Array.from({ length: 500 }, (_, i) => i),
      499,
      15,
    ),
  ).toContain(499);
});

test("profile removal rejects stale confirmation, preserves shared credentials and repairs the default", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-profile-removal-"));
  const configPath = join(root, "config.json");
  const credentials = new CredentialStore(root);
  const registry = createBuiltinProviderRegistry();
  const personal = {
    providerId: "openai",
    apiKeyRef: "shared",
    defaultModel: "gpt-5",
    label: "Личный",
  };
  const work = { ...personal, label: "Рабочий" };
  try {
    await credentials.set("shared", "fixture-secret");
    await saveGlobalConfig(
      {
        schemaVersion: 2,
        defaultProfileId: "personal",
        profiles: { personal, work },
        ui: {
          lastModelSelection: {
            provider: "openai",
            profileId: "personal",
            model: "gpt-5",
          },
        },
      },
      configPath,
    );
    await expect(
      removeProviderProfile("personal", registry, {
        configPath,
        credentials,
        expected: { ...personal, label: "старое название" },
      }),
    ).rejects.toThrow("изменился");
    expect(
      (await loadGlobalConfig(configPath)).profiles.personal,
    ).toBeDefined();
    await removeProviderProfile("personal", registry, {
      configPath,
      credentials,
      expected: personal,
    });
    const config = await loadGlobalConfig(configPath);
    expect(config.defaultProfileId).toBe("work");
    expect(config.ui?.lastModelSelection).toBeUndefined();
    expect(await credentials.get("shared")).toBe("fixture-secret");
    await removeProviderProfile("work", registry, {
      configPath,
      credentials,
      expected: work,
    });
    expect(await credentials.get("shared")).toBeUndefined();
    expect(
      (await loadGlobalConfig(configPath)).defaultProfileId,
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connection settings validate profile ownership and cancellation before invoking a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-connect-profile-"));
  const configPath = join(root, "config.json");
  const registry = createBuiltinProviderRegistry();
  let connects = 0;
  registry.registerContribution(
    {
      definition: {
        ...registry.require("chatgpt"),
        id: "fixture/subscription",
        driverId: "fixture-subscription",
      },
      create: () => ({
        providerId: "fixture/subscription",
        async *streamChat() {},
      }),
      connection: {
        status: async () => ({ connected: false }),
        disconnect: async () => {},
        connect: async (input) => {
          connects++;
          input.challenge({
            url: "https://example.test/login",
            code: "TEST",
            expiresAt: Date.now() + 60000,
          });
          return { connected: true };
        },
      },
    },
    "fixture.subscription",
  );
  try {
    await saveGlobalConfig(
      {
        schemaVersion: 2,
        profiles: { work: { providerId: "openai", defaultModel: "gpt-5" } },
      },
      configPath,
    );
    const values = {
      provider: "fixture/subscription",
      profileId: "work",
      model: "fixture",
    };
    const signal = new AbortController().signal;
    await expect(
      connectProviderAccount(values, registry, signal, () => {}, {
        configPath,
      }),
    ).rejects.toThrow("другому сервису");
    await expect(
      connectProviderAccount(
        { ...values, profileId: "../escape" },
        registry,
        signal,
        () => {},
        { configPath },
      ),
    ).rejects.toThrow();
    await expect(
      connectProviderAccount(
        { ...values, profileId: "personal" },
        registry,
        AbortSignal.abort(),
        () => {},
        { configPath },
      ),
    ).rejects.toThrow();
    expect(connects).toBe(0);
    const challenges: string[] = [];
    expect(
      await connectProviderAccount(
        { ...values, profileId: "personal" },
        registry,
        signal,
        (value) => {
          challenges.push(value.code);
        },
        { configPath },
      ),
    ).toEqual({ connected: true });
    expect(connects).toBe(1);
    expect(challenges).toEqual(["TEST"]);
    expect(
      (await loadGlobalConfig(configPath)).profiles.personal,
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty installations stay empty across load/reopen and last deletion; browsing never creates profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-empty-settings-"));
  const configPath = join(root, "config.json");
  const registry = createBuiltinProviderRegistry();
  try {
    for (let i = 0; i < 2; i++) {
      const config = await loadGlobalConfig(configPath);
      expect(config.profiles).toEqual({});
      expect(config.defaultProfileId).toBeUndefined();
      expect(settingsDraft(config, registry).profileId).toBeUndefined();
    }
    const credentials = { get: async () => undefined, set: async () => {} };
    expect(
      await saveProviderSettings(
        { provider: "openai", profileId: "work", model: "gpt-5" },
        registry,
        { configPath, credentials, activate: false },
      ),
    ).toBe("setup_required");
    const saved = await loadGlobalConfig(configPath);
    expect(saved.profiles.work?.defaultModel).toBe("gpt-5");
    expect(saved.defaultProfileId).toBeUndefined();
    await removeProviderProfile("work", registry, { configPath });
    expect((await loadGlobalConfig(configPath)).profiles).toEqual({});
    expect(
      settingsDraft(await loadGlobalConfig(configPath), registry).profileId,
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("autosave patches changed profile fields and detects an external edit without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-settings-patch-"));
  const configPath = join(root, "config.json");
  const registry = createBuiltinProviderRegistry();
  const previous = {
    provider: "openai",
    profileId: "work",
    model: "gpt-5",
    label: "Рабочий",
  };
  try {
    await saveGlobalConfig(
      {
        schemaVersion: 2,
        profiles: {
          work: {
            providerId: "openai",
            defaultModel: "gpt-5",
            label: "Рабочий",
            custom: "preserved",
          },
        },
      },
      configPath,
    );
    const config = await loadGlobalConfig(configPath);
    config.profiles.work!.label = "Из другого окна";
    await saveGlobalConfig(config, configPath);
    await saveProviderSettings({ ...previous, model: "gpt-new" }, registry, {
      configPath,
      previous,
      activate: false,
    });
    expect((await loadGlobalConfig(configPath)).profiles.work).toMatchObject({
      label: "Из другого окна",
      defaultModel: "gpt-new",
      custom: "preserved",
    });
    await expect(
      saveProviderSettings({ ...previous, model: "stale" }, registry, {
        configPath,
        previous,
        activate: false,
      }),
    ).rejects.toThrow("изменилось");
    expect(
      (await loadGlobalConfig(configPath)).profiles.work?.defaultModel,
    ).toBe("gpt-new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacing a shared secret only changes the edited profile's credential reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-shared-key-edit-"));
  const configPath = join(root, "config.json");
  const keys = new Map([["legacy-shared", "old-key"]]);
  const credentials = {
    get: async (id: string) => keys.get(id),
    set: async (id: string, key: string) => {
      keys.set(id, key);
    },
  };
  try {
    const profile = {
      providerId: "openai",
      defaultModel: "gpt-5",
      apiKeyRef: "legacy-shared",
    };
    await saveGlobalConfig(
      { schemaVersion: 2, profiles: { a: profile, b: profile } },
      configPath,
    );
    await saveProviderSettings(
      { provider: "openai", profileId: "a", model: "gpt-5", apiKey: "new-key" },
      createBuiltinProviderRegistry(),
      { configPath, credentials, activate: false },
    );
    const config = await loadGlobalConfig(configPath);
    expect(config.profiles.b?.apiKeyRef).toBe("legacy-shared");
    expect(keys.get("legacy-shared")).toBe("old-key");
    expect(keys.get(config.profiles.a!.apiKeyRef!)).toBe("new-key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editing the selected model survives restart without selecting another viewed profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-settings-selected-"));
  const configPath = join(root, "config.json");
  const registry = createBuiltinProviderRegistry();
  try {
    await saveGlobalConfig(
      {
        schemaVersion: 2,
        defaultProfileId: "a",
        profiles: {
          a: { providerId: "openai", defaultModel: "old" },
          b: { providerId: "openai", defaultModel: "other" },
        },
        ui: {
          lastModelSelection: {
            provider: "openai",
            profileId: "a",
            model: "old",
          },
        },
      },
      configPath,
    );
    await saveProviderSettings(
      { provider: "openai", profileId: "b", model: "edited-other" },
      registry,
      { configPath, activate: false },
    );
    expect(
      (await loadGlobalConfig(configPath)).ui?.lastModelSelection?.model,
    ).toBe("old");
    await saveProviderSettings(
      { provider: "openai", profileId: "a", model: "edited-active" },
      registry,
      { configPath, activate: false, updateSelectedModel: true },
    );
    const restarted = await loadGlobalConfig(configPath);
    expect(restarted.ui?.lastModelSelection).toMatchObject({
      profileId: "a",
      model: "edited-active",
    });
    expect(restarted.defaultProfileId).toBe("a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
