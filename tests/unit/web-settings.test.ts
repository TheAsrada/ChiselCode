import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../../src/security/credentials.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import {
  ProjectWebConfigSchema,
  WebConfigSchema,
} from "../../src/web/schema.js";
import { resolveWebCredential } from "../../src/web/search.js";
import { WebSettingsStore } from "../../src/web/settings.js";

test("legacy Web quotas disappear on load/save without losing credentials, explicit denies or unrelated config", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-quota-migration-"));
  try {
    const path = join(root, "config.json");
    const original = {
      schemaVersion: 2,
      profiles: {},
      customFutureSetting: { keep: true },
      web: {
        search: { provider: "brave", apiKey: { secretRef: "user-brave" } },
        permissions: {
          search: "deny",
          fetch: "ask",
          denyDomains: ["react.dev"],
        },
        limits: {
          maxRequestsPerTurn: 1,
          maxConcurrent: 1,
          requestTimeoutMs: 12345,
        },
      },
    };
    await writeFile(path, JSON.stringify(original));
    const store = new WebSettingsStore(
      path,
      new CredentialStore(join(root, "credentials")),
    );
    const loaded = await store.load();
    expect(loaded.config.limits).not.toHaveProperty("maxRequestsPerTurn");
    expect(loaded.config.limits).not.toHaveProperty("maxConcurrent");
    expect(loaded.config.limits.requestTimeoutMs).toBe(12345);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
    await store.save(loaded.config);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.customFutureSetting).toEqual({ keep: true });
    expect(persisted.web.search).toEqual(original.web.search);
    expect(persisted.web.permissions).toMatchObject(original.web.permissions);
    expect(persisted.web.limits).not.toHaveProperty("maxRequestsPerTurn");
    expect(persisted.web.limits).not.toHaveProperty("maxConcurrent");
    expect(
      ProjectWebConfigSchema.parse({
        enabled: false,
        denyDomains: ["react.dev"],
        maxRequestsPerTurn: 1,
        maxConcurrent: 1,
      }),
    ).toEqual({ enabled: false, denyDomains: ["react.dev"] });
    expect(
      WebConfigSchema.safeParse({ limits: { unknownQuota: 1 } }).success,
    ).toBe(false);
    expect(
      ProjectWebConfigSchema.safeParse({
        maxConcurrent: 1,
        permissions: { search: "allow" },
      }).success,
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
