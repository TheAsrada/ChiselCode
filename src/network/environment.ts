import { readFile, stat } from "node:fs/promises";
import { getCACertificates, rootCertificates } from "node:tls";
import ipaddr from "ipaddr.js";
import { domainMatches } from "../security/network-policy.js";

export class NetworkConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkConfigurationError";
  }
}

function variable(env: NodeJS.ProcessEnv, lower: string, upper: string) {
  return env[lower]?.trim() || env[upper]?.trim();
}

export function bypassProxy(url: URL, value = ""): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return value.split(/[\s,]+/).some((raw) => {
    if (!raw) return false;
    if (raw === "*") return true;
    if (raw.includes("/")) {
      try {
        const [address, bits] = ipaddr.parseCIDR(raw);
        const host = ipaddr.process(hostname);
        return host.kind() === address.kind() && host.match(address, bits);
      } catch {
        return false;
      }
    }
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(raw);
    if (!match) return hostname === raw.toLowerCase();
    const host = (match[1] ?? "").replace(/^\[|\]$/g, "").toLowerCase();
    if (match[2] && match[2] !== port) return false;
    if (host.startsWith("*.")) return hostname.endsWith(host.slice(1));
    if (host.startsWith("."))
      return hostname === host.slice(1) || hostname.endsWith(host);
    return hostname === host;
  });
}

/** Only user-owned process configuration can choose a trusted proxy. */
export function proxyForUrl(
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): URL | undefined {
  if (bypassProxy(url, variable(env, "no_proxy", "NO_PROXY"))) return;
  const raw =
    (url.protocol === "https:"
      ? variable(env, "https_proxy", "HTTPS_PROXY")
      : undefined) || variable(env, "http_proxy", "HTTP_PROXY");
  if (!raw) return;
  try {
    const proxy = new URL(raw);
    if (
      !["http:", "https:"].includes(proxy.protocol) ||
      !proxy.hostname ||
      (proxy.pathname !== "/" && proxy.pathname !== "") ||
      proxy.search ||
      proxy.hash
    )
      throw new Error();
    // Validate encoding without ever including credentials in an error.
    decodeURIComponent(proxy.username);
    decodeURIComponent(proxy.password);
    return proxy;
  } catch {
    throw new NetworkConfigurationError(
      "HTTP_PROXY/HTTPS_PROXY must contain a valid HTTP(S) proxy address. SOCKS is not supported.",
    );
  }
}

const pemFiles = new Map<string, Promise<string>>();
async function pemFile(path: string, name: string): Promise<string> {
  let task = pemFiles.get(path);
  if (!task) {
    task = (async () => {
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error();
        const text = await readFile(path, "utf8");
        if (!text.includes("-----BEGIN ")) throw new Error();
        return text;
      } catch {
        throw new NetworkConfigurationError(
          `Cannot read valid PEM data from ${name}. Check the configured file and restart ChiselCode.`,
        );
      }
    })();
    pemFiles.set(path, task);
    void task.catch(() => pemFiles.delete(path));
    while (pemFiles.size > 16) {
      const oldest = pemFiles.keys().next().value;
      if (oldest !== undefined) pemFiles.delete(oldest);
    }
  }
  return task;
}

export interface NetworkTls {
  rejectUnauthorized: true;
  ca?: string[];
  cert?: string;
  key?: string;
  passphrase?: string;
}

/** Extra roots extend trust; client identities are restricted to explicit hosts. */
export async function tlsForHost(
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NetworkTls> {
  const tls: NetworkTls = { rejectUnauthorized: true };
  const store = env.CHISEL_CERT_STORE?.trim() || "bundled,system";
  const sources = store.split(",").map((s) => s.trim());
  if (
    !sources.length ||
    sources.some((s) => !["bundled", "system"].includes(s))
  )
    throw new NetworkConfigurationError(
      "CHISEL_CERT_STORE must contain bundled, system, or bundled,system.",
    );
  const roots = sources.flatMap((source) =>
    source === "bundled"
      ? [...rootCertificates]
      : typeof getCACertificates === "function"
        ? getCACertificates("system")
        : [],
  );
  if (env.NODE_EXTRA_CA_CERTS)
    roots.push(await pemFile(env.NODE_EXTRA_CA_CERTS, "NODE_EXTRA_CA_CERTS"));
  if (!roots.length)
    throw new NetworkConfigurationError(
      "The selected certificate store contains no trusted roots. Configure NODE_EXTRA_CA_CERTS or CHISEL_CERT_STORE.",
    );
  if (roots.length) tls.ca = [...new Set(roots)];
  const cert = env.CHISEL_CLIENT_CERT?.trim();
  const key = env.CHISEL_CLIENT_KEY?.trim();
  const hosts = env.CHISEL_CLIENT_CERT_HOSTS?.trim();
  if (Boolean(cert) !== Boolean(key) || ((cert || key) && !hosts))
    throw new NetworkConfigurationError(
      "mTLS requires CHISEL_CLIENT_CERT, CHISEL_CLIENT_KEY and CHISEL_CLIENT_CERT_HOSTS together.",
    );
  const patterns = hosts?.split(/[\s,]+/).filter(Boolean) ?? [];
  if (patterns.some((p) => !/^(?:\*\.)?[a-zA-Z0-9.-]+$/.test(p)))
    throw new NetworkConfigurationError(
      "CHISEL_CLIENT_CERT_HOSTS must list exact hostnames or *.example.com patterns.",
    );
  if (cert && key && patterns.some((p) => domainMatches(hostname, p))) {
    [tls.cert, tls.key] = await Promise.all([
      pemFile(cert, "CHISEL_CLIENT_CERT"),
      pemFile(key, "CHISEL_CLIENT_KEY"),
    ]);
    if (env.CHISEL_CLIENT_KEY_PASSPHRASE)
      tls.passphrase = env.CHISEL_CLIENT_KEY_PASSPHRASE;
  }
  return tls;
}

/** Safe to show in settings/JSON: no proxy credentials, paths or PEM contents. */
export function networkEnvironmentStatus(env: NodeJS.ProcessEnv = process.env) {
  try {
    const proxy = proxyForUrl(new URL("https://example.com"), env);
    return {
      proxy: proxy
        ? {
            protocol: proxy.protocol,
            host: proxy.hostname,
            port: proxy.port || (proxy.protocol === "https:" ? "443" : "80"),
          }
        : undefined,
      extraCa: Boolean(env.NODE_EXTRA_CA_CERTS),
      certificateStore: env.CHISEL_CERT_STORE || "bundled,system",
      mtls: Boolean(env.CHISEL_CLIENT_CERT && env.CHISEL_CLIENT_KEY),
      tlsVerification: true,
    };
  } catch {
    return { error: "NETWORK_CONFIGURATION_ERROR", tlsVerification: true };
  }
}
