import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { gzipSync } from "node:zlib";
import { enterpriseFetch } from "../../src/network/fetch.js";
import { SafeWebHttpClient } from "../../src/web/http-client.js";
import { WebConfigSchema } from "../../src/web/schema.js";
import { UrlPolicy } from "../../src/web/url-policy.js";
import { listen, withNetworkEnvironment } from "../fixtures/network-proxy.js";

test("SDK streaming transport retains UTF-8 POST bodies, decompresses responses and strips auth on cross-origin redirects", async () => {
  const received: Array<{
    method: string;
    body: string;
    authorization: string | null;
    apiKey: string | null;
    cookie: string | null;
  }> = [];
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({
        method: request.method,
        body: await request.text(),
        authorization: request.headers.get("authorization"),
        apiKey: request.headers.get("x-api-key"),
        cookie: request.headers.get("cookie"),
      });
      return new Response(gzipSync(JSON.stringify({ message: "Ответ ✓" })), {
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
      });
    },
  });
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.redirect(`${destination.url}destination`, 307);
    },
  });
  try {
    await withNetworkEnvironment({}, async () => {
      const response = await enterpriseFetch(`${source.url}redirect`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-only-secret",
          "x-api-key": "test-only-key",
          Cookie: "test-session",
        },
        body: "Привет из запроса",
      });
      expect(await response.json()).toEqual({ message: "Ответ ✓" });
      expect(response.url).toBe(`${destination.url}destination`);
      expect(received).toEqual([
        {
          method: "POST",
          body: "Привет из запроса",
          authorization: null,
          apiKey: null,
          cookie: null,
        },
      ]);
    });
  } finally {
    source.stop(true);
    destination.stop(true);
  }
});

test("SDK redirect policy, HEAD/204 responses and abort during streaming preserve fetch semantics", async () => {
  let finalMethod = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/redirect")
        return new Response(null, {
          status: 303,
          headers: { Location: "/final" },
        });
      if (path === "/final") {
        finalMethod = request.method;
        return new Response(null, { status: 204 });
      }
      let timer: ReturnType<typeof setInterval>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: working\n\n"));
            timer = setInterval(
              () =>
                controller.enqueue(
                  new TextEncoder().encode("data: working\n\n"),
                ),
              25,
            );
          },
          cancel() {
            clearInterval(timer);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    await withNetworkEnvironment({}, async () => {
      expect(
        (await enterpriseFetch(`${server.url}redirect`, { redirect: "manual" }))
          .status,
      ).toBe(303);
      await expect(
        enterpriseFetch(`${server.url}redirect`, { redirect: "error" }),
      ).rejects.toThrow("redirect refused");
      const head = await enterpriseFetch(`${server.url}redirect`, {
        method: "HEAD",
      });
      expect(head.status).toBe(204);
      expect(head.body).toBeNull();
      expect(finalMethod).toBe("HEAD");
      const abort = new AbortController();
      const response = await enterpriseFetch(`${server.url}stream`, {
        signal: abort.signal,
      });
      const pending = response.text();
      abort.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });
  } finally {
    server.stop(true);
  }
});

for (const cancellation of ["abort", "total timeout", "connection timeout"])
  test(`${cancellation} closes a proxy stuck before CONNECT completes`, async () => {
    const sockets = new Set<Duplex>();
    let connected: (() => void) | undefined;
    const started = new Promise<void>((done) => {
      connected = done;
    });
    const proxy = createServer();
    proxy.on("connect", (_request, socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("end", () => socket.end());
      socket.resume();
      connected?.();
    });
    const port = await listen(proxy);
    try {
      await withNetworkEnvironment(
        { HTTPS_PROXY: `http://127.0.0.1:${port}` },
        async () => {
          const http = new SafeWebHttpClient(
            WebConfigSchema.parse({
              limits: {
                connectTimeoutMs:
                  cancellation === "connection timeout" ? 100 : 2000,
                requestTimeoutMs: cancellation === "total timeout" ? 100 : 2000,
              },
            }).limits,
            new UrlPolicy(async () => [
              { address: "93.184.215.14", family: 4 },
            ]),
          );
          const abort = new AbortController();
          const pending = http.get("https://origin.docs.example/", {
            authorization: { assertDestination() {} },
            signal: abort.signal,
          });
          await started;
          if (cancellation === "abort") abort.abort();
          await expect(pending).rejects.toMatchObject({
            code: cancellation === "abort" ? "CANCELLED" : "WEB_TIMEOUT",
          });
          for (let n = 0; n < 50 && sockets.size; n++) await Bun.sleep(10);
          expect(sockets.size).toBe(0);
        },
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => proxy.close(() => done()));
    }
  });
