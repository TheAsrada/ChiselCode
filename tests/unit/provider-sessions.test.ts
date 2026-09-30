import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProviderRuntime } from "../../src/providers/runtime.js";
import { migrateSessionRecord } from "../../src/sessions/migrate.js";
import {
  type ProjectSessionStore,
  projectSessionStore,
} from "../../src/sessions/project-store.js";

async function fixture(work: (store: ProjectSessionStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "chisel-session-v3-"));
  const keys = [
    "XDG_DATA_HOME",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "APPDATA",
  ] as const;
  const old = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = root;
  try {
    await work(await projectSessionStore(join(root, "workspace")));
  } finally {
    keys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    });
    await rm(root, { recursive: true, force: true });
  }
}
for (const provider of ["anthropic", "openai", "agentrouter", "vendor/removed"])
  test(`session v2 ${provider} loads lazily, preserves history/summary, rebuilds index, saves v3`, async () => {
    await fixture(async (store) => {
      const session = store.create(provider, "original-model");
      session.messages = [
        {
          role: "user",
          content: [{ type: "text", text: "Keep public API unchanged" }],
        },
      ];
      const { providerId: _id, profileId: _profile, ...fields } = session;
      const raw = {
        ...fields,
        schemaVersion: 2,
        provider,
        future: { value: true },
      };
      const source = JSON.stringify(raw);
      const file = join(store.directory, `${session.id}.json`);
      await writeFile(file, source);
      await writeFile(
        join(store.directory, "index.json"),
        JSON.stringify({ schemaVersion: 1, sessions: [] }),
      );
      const loaded = await store.load(session.id);
      expect(loaded.providerId).toBe(provider);
      expect(loaded.profileId).toBe(`${provider.replaceAll("/", "-")}-default`);
      expect(loaded.provider).toBe(provider);
      expect(loaded.messages).toEqual(session.messages);
      expect(await readFile(file, "utf8")).toBe(source);
      expect(migrateSessionRecord(migrateSessionRecord(raw))).toEqual(
        migrateSessionRecord(raw),
      );
      const summary = (await store.list()).find((s) => s.id === session.id);
      expect(summary?.providerId).toBe(provider);
      expect(summary?.lastUserMessage).toContain("public API");
      expect(await readFile(file, "utf8")).toBe(source);
      expect(
        JSON.parse(await readFile(join(store.directory, "index.json"), "utf8"))
          .schemaVersion,
      ).toBe(2);
      if (provider === "vendor/removed")
        await expect(
          resolveProviderRuntime({
            profile: { providerId: provider },
            environment: {},
          }),
        ).rejects.toThrow("unavailable");
      await store.save(loaded);
      const written = JSON.parse(await readFile(file, "utf8"));
      expect(written.schemaVersion).toBe(3);
      expect(written.providerId).toBe(provider);
      expect(written.profileId).toBe(loaded.profileId);
      expect(written.provider).toBeUndefined();
      expect(written.future).toEqual({ value: true });
    });
  });
test("v3 explicit profile roundtrip and absent provider/profile keep history readable", async () => {
  await fixture(async (store) => {
    const session = store.create("openai", "gpt-5");
    session.profileId = "openai-personal";
    await store.save(session);
    expect((await store.load(session.id)).profileId).toBe("openai-personal");
    expect(
      migrateSessionRecord({ schemaVersion: 2, provider: "unknown-service" })
        .profileId,
    ).toBe("unknown-service-default");
    expect(migrateSessionRecord({ schemaVersion: 2 }).providerId).toBe(
      "unknown",
    );
    await store.save(store.create("vendor/removed", "former-model"));
    expect(await store.list()).toHaveLength(2);
  });
});
