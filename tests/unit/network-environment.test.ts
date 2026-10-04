import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  bypassProxy,
  networkEnvironmentStatus,
  proxyForUrl,
  tlsForHost,
} from "../../src/network/environment.js";

describe("corporate proxy selection", () => {
  test("HTTP/HTTPS, precedence and basic authentication stay out of diagnostics", () => {
    const env = {
      HTTPS_PROXY: "https://user:password@proxy.example:8443",
      https_proxy: "http://lowercase:secret@lower.example:8080",
      HTTP_PROXY: "http://http.example:3128",
    };
    expect(proxyForUrl(new URL("https://react.dev"), env)?.hostname).toBe(
      "lower.example",
    );
    expect(proxyForUrl(new URL("http://react.dev"), env)?.hostname).toBe(
      "http.example",
    );
    const status = JSON.stringify(networkEnvironmentStatus(env));
    expect(status).toContain("lower.example");
    for (const secret of ["lowercase", "secret", "password", "user"])
      expect(status).not.toContain(secret);
  });
  test("NO_PROXY supports exact hosts, domain suffixes, ports, IPv6, CIDR and wildcard", () => {
    for (const [url, pattern, matches] of [
      ["https://react.dev", "react.dev", true],
      ["https://evilreact.dev", "react.dev", false],
      ["https://docs.react.dev", ".react.dev", true],
      ["https://react.dev", ".react.dev", true],
      ["https://react.dev", "*.react.dev", false],
      ["https://docs.react.dev", "*.react.dev", true],
      ["https://react.dev", "react.dev:443", true],
      ["https://react.dev", "react.dev:80", false],
      ["http://[::1]:80", "[::1]:80", true],
      ["http://10.1.2.3", "10.0.0.0/8", true],
      ["https://react.dev", "localhost, example.org react.dev", true],
      ["https://react.dev", "*", true],
    ] as const)
      expect(bypassProxy(new URL(url), pattern)).toBe(matches);
    expect(
      proxyForUrl(new URL("https://react.dev"), {
        HTTPS_PROXY: "http://proxy.example",
        NO_PROXY: "react.dev",
      }),
    ).toBeUndefined();
  });
  test("invalid proxy URLs produce safe actionable errors", () => {
    for (const raw of [
      "socks5://proxy.example",
      "https://secret:password@proxy.example/path",
      "https://secret:password@",
      "not-a-url",
    ]) {
      expect(() =>
        proxyForUrl(new URL("https://react.dev"), { HTTPS_PROXY: raw }),
      ).toThrow("valid HTTP(S)");
      expect(
        JSON.stringify(networkEnvironmentStatus({ HTTPS_PROXY: raw })),
      ).not.toContain(raw);
    }
  });
});

describe("certificate trust and client identities", () => {
  const root = resolve("tests/fixtures/network-tls");
  const env = {
    NODE_EXTRA_CA_CERTS: `${root}/ca.pem`,
    CHISEL_CLIENT_CERT: `${root}/identity.pem`,
    CHISEL_CLIENT_KEY: `${root}/identity-key.pem`,
    CHISEL_CLIENT_CERT_HOSTS: "origin.docs.example *.corp.example",
  };
  test("extra roots extend bundled/system trust without disabling verification", async () => {
    const tls = await tlsForHost("react.dev", env);
    expect(tls.rejectUnauthorized).toBe(true);
    expect(tls.ca?.length).toBeGreaterThan(1);
    expect(tls.key).toBeUndefined();
  });
  test("mTLS identity is sent only to explicitly configured hosts", async () => {
    expect((await tlsForHost("origin.docs.example", env)).key).toContain(
      "PRIVATE KEY",
    );
    expect((await tlsForHost("proxy.corp.example", env)).cert).toContain(
      "CERTIFICATE",
    );
    expect((await tlsForHost("corp.example", env)).key).toBeUndefined();
    expect((await tlsForHost("evilcorp.example", env)).key).toBeUndefined();
    expect((await tlsForHost("react.dev", env)).key).toBeUndefined();
  });
  test("missing/invalid certificates and incomplete identities fail without leaking paths or PEM", async () => {
    await expect(
      tlsForHost("react.dev", {
        NODE_EXTRA_CA_CERTS: "/private/missing-secret.pem",
      }),
    ).rejects.toThrow("NODE_EXTRA_CA_CERTS");
    await expect(
      tlsForHost("react.dev", { CHISEL_CLIENT_CERT: env.CHISEL_CLIENT_CERT }),
    ).rejects.toThrow("CHISEL_CLIENT_CERT_HOSTS");
    await expect(
      tlsForHost("react.dev", { ...env, CHISEL_CLIENT_CERT_HOSTS: "*" }),
    ).rejects.toThrow("exact hostnames");
    await expect(
      tlsForHost("react.dev", { CHISEL_CERT_STORE: "none" }),
    ).rejects.toThrow("CHISEL_CERT_STORE");
  });
});
