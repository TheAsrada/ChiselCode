import { expect, test } from "bun:test";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import type { TLSSocket } from "node:tls";
import { enterpriseFetch } from "../../src/network/fetch.js";
import { SafeWebHttpClient } from "../../src/web/http-client.js";
import { WebConfigSchema } from "../../src/web/schema.js";
import { UrlPolicy } from "../../src/web/url-policy.js";
import {
  listen,
  networkCertificates,
  networkTlsDirectory,
  startNetworkProxy,
  startTlsOrigin,
  withNetworkEnvironment,
} from "../fixtures/network-proxy.js";

const authorization = { assertDestination() {} };
const client = (
  resolver = async () => [{ address: "93.184.215.14", family: 4 as const }],
) =>
  new SafeWebHttpClient(
    WebConfigSchema.parse({}).limits,
    new UrlPolicy(resolver),
  );
const ca = `${networkTlsDirectory}/ca.pem`;
const identity = {
  CHISEL_CLIENT_CERT: `${networkTlsDirectory}/identity.pem`,
  CHISEL_CLIENT_KEY: `${networkTlsDirectory}/identity-key.pem`,
};

for (const secureProxy of [false, true])
  test(`native web uses ${secureProxy ? "HTTPS" : "HTTP"} proxy with pinned destination, original Host/SNI and isolated auth`, async () => {
    const received: Array<{ host?: string; proxyAuth?: string; sni?: string }> =
      [];
    const origin = createHttps(await networkCertificates(), (req, res) => {
      received.push({
        host: req.headers.host,
        proxyAuth: req.headers["proxy-authorization"] as string | undefined,
        sni: (req.socket as TLSSocket).servername || undefined,
      });
      res.setHeader("Content-Type", "text/plain");
      res.end("corporate documentation");
    });
    const port = await listen(origin);
    const auth = `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`;
    const proxy = await startNetworkProxy({
      destinationPort: port,
      secure: secureProxy,
      auth,
    });
    try {
      const proxyUrl = new URL(proxy.url);
      proxyUrl.username = "proxy-user";
      proxyUrl.password = "proxy-password";
      await withNetworkEnvironment(
        { HTTPS_PROXY: proxyUrl.toString(), NODE_EXTRA_CA_CERTS: ca },
        async () => {
          const response = await client().get(
            "https://origin.docs.example/article",
            { authorization },
          );
          expect(new TextDecoder().decode(response.bytes)).toBe(
            "corporate documentation",
          );
        },
      );
      expect(proxy.requests[0]?.target).toBe("93.184.215.14:443");
      expect(proxy.requests[0]?.authorization).toBe(auth);
      expect(received).toEqual([
        {
          host: "origin.docs.example",
          proxyAuth: undefined,
          sni: "origin.docs.example",
        },
      ]);
    } finally {
      await proxy.close();
      await new Promise<void>((done) => origin.close(() => done()));
    }
  });

test("proxy does not weaken certificate verification, private DNS checks or redirect validation", async () => {
  const origin = createHttps(await networkCertificates(), (req, res) => {
    if (req.url === "/private")
      res.writeHead(302, { Location: "http://169.254.169.254/secret" });
    res.end("public");
  });
  const port = await listen(origin);
  const proxy = await startNetworkProxy({ destinationPort: port });
  try {
    await withNetworkEnvironment({ HTTPS_PROXY: proxy.url }, async () => {
      await expect(
        client().get("https://origin.docs.example/", { authorization }),
      ).rejects.toMatchObject({ code: "WEB_FETCH_FAILED" });
    });
    await withNetworkEnvironment(
      { HTTPS_PROXY: proxy.url, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      async () => {
        await expect(
          client().get("https://origin.docs.example/", { authorization }),
        ).rejects.toMatchObject({ code: "WEB_FETCH_FAILED" });
      },
    );
    await withNetworkEnvironment(
      { HTTPS_PROXY: proxy.url, NODE_EXTRA_CA_CERTS: ca },
      async () => {
        await expect(
          client().get("https://wrong.docs.example/", { authorization }),
        ).rejects.toMatchObject({ code: "WEB_FETCH_FAILED" });
        const count = proxy.requests.length;
        await expect(
          client().get("http://127.0.0.1/", { authorization }),
        ).rejects.toMatchObject({ code: "WEB_UNSAFE_ADDRESS" });
        await expect(
          client(async () => [{ address: "10.0.0.1", family: 4 }]).get(
            "https://origin.docs.example/",
            { authorization },
          ),
        ).rejects.toMatchObject({ code: "WEB_UNSAFE_ADDRESS" });
        expect(proxy.requests).toHaveLength(count);
        await expect(
          client().get("https://origin.docs.example/private", {
            authorization,
          }),
        ).rejects.toMatchObject({ code: "WEB_UNSAFE_ADDRESS" });
        expect(proxy.requests).toHaveLength(count + 1);
      },
    );
  } finally {
    await proxy.close();
    await new Promise<void>((done) => origin.close(() => done()));
  }
});

test("native web supports origin mTLS and never offers that identity to a TLS proxy", async () => {
  const origin = await startTlsOrigin();
  const proxy = await startNetworkProxy({
    destinationPort: origin.port,
    secure: true,
  });
  try {
    await withNetworkEnvironment(
      {
        HTTPS_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: ca,
        ...identity,
        CHISEL_CLIENT_CERT_HOSTS: "origin.docs.example",
      },
      async () => {
        const result = await client().get("https://origin.docs.example/", {
          authorization,
        });
        expect(new TextDecoder().decode(result.bytes)).toBe(
          "authenticated documentation",
        );
      },
    );
    expect(origin.peers).toEqual(["ChiselCode network fixture"]);
    expect(proxy.requests[0]?.peer).toBeUndefined();
  } finally {
    await proxy.close();
    origin.close();
  }
});

test("proxy mTLS is separate from the public origin identity", async () => {
  const origin = createHttp((req, res) => {
    expect(req.headers["proxy-authorization"]).toBeUndefined();
    res.end("ok");
  });
  const port = await listen(origin);
  const proxy = await startNetworkProxy({
    destinationPort: port,
    secure: true,
    requireClientCertificate: true,
  });
  try {
    await withNetworkEnvironment(
      {
        HTTP_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: ca,
        ...identity,
        CHISEL_CLIENT_CERT_HOSTS: "127.0.0.1",
      },
      async () => {
        expect(
          new TextDecoder().decode(
            (
              await client().get("http://origin.docs.example/", {
                authorization,
              })
            ).bytes,
          ),
        ).toBe("ok");
      },
    );
    expect(proxy.requests[0]?.target).toBe("93.184.215.14:80");
    expect(proxy.requests[0]?.peer).toBe("ChiselCode network fixture");
  } finally {
    await proxy.close();
    await new Promise<void>((done) => origin.close(() => done()));
  }
});

test("SDK HTTP transport supports proxy, custom roots, scoped client identity and NO_PROXY", async () => {
  const origin = await startTlsOrigin("sdk transport");
  const port = origin.port;
  const proxy = await startNetworkProxy({
    destinationPort: port,
    secure: true,
  });
  try {
    await withNetworkEnvironment(
      {
        HTTPS_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: ca,
        ...identity,
        CHISEL_CLIENT_CERT_HOSTS: "origin.docs.example",
      },
      async () => {
        const response = await enterpriseFetch("https://origin.docs.example/");
        expect(await response.text()).toBe("sdk transport");
      },
    );
    expect(proxy.requests).toHaveLength(1);
    expect(proxy.requests[0]?.peer).toBeUndefined();
    await withNetworkEnvironment(
      {
        HTTPS_PROXY: proxy.url,
        NO_PROXY: "localhost",
        NODE_EXTRA_CA_CERTS: ca,
        ...identity,
        CHISEL_CLIENT_CERT_HOSTS: "localhost",
      },
      async () => {
        expect(
          await (await enterpriseFetch(`https://localhost:${port}/`)).text(),
        ).toBe("sdk transport");
      },
    );
    expect(proxy.requests).toHaveLength(1);
    expect(origin.peers).toEqual([
      "ChiselCode network fixture",
      "ChiselCode network fixture",
    ]);
  } finally {
    await proxy.close();
    origin.close();
  }
});
