import { expect, test } from "bun:test";
import { extractDocument } from "../../src/web/content.js";
import { WebRequestLimiter } from "../../src/web/limiter.js";
import { SearchInputSchema, WebConfigSchema } from "../../src/web/schema.js";
import { startWebFixture } from "../fixtures/web-http.js";

const authorization = { assertDestination() {} };

test("HTTP extracts actual streamed HTML, follows safe redirects and supports gzip/deflate/Brotli", async () => {
  const fixture = await startWebFixture();
  try {
    for (const path of ["/article", "/redirect", "/gzip", "/deflate", "/br"]) {
      const response = await fixture.client.get(
        `https://fixture.docs.example${path}`,
        { authorization },
      );
      expect(extractDocument(response, 30000).text).toContain("fetchFresh");
      expect(response.finalUrl).toBe(
        `https://fixture.docs.example${path === "/redirect" ? "/article" : path}`,
      );
    }
    expect(
      fixture.connections.every(
        (connection) => connection.addresses[0] === "93.184.215.14",
      ),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});
test("redirect destination SSRF is rejected before opening a second socket", async () => {
  const fixture = await startWebFixture();
  try {
    await expect(
      fixture.client.get("https://fixture.docs.example/private", {
        authorization,
      }),
    ).rejects.toMatchObject({ code: "WEB_UNSAFE_ADDRESS" });
    expect(fixture.connections).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
test("unsafe DNS, including a mixed public/private answer, never reaches the transport", async () => {
  const fixture = await startWebFixture(undefined, async () => [
    { address: "93.184.215.14", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ]);
  try {
    await expect(
      fixture.client.get("https://fixture.docs.example/article", {
        authorization,
      }),
    ).rejects.toMatchObject({ code: "WEB_UNSAFE_ADDRESS" });
    expect(fixture.connections).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});
test("DNS is revalidated after every redirect and checked addresses are not resolved again by the transport", async () => {
  let lookups = 0;
  const fixture = await startWebFixture(undefined, async () => [
    { address: ++lookups === 1 ? "93.184.215.14" : "127.0.0.1", family: 4 },
  ]);
  try {
    await expect(
      fixture.client.get("https://fixture.docs.example/redirect", {
        authorization,
      }),
    ).rejects.toMatchObject({ code: "WEB_UNSAFE_ADDRESS" });
    expect(lookups).toBe(2);
    expect(fixture.connections).toHaveLength(1);
    expect(fixture.connections[0]?.addresses).toEqual(["93.184.215.14"]);
  } finally {
    await fixture.close();
  }
});
test("redirect loops, count limit and invalid redirects produce controlled failures", async () => {
  const fixture = await startWebFixture(
    WebConfigSchema.parse({ limits: { maxRedirects: 2 } }),
  );
  try {
    for (const [path, code] of [
      ["/redirect-loop", "WEB_REDIRECT_LIMIT"],
      ["/chain/0", "WEB_REDIRECT_LIMIT"],
      ["/no-location", "WEB_PROTOCOL_ERROR"],
      ["/oversized-redirect", "WEB_TOO_LARGE"],
    ])
      await expect(
        fixture.client.get(`https://fixture.docs.example${path}`, {
          authorization,
        }),
      ).rejects.toMatchObject({ code });
    expect(fixture.counts.get("/chain/3")).toBeUndefined();
  } finally {
    await fixture.close();
  }
});
test("wire, chunked and decompression bomb limits fail before extraction", async () => {
  const fixture = await startWebFixture(
    WebConfigSchema.parse({
      limits: { maxResponseBytes: 4096, maxDecompressedBytes: 8192 },
    }),
  );
  try {
    for (const path of ["/huge", "/chunk-huge", "/bomb"])
      await expect(
        fixture.client.get(`https://fixture.docs.example${path}`, {
          authorization,
        }),
      ).rejects.toMatchObject({ code: "WEB_TOO_LARGE" });
  } finally {
    await fixture.close();
  }
});
test("timeouts cover headers, body and never-ending streams", async () => {
  const fixture = await startWebFixture(
    WebConfigSchema.parse({
      limits: { connectTimeoutMs: 100, requestTimeoutMs: 150 },
    }),
  );
  try {
    for (const path of ["/slow-headers", "/slow", "/endless"])
      await expect(
        fixture.client.get(`https://fixture.docs.example${path}`, {
          authorization,
        }),
      ).rejects.toMatchObject({ code: "WEB_TIMEOUT" });
  } finally {
    await fixture.close();
  }
});
test("AbortSignal cancels the socket and finite caller wait immediately", async () => {
  const fixture = await startWebFixture();
  const abort = new AbortController();
  try {
    const pending = fixture.client.get("https://fixture.docs.example/endless", {
      authorization,
      signal: abort.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.cancelledRequests).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});
test("malformed compressed streams, interrupted responses, unsupported encodings and HTTP errors are sanitized", async () => {
  const fixture = await startWebFixture();
  try {
    for (const [path, code] of [
      ["/malformed-gzip", "WEB_PROTOCOL_ERROR"],
      ["/interrupted", "WEB_PROTOCOL_ERROR"],
      ["/unsupported-encoding", "WEB_UNSUPPORTED_CONTENT"],
      ["/http-error", "WEB_HTTP_ERROR"],
    ])
      await expect(
        fixture.client.get(`https://fixture.docs.example${path}`, {
          authorization,
        }),
      ).rejects.toMatchObject({ code });
  } finally {
    await fixture.close();
  }
});
test("search uses the configured backend, credential header and compact normalized results", async () => {
  const fixture = await startWebFixture();
  try {
    const result = await fixture.backend.search(
      SearchInputSchema.parse({
        query: "API migration",
        domains: ["fixture.docs.example"],
      }),
      { authorization },
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.snippet).toBe("Official migration reference");
    expect(result.usage.requests).toBe(1);
    expect(fixture.receivedKey).toBe(fixture.key);
    expect(JSON.stringify(result)).not.toContain(fixture.key);
    fixture.setSearchFailure(429);
    await expect(
      fixture.backend.search(SearchInputSchema.parse({ query: "again" }), {
        authorization,
      }),
    ).rejects.toMatchObject({
      code: "WEB_RATE_LIMITED",
      details: { retryAfterMs: 2000 },
    });
    fixture.setSearchFailure(200, true);
    await expect(
      fixture.backend.search(SearchInputSchema.parse({ query: "again" }), {
        authorization,
      }),
    ).rejects.toMatchObject({ code: "WEB_PROTOCOL_ERROR" });
  } finally {
    await fixture.close();
  }
});
test("search never follows redirects with its credential header", async () => {
  const fixture = await startWebFixture();
  try {
    fixture.setSearchFailure(302);
    await expect(
      fixture.backend.search(SearchInputSchema.parse({ query: "docs" }), {
        authorization,
      }),
    ).rejects.toMatchObject({ code: "WEB_REDIRECT_LIMIT" });
    expect(fixture.connections).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
test("repeated rejected redirects and completed compressed responses close safely before fixture disposal", async () => {
  for (let cycle = 0; cycle < 3; cycle++) {
    const fixture = await startWebFixture();
    try {
      fixture.setSearchFailure(302);
      for (let call = 0; call < 20; call++)
        await expect(
          fixture.backend.search(SearchInputSchema.parse({ query: "docs" }), {
            authorization,
          }),
        ).rejects.toMatchObject({ code: "WEB_REDIRECT_LIMIT" });
      const response = await fixture.client.get(
        "https://fixture.docs.example/gzip",
        { authorization },
      );
      expect(extractDocument(response, 30000).text).toContain("fetchFresh");
      expect(fixture.connections).toHaveLength(21);
    } finally {
      await fixture.close();
    }
  }
}, 15000);
test("limiter bounds concurrency, queues cancellation, counts turn quota and rate limits separately", async () => {
  const limiter = new WebRequestLimiter(2, 0, 10);
  const signal = new AbortController().signal;
  const first = await limiter.acquire("turn", 4, signal);
  const second = await limiter.acquire("turn", 4, signal);
  const abort = new AbortController();
  const queued = limiter.acquire("turn", 4, abort.signal);
  abort.abort();
  await expect(queued).rejects.toMatchObject({ code: "CANCELLED" });
  first();
  second();
  const fourth = await limiter.acquire("turn", 4, signal);
  fourth();
  await expect(limiter.acquire("turn", 4, signal)).rejects.toMatchObject({
    code: "WEB_REQUEST_LIMIT",
  });
  const onePerMinute = new WebRequestLimiter(1, 0, 1);
  const release = await onePerMinute.acquire("a", 10, signal);
  release();
  await expect(onePerMinute.acquire("b", 10, signal)).rejects.toMatchObject({
    code: "WEB_RATE_LIMITED",
  });
});
