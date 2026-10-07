import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../../src/security/credentials.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import { WebConfigSchema } from "../../src/web/schema.js";
import { resolveWebCredential } from "../../src/web/search.js";
import { WebSettingsStore } from "../../src/web/settings.js";

test("settings persist only a secret reference and keep the key encrypted", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-settings-"));
  try {
    const credentials = new CredentialStore(join(root, "credentials"));
    const store = new WebSettingsStore(join(root, "config.json"), credentials);
    const initial = await store.load();
    expect(initial.config.permissions.search).toBe("allow");
    expect(initial.config.permissions.fetch).toBe("allow");
    const saved = await store.save(
      initial.config,
      "brave-private-key-test-123456789",
    );
    expect(saved.hasKey).toBe(true);
    expect(saved.config.search.apiKey).toEqual({
      secretRef: "web/brave-search",
    });
    const config = await readFile(join(root, "config.json"), "utf8");
    const encrypted = await readFile(
      join(root, "credentials", "credentials.enc"),
      "utf8",
    );
    expect(config).not.toContain("brave-private-key-test-123456789");
    expect(encrypted).not.toContain("brave-private-key-test-123456789");
    expect(await credentials.get("web/brave-search")).toBe(
      "brave-private-key-test-123456789",
    );
    const parallel = await store.save({
      ...saved.config,
      search: { ...saved.config.search, provider: "parallel" },
    });
    expect(parallel.searchBackend).toBe("parallel");
    expect(parallel.hasKey).toBe(true);
    expect(parallel.config.search.apiKey).toEqual({
      secretRef: "web/brave-search",
    });
    const restored = await store.save({
      ...parallel.config,
      search: { ...parallel.config.search, provider: "auto" },
    });
    expect(restored.searchBackend).toBe("brave");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("credential resolution uses references, redacts known values and gracefully rejects malformed keys", async () => {
  const redactor = new SecretRedactor(false);
  const config = WebConfigSchema.parse({});
  expect(
    await resolveWebCredential(
      config,
      redactor,
      { get: async () => undefined, set: async () => {} },
      { BRAVE_SEARCH_API_KEY: "private-search-key-123" },
    ),
  ).toBe("private-search-key-123");
  expect(redactor.text("page contains private-search-key-123")).toContain(
    "[секрет скрыт]",
  );
  expect(redactor.text("API_TOKEN is a public example variable")).toContain(
    "API_TOKEN",
  );
  expect(
    await resolveWebCredential(
      config,
      redactor,
      { get: async () => undefined, set: async () => {} },
      { BRAVE_SEARCH_API_KEY: "key\r\ninvalid" },
    ),
  ).toBeUndefined();
  const broken = WebConfigSchema.parse({
    search: { apiKey: { secretRef: "broken" } },
  });
  expect(
    await resolveWebCredential(broken, redactor, {
      get: async () => {
        throw new Error("secret-error");
      },
      set: async () => {},
    }),
  ).toBeUndefined();
});
test("defaults and individual settings drafts never share mutable permissions", () => {
  const first = WebConfigSchema.parse(undefined);
  const second = WebConfigSchema.parse(undefined);
  first.permissions.denyDomains.push("react.dev");
  first.search.apiKey = { secretRef: "only-first" };
  expect(second.permissions.denyDomains).toEqual([]);
  expect(second.search.apiKey).toEqual({ envRef: "BRAVE_SEARCH_API_KEY" });
});
test("saving other Web settings preserves the user's explicit Ask and Deny choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-explicit-permissions-"));
  try {
    const store = new WebSettingsStore(
      join(root, "config.json"),
      new CredentialStore(join(root, "credentials")),
    );
    const config = WebConfigSchema.parse({
      permissions: {
        search: "ask",
        fetch: "deny",
        denyDomains: ["example.com"],
      },
    });
    await store.save(config);
    const loaded = await store.load();
    expect(loaded.config.permissions).toEqual(config.permissions);
    loaded.config.search.provider = "parallel";
    await store.save(loaded.config);
    expect((await store.load()).config.permissions).toEqual(config.permissions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
