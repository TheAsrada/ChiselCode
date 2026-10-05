import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { domainMatches } from "../../src/security/network-policy.js";
import { pinnedRequestOptions } from "../../src/web/http-client.js";
import {
  ProjectWebConfigSchema,
  resolveWebConfig,
  WebConfigSchema,
} from "../../src/web/schema.js";
import { publicAddress, UrlPolicy } from "../../src/web/url-policy.js";

describe("public Web URL boundary", () => {
  const policy = new UrlPolicy();
  for (const url of [
    "https://react.dev/reference#actions",
    "http://example.com/",
    "https://EXAMPLE.COM.:443/a?q=b#section",
    "https://[2606:4700:4700::1111]/",
  ])
    test(`allows public ${url}`, () => {
      expect(policy.normalize(url).protocol).toMatch(/^https?:$/);
      expect(policy.normalize(url).hash).toBe("");
    });
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/a",
    "data:text/plain,secret",
    "gopher://example.com/",
    "https://user:password@example.com",
    "http://example.com:8080/",
    "http://localhost/",
    "http://foo.localhost/",
    "http://host.local/",
    "http://host.internal/",
    "http://metadata/",
    "http://metadata.google.internal/",
    "http://127.0.0.1/",
    "http://127.22.1.3/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.31.1.1/",
    "http://192.168.1.5/",
    "http://169.254.169.254/",
    "http://100.100.100.200/",
    "http://224.0.0.1/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fc00::1]/",
    "http://[fd12::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.1.2.3]/",
    "https://example.com/?api_key=secret",
    "https://example.com/?access_token=secret",
  ])
    test(`blocks ${url}`, () => {
      expect(() => policy.normalize(url)).toThrow();
    });
  for (const addresses of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    [{ address: "::ffff:169.254.169.254", family: 6 }],
    [{ address: "93.184.215.14", family: 6 }],
  ] as const)
    test(`rejects unsafe or inconsistent DNS ${JSON.stringify(addresses)}`, async () => {
      const dns = new UrlPolicy(async () => [...addresses]);
      await expect(
        dns.resolve("https://public.example/"),
      ).rejects.toMatchObject({ code: "WEB_UNSAFE_ADDRESS" });
    });
  test("DNS cancellation does not await a hung resolver", async () => {
    const dns = new UrlPolicy(async () => new Promise(() => {}));
    const abort = new AbortController();
    const pending = dns.resolve("https://public.example/", abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });
  test("URL bounds cover redirects, search links and percent-encoded expansion", () => {
    for (const url of [
      `https://docs.example/${"x".repeat(4096)}`,
      `https://docs.example/${"я".repeat(1000)}`,
    ]) {
      try {
        policy.normalize(url);
        throw new Error("An oversized URL was accepted");
      } catch (error) {
        expect(error).toMatchObject({ code: "WEB_TOO_LARGE" });
      }
    }
  });
  test("pins an already checked IP while retaining Host, SNI and original certificate identity", () => {
    const url = new URL("https://official.docs.example/reference?q=test");
    const options = pinnedRequestOptions(
      { url, addresses: [{ address: "93.184.215.14", family: 4 }] },
      {},
    );
    expect(options.hostname).toBe("93.184.215.14");
    expect(options.headers.Host).toBe("official.docs.example");
    expect(options.servername).toBe("official.docs.example");
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.agent).toBe(false);
    expect(
      options.checkServerIdentity?.("93.184.215.14", {
        subject: { CN: "attacker.example" },
        subjectaltname: "DNS:attacker.example",
      } as Parameters<NonNullable<typeof options.checkServerIdentity>>[1]),
    ).toBeInstanceOf(Error);
  });
  test("conservative special ranges exclude multicast, reserved and IPv6 translation", () => {
    for (const ip of [
      "192.0.0.1",
      "240.0.0.1",
      "2001:db8::1",
      "64:ff9b::7f00:1",
      "ff02::1",
    ])
      expect(publicAddress(ip)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
  });
});

describe("network permission layer", () => {
  const request = {
    tool: "web_fetch",
    preview: "https://react.dev/reference",
    network: {
      operation: "fetch" as const,
      hostname: "react.dev",
      url: "https://react.dev/reference",
    },
  };
  function gate(
    config = WebConfigSchema.parse({}),
    mode:
      | "default"
      | "acceptEdits"
      | "dontAsk"
      | "bypassPermissions" = "default",
    allow: string[] = [],
  ) {
    return new ApprovalGate(
      DEFAULT_PROJECT_CONFIG,
      {
        autoApprove: false,
        approvalMode: mode,
        allowBypassPermissions: true,
        nonInteractive: true,
        allowedTools: new Set(allow),
        network: { scope: randomUUID(), config },
      },
      { requestApproval: async () => "unavailable" },
    );
  }
  test("external reads require approval independently of filesystem reads", () => {
    const g = gate();
    expect(g.policy.decide(request, "external_read")).toBe("ask");
    expect(
      g.policy.decide({ tool: "read_file", preview: "file" }, "read"),
    ).toBe("allow");
    expect(g.policy.decide(request, "external_read", "acceptEdits")).toBe(
      "ask",
    );
  });
  test("Dont Ask rejects only ungranted network operations", () => {
    expect(
      gate(undefined, "dontAsk").policy.decide(request, "external_read"),
    ).toBe("deny");
    expect(
      gate(undefined, "dontAsk", ["web_fetch"]).policy.decide(
        request,
        "external_read",
      ),
    ).toBe("allow");
  });
  test("Bypass is deliberate; disabled Web and explicit domain deny always win", () => {
    expect(
      gate(undefined, "bypassPermissions").policy.decide(
        request,
        "external_read",
      ),
    ).toBe("allow");
    for (const config of [
      WebConfigSchema.parse({ enabled: false }),
      WebConfigSchema.parse({ permissions: { denyDomains: ["react.dev"] } }),
      WebConfigSchema.parse({ permissions: { fetch: "deny" } }),
    ])
      expect(
        gate(config, "bypassPermissions", ["web_fetch"]).policy.decide(
          request,
          "external_read",
        ),
      ).toBe("deny");
  });
  test("session grants are domain-scoped and separated from search", () => {
    const g = gate();
    g.policy.grantNetwork(request.network);
    expect(g.policy.decide(request, "external_read")).toBe("allow");
    expect(
      g.policy.decide(
        {
          ...request,
          network: { ...request.network, hostname: "sub.react.dev" },
        },
        "external_read",
      ),
    ).toBe("ask");
    expect(
      g.policy.decide(
        {
          tool: "web_search",
          preview: "query",
          network: { operation: "search", hostname: "api.search.brave.com" },
        },
        "external_read",
      ),
    ).toBe("ask");
    expect(gate().policy.decide(request, "external_read")).toBe("ask");
  });
  test("a once grant cannot authorize cross-domain redirects and can be revoked live", () => {
    const config = WebConfigSchema.parse({});
    const g = gate(config);
    const capability = g.policy.authorizeNetwork(request, "default", true);
    capability.assertDestination("react.dev");
    expect(() => capability.assertDestination("attacker.example")).toThrow();
    config.permissions.denyDomains.push("react.dev");
    expect(() => capability.assertDestination("react.dev")).toThrow();
  });
  test("Auto search approval is bounded to listed service hosts, filters denied services and rechecks live policy", () => {
    const config = WebConfigSchema.parse({
      permissions: { denyDomains: ["mcp.exa.ai"] },
    });
    const g = gate(config);
    const auto = {
      tool: "web_search",
      preview: "Auto: Exa → Parallel",
      network: {
        operation: "search" as const,
        hostname: "mcp.exa.ai",
        searchHosts: ["mcp.exa.ai", "search.parallel.ai"],
        provider: "auto",
      },
    };
    expect(g.policy.decide(auto, "external_read")).toBe("ask");
    expect(g.policy.decide(auto, "external_read", "dontAsk")).toBe("deny");
    const capability = g.policy.authorizeNetwork(auto, "default", true);
    expect(capability.destinations).toEqual(["search.parallel.ai"]);
    capability.assertDestination("search.parallel.ai");
    expect(() => capability.assertDestination("mcp.exa.ai")).toThrow();
    expect(() => capability.assertDestination("attacker.example")).toThrow();
    const bypass = g.policy.authorizeNetwork(auto, "bypassPermissions", false);
    expect(() => bypass.assertDestination("attacker.example")).toThrow();
    config.permissions.denyDomains.push("search.parallel.ai");
    expect(g.policy.decide(auto, "external_read", "bypassPermissions")).toBe(
      "deny",
    );
    expect(() => capability.assertDestination("search.parallel.ai")).toThrow();
    const explicit = {
      tool: "web_search",
      preview: "Parallel",
      network: { operation: "search" as const, hostname: "search.parallel.ai" },
    };
    const open = gate(
      WebConfigSchema.parse({ permissions: { search: "allow" } }),
    ).policy.authorizeNetwork(explicit, "default", false);
    expect(() => open.assertDestination("mcp.exa.ai")).toThrow();
  });
  test("explicit domains permit matching subdomains only when a wildcard was chosen", () => {
    expect(domainMatches("a.docs.rs", "*.docs.rs")).toBe(true);
    expect(domainMatches("docs.rs", "*.docs.rs")).toBe(false);
    expect(domainMatches("evildocs.rs", "*.docs.rs")).toBe(false);
    expect(
      gate(
        WebConfigSchema.parse({ permissions: { allowDomains: ["react.dev"] } }),
      ).policy.decide(request, "external_read"),
    ).toBe("allow");
  });
  test("project config cannot grant access or inject credentials", () => {
    expect(
      ProjectWebConfigSchema.safeParse({ permissions: { fetch: "allow" } })
        .success,
    ).toBe(false);
    expect(
      ProjectWebConfigSchema.safeParse({ search: { apiKey: "secret" } })
        .success,
    ).toBe(false);
    const combined = resolveWebConfig(
      { permissions: { allowDomains: ["react.dev"] } },
      ProjectWebConfigSchema.parse({
        denyDomains: ["react.dev"],
        maxRequestsPerTurn: 2,
      }),
    );
    expect(gate(combined).policy.decide(request, "external_read")).toBe("deny");
    expect(combined.limits.maxRequestsPerTurn).toBe(2);
  });
});
