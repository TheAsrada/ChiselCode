import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chiselHomeDir,
  ensureChiselHomeLayout,
  providersRootDir,
} from "../../src/paths/home.js";
import { createProviderCatalog } from "../../src/providers/catalog.js";
import { resolveProviderRuntime } from "../../src/providers/runtime.js";
import { CredentialStore } from "../../src/security/credentials.js";

const manifest = {
  schemaVersion: 1,
  id: "example/gateway",
  label: "Example Gateway",
  driver: "openai-chat",
  auth: { required: true, envVars: ["EXAMPLE_API_KEY"] },
  endpoint: {
    required: false,
    defaultBaseUrl: "https://gateway.example.com/v1",
    normalization: "openai-v1",
  },
  defaults: { model: "coder" },
  capabilities: {
    modelListing: true,
    tokenCounting: "unsupported",
    usageReporting: "unknown",
    toolCalling: true,
    thinking: false,
  },
};
async function fixture(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "chisel-provider-"));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function pack(root: string, name: string, value: unknown) {
  await mkdir(join(root, name));
  await writeFile(
    join(root, name, "provider.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
test("empty Home/providers initialized exactly, built-ins are not copied", async () => {
  await fixture(async (root) => {
    const old = process.env.XDG_DATA_HOME;
    const local = process.env.LOCALAPPDATA;
    process.env.XDG_DATA_HOME = root;
    process.env.LOCALAPPDATA = root;
    try {
      expect(providersRootDir()).toBe(join(chiselHomeDir(), "providers"));
      await ensureChiselHomeLayout();
      expect(await readdir(providersRootDir())).toEqual([]);
      expect(
        (
          await createProviderCatalog({ root: providersRootDir() })
        ).registry.list(),
      ).toHaveLength(5);
    } finally {
      if (old === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = old;
      if (local === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = local;
    }
  });
});
test("valid OpenAI and Anthropic manifests; removed provider remains controlled; no code/credentials/network at discovery", async () => {
  await fixture(async (root) => {
    await pack(root, "oa", manifest);
    await writeFile(
      join(root, "oa", "index.js"),
      'throw new Error("must not execute")',
    );
    await pack(root, "anth", {
      ...manifest,
      id: "example/anth",
      driver: "anthropic-messages",
      endpoint: { ...manifest.endpoint, normalization: "anthropic-root" },
      driverOptions: { authMode: "bearer" },
    });
    let creds = 0,
      net = 0;
    const get = CredentialStore.prototype.get;
    const fetch = globalThis.fetch;
    CredentialStore.prototype.get = async () => {
      creds++;
      throw new Error("credentials forbidden during discovery");
    };
    globalThis.fetch = Object.assign(async () => {
      net++;
      throw new Error("network forbidden during discovery");
    }, fetch);
    let catalog: Awaited<ReturnType<typeof createProviderCatalog>>;
    try {
      catalog = await createProviderCatalog({ root });
      expect(creds).toBe(0);
      expect(net).toBe(0);
    } finally {
      CredentialStore.prototype.get = get;
      globalThis.fetch = fetch;
    }
    expect(catalog.registry.has("example/gateway")).toBe(true);
    expect(catalog.registry.has("example/anth")).toBe(true);
    expect(catalog.registry.source("example/gateway")?.type).toBe(
      "user-manifest",
    );
    const runtime = await resolveProviderRuntime({
      profile: { providerId: "example/gateway", apiKeyRef: "corporate" },
      registry: catalog.registry,
      drivers: catalog.drivers,
      credentials: {
        async get() {
          return "opaque-key";
        },
      },
      environment: {},
    });
    expect(runtime.adapter.providerId).toBe("example/gateway");
    expect(runtime.adapter.constructor.name).toBe("OpenAIProtocolAdapter");
    await rm(join(root, "oa"), { recursive: true });
    catalog = await createProviderCatalog({ root });
    expect(catalog.registry.has("example/gateway")).toBe(false);
    await expect(
      resolveProviderRuntime({
        profile: { providerId: "example/gateway" },
        registry: catalog.registry,
      }),
    ).rejects.toThrow("unavailable");
  });
});
for (const [name, patch, code] of [
  ["json", "{bad-json", "manifest_invalid"],
  ["schema", { ...manifest, schemaVersion: 2 }, "unsupported_schema"],
  ["id", { ...manifest, id: "../escape" }, "manifest_invalid"],
  ["reserved", { ...manifest, id: "openai" }, "reserved_id"],
  ["driver", { ...manifest, driver: "unknown-protocol" }, "unknown_driver"],
  [
    "options",
    { ...manifest, driverOptions: { includeUsage: "not-boolean" } },
    "invalid_driver_options",
  ],
  [
    "url",
    {
      ...manifest,
      endpoint: { ...manifest.endpoint, defaultBaseUrl: "file:///tmp/secret" },
    },
    "manifest_invalid",
  ],
  [
    "env",
    { ...manifest, auth: { required: true, envVars: ["bad-name"] } },
    "manifest_invalid",
  ],
  [
    "secret",
    {
      ...manifest,
      driverOptions: { nested: { authorization: "secret-value-do-not-print" } },
    },
    "manifest_invalid",
  ],
  ["size", " ".repeat(256 * 1024 + 1), "manifest_too_large"],
] as const)
  test(`invalid custom ${name} isolated, no secret in diagnostics`, async () => {
    await fixture(async (root) => {
      await pack(root, "broken", patch);
      await pack(root, "good", manifest);
      const c = await createProviderCatalog({ root });
      expect(c.registry.has("example/gateway")).toBe(true);
      expect(c.diagnostics.some((d) => d.code === code)).toBe(true);
      expect(JSON.stringify(c.diagnostics)).not.toContain(
        "secret-value-do-not-print",
      );
    });
  });
test("duplicate IDs disable all conflicting packages; missing manifests and symlinks diagnosed; no recursive scan", async () => {
  await fixture(async (root) => {
    await pack(root, "one", manifest);
    await pack(root, "two", manifest);
    await mkdir(join(root, "missing"));
    await mkdir(join(root, "nested", "child"), { recursive: true });
    await writeFile(
      join(root, "nested", "child", "provider.json"),
      JSON.stringify({ ...manifest, id: "nested/ignored" }),
    );
    await symlink(
      join(root, "one"),
      join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const c = await createProviderCatalog({ root });
    expect(c.registry.has("example/gateway")).toBe(false);
    expect(c.registry.has("nested/ignored")).toBe(false);
    expect(c.diagnostics.filter((d) => d.code === "duplicate_id")).toHaveLength(
      2,
    );
    expect(c.diagnostics.some((d) => d.code === "unsafe_symlink")).toBe(true);
    expect(c.diagnostics.some((d) => d.code === "manifest_invalid")).toBe(true);
  });
});
test("catalog loads 500 manifests, supports search without fixed limits", async () => {
  await fixture(async (root) => {
    for (let i = 0; i < 500; i++)
      await pack(root, `folder-${i}`, {
        ...manifest,
        id: `scale/provider-${i}`,
        label: `Scale ${i}`,
      });
    const c = await createProviderCatalog({ root });
    expect(c.registry.list()).toHaveLength(505);
    expect(c.registry.search("Scale 499")).toHaveLength(1);
    expect(c.diagnostics).toEqual([]);
  });
});
test("remote HTTP warned, local HTTP allowed", async () => {
  await fixture(async (root) => {
    await pack(root, "remote", {
      ...manifest,
      endpoint: {
        ...manifest.endpoint,
        defaultBaseUrl: "http://remote.example/v1",
      },
    });
    const c = await createProviderCatalog({ root });
    expect(c.registry.has("example/gateway")).toBe(true);
    expect(c.diagnostics[0]?.code).toBe("insecure_endpoint");
  });
});

test("manifest symlink is rejected and root symlink cannot escape discovery", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "package"));
    await writeFile(join(root, "outside.json"), JSON.stringify(manifest));
    await symlink(
      join(root, "outside.json"),
      join(root, "package", "provider.json"),
      "file",
    );
    const c = await createProviderCatalog({ root });
    expect(c.registry.has(manifest.id)).toBe(false);
    expect(c.diagnostics.some((d) => d.code === "unsafe_symlink")).toBe(true);
    await symlink(
      join(root, "package"),
      join(root, "root-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      (
        await createProviderCatalog({ root: join(root, "root-link") })
      ).diagnostics.some((d) => d.code === "unsafe_symlink"),
    ).toBe(true);
  });
});
