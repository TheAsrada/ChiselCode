import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTrialProviderConfig } from "../../evals/provider-profile.js";
import { saveGlobalConfig } from "../../src/config/load.js";

test("live harness profile config is isolated, supports env-only runs and preserves references", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-eval-profile-"));
  try {
    const user = join(root, "config.json"),
      trial = join(root, "trial", "config.json");
    await writeFile(user, JSON.stringify({ providers: {} }));
    const original = await readFile(user, "utf8");
    await writeTrialProviderConfig(trial, "openai", "gpt-5", undefined, user);
    expect(
      JSON.parse(await readFile(trial, "utf8")).profiles["eval-trial"],
    ).toEqual({ providerId: "openai", defaultModel: "gpt-5" });
    expect(await readFile(user, "utf8")).toBe(original);
    await saveGlobalConfig(
      {
        schemaVersion: 2,
        defaultProfileId: "work",
        profiles: {
          work: {
            providerId: "openai",
            apiKeyRef: "keep-ref",
            baseUrl: "https://work.example/v1",
          },
          personal: { providerId: "openai", apiKeyRef: "personal-ref" },
        },
      },
      user,
    );
    await expect(
      writeTrialProviderConfig(trial, "openai", "gpt-5", undefined, user),
    ).rejects.toThrow("--profile");
    await writeTrialProviderConfig(trial, "openai", "gpt-5", "work", user);
    expect(
      JSON.parse(await readFile(trial, "utf8")).profiles["eval-trial"]
        .apiKeyRef,
    ).toBe("keep-ref");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
