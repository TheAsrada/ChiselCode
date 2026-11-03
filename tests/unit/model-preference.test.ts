import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalConfig, updateGlobalConfig } from "../../src/config/load.js";
import {
  rememberedModelOptions,
  rememberModelSelection,
} from "../../src/ui/model-preference.js";

test("explicit model choices survive config reload, preserve concurrent settings and respect CLI/profile changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-model-preference-"));
  const path = join(root, "config.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        defaultProfileId: "work",
        profiles: {
          work: {
            providerId: "openai",
            defaultModel: "default",
            baseUrl: "https://example.com/v1",
          },
          personal: { providerId: "openai", defaultModel: "personal-default" },
        },
        ui: { theme: "paper" },
        custom: { keep: true },
      }),
    );
    const selection = {
      provider: "openai",
      profileId: "personal",
      model: "chosen",
      baseUrl: "https://temporary.example/v1",
    };
    await Promise.all([
      rememberModelSelection(selection, path),
      updateGlobalConfig(path, (config) => ({
        ...config,
        ui: { ...config.ui, motion: "reduced" },
      })),
    ]);
    const loaded = await loadGlobalConfig(path);
    expect(loaded.defaultProfileId).toBe("work");
    expect(loaded.profiles.work?.defaultModel).toBe("default");
    expect(loaded.ui).toEqual({
      theme: "paper",
      motion: "reduced",
      lastModelSelection: {
        provider: "openai",
        profileId: "personal",
        model: "chosen",
      },
    });
    expect(loaded.custom).toEqual({ keep: true });
    expect(rememberedModelOptions(loaded, {})).toEqual({
      profile: "personal",
      model: "chosen",
    });
    for (const explicit of [
      { model: "cli-model" },
      { profile: "work" },
      { provider: "anthropic" },
      { baseUrl: "https://override.example" },
    ])
      expect(rememberedModelOptions(loaded, explicit)).toEqual(explicit);
    await expect(
      rememberModelSelection({ ...selection, model: "cancelled" }, path, () => {
        throw new Error("closed");
      }),
    ).rejects.toThrow("closed");
    expect((await loadGlobalConfig(path)).ui?.lastModelSelection?.model).toBe(
      "chosen",
    );
    await updateGlobalConfig(path, (config) => ({
      ...config,
      profiles: { work: config.profiles.work! },
    }));
    expect(rememberedModelOptions(await loadGlobalConfig(path), {})).toEqual(
      {},
    );
    await expect(rememberModelSelection(selection, path)).rejects.toThrow(
      "Подключение изменилось",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
