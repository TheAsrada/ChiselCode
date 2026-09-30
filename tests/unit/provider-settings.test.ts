import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalConfig } from "../../src/config/load.js";
import { createProviderCatalog } from "../../src/providers/catalog.js";
import { createBuiltinProviderRegistry } from "../../src/providers/runtime.js";
import {
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
