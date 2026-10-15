import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_PROJECT_CONFIG,
  loadGlobalConfig,
} from "../../src/config/load.js";
import { userFolder, xdgUserFolder } from "../../src/paths/user-folders.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../src/security/approval.js";
import { createSession } from "../../src/sessions/store.js";
import { ChildToolPolicy } from "../../src/subagents/policy.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import { workspaceCoordinator } from "../../src/tools/workspace-coordinator.js";
import { SafeWebHttpClient } from "../../src/web/http-client.js";
import { WebRequestLimiter } from "../../src/web/limiter.js";
import { WebToolProvider } from "../../src/web/provider.js";
import { WebConfigSchema } from "../../src/web/schema.js";
import { UrlPolicy } from "../../src/web/url-policy.js";

const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
test("ordinary source CLI downloads through the public-address policy and a trusted proxy", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "tests/fixtures/web-download-cli.ts",
      process.execPath,
      "src/cli.ts",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("verified SHA-256 passed");
}, 45000);
async function environment(
  options: {
    mode?: "plan" | "build";
    denied?: boolean;
    timeout?: number;
    ask?: boolean;
    child?: "readonly" | "coding";
  } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-download-")),
  );
  const config = WebConfigSchema.parse({
    permissions: { fetch: options.denied ? "deny" : "allow" },
    limits: { downloadTimeoutMs: options.timeout ?? 5000 },
  });
  const counts = new Map<string, number>();
  let finish: (() => void) | undefined;
  const server = createServer((req, res) => {
    const path = req.url!;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (path === "/redirect") {
      res.writeHead(302, { Location: "/image" });
      res.end();
      return;
    }
    if (path === "/private") {
      res.writeHead(302, { Location: "http://127.0.0.1/private" });
      res.end();
      return;
    }
    if (path === "/retry" && counts.get(path)! < 3) {
      res.writeHead(429, { "Retry-After": "0" });
      res.end();
      return;
    }
    if (path === "/retry-after" && counts.get(path) === 1) {
      res.writeHead(429, { "Retry-After": "1" });
      res.end();
      return;
    }
    if (path === "/refused") {
      res.writeHead(429, { "Retry-After": "120" });
      res.end();
      return;
    }
    if (path === "/error") {
      res.writeHead(503);
      res.end();
      return;
    }
    if (path === "/huge") {
      res.writeHead(200);
      res.end(Buffer.alloc(8192));
      return;
    }
    if (path === "/gzip") {
      const compressed = gzipSync(image);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Encoding": "gzip",
        "Content-Length": compressed.length,
      });
      res.end(compressed);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": image.length,
    });
    if (path === "/hold") {
      res.write(image.subarray(0, 10));
      finish = () => res.end(image.subarray(10));
      return;
    }
    if (path === "/broken") {
      res.write(image.subarray(0, 10));
      setTimeout(() => res.destroy(), 5);
      return;
    }
    res.end(image);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const client = new SafeWebHttpClient(
    config.limits,
    new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]),
    (_target, settings, response) =>
      request(
        {
          hostname: "127.0.0.1",
          port,
          path: _target.url.pathname,
          headers: settings.headers,
        },
        response,
      ),
  );
  const approvals: ApprovalRequest[] = [];
  const session = createSession(root, "fixture", "fixture");
  const events = new RuntimeEventBus(session.id);
  let markReceived = () => {};
  const received = new Promise<void>((done) => {
    markReceived = done;
  });
  events.subscribe((event) => {
    if (event.type === "tool_progress" && event.progress) markReceived();
  });
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    {
      autoApprove: false,
      allowedTools: new Set(options.ask ? [] : ["web_download"]),
      nonInteractive: false,
      network: { scope: `${root}:${session.id}`, config },
    },
    {
      requestApproval: async (value) => {
        approvals.push(value);
        return "approved";
      },
    },
  );
  const configPath = join(root, "global.json");
  await writeFile(
    configPath,
    JSON.stringify({ schemaVersion: 2, profiles: {}, web: config }),
  );
  const childPolicy = options.child
    ? new ChildToolPolicy(
        options.child,
        root,
        root,
        configPath,
        DEFAULT_PROJECT_CONFIG,
        await loadGlobalConfig(configPath),
        "default",
        "web_download",
        async () => {},
      )
    : undefined;
  if (options.child)
    session.subagent = {
      id: crypto.randomUUID(),
      ownerId: session.id,
      parentRoot: root,
      mode: options.child,
      depth: 1,
    };
  const tools = createLocalToolRuntime(root, [], gate, session, [], {
    mode: options.mode ?? "build",
    executionConstraint: childPolicy,
    events,
    artifactDirectory: join(root, "artifacts"),
  });
  await tools.catalog.addProvider(
    new WebToolProvider(config, client, undefined, {
      limiter: new WebRequestLimiter(3, 0, 1000),
    }),
  );
  if (childPolicy) childPolicy.seal([tools.catalog.get("web_download")]);
  let serial = 0;
  return {
    root,
    tools,
    session,
    events,
    client,
    config,
    counts,
    received,
    approvals,
    finish: () => finish!(),
    download: (
      route: string,
      input: Record<string, unknown> = {},
      signal?: AbortSignal,
    ) =>
      tools.executor.execute(
        {
          id: `download-${++serial}`,
          name: "web_download",
          input: {
            url: `https://images.example${route}`,
            path: "image.png",
            ...input,
          },
        },
        signal,
      ),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("cancellation drains a pending streaming file write before the caller can clean or retry staging", async () => {
  const env = await environment();
  let release!: () => void,
    started!: () => void,
    settled = false;
  const writing = new Promise<void>((done) => {
    started = done;
  });
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  const abort = new AbortController();
  const pending = env.client
    .get("https://images.example/hold", {
      signal: abort.signal,
      authorization: { assertDestination() {} },
      bodySink: {
        maxBytes: 1000,
        async write() {
          started();
          await barrier;
        },
      },
    })
    .then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
  try {
    await writing;
    abort.abort();
    await Bun.sleep(50);
    expect(settled).toBe(false);
    release();
    expect(await pending).toMatchObject({ code: "CANCELLED" });
  } finally {
    release();
    await pending;
    await env.close();
  }
});
test("core streaming download verifies actual binary file, redirect, path, type, SHA-256 and progress", async () => {
  const env = await environment();
  try {
    const before = await readdir(env.root);
    let published = false;
    env.events.subscribe(async (event) => {
      if (
        event.type !== "tool_progress" ||
        !(await Bun.file(join(env.root, "image.png")).exists())
      )
        return;
      const shell = await workspaceCoordinator.acquirePlanLease([
        { resource: env.root, mode: "write" },
      ]);
      try {
        expect((await readdir(env.root)).sort()).toEqual(
          [...before, "image.png"].sort(),
        );
        published = true;
      } finally {
        await shell.finish();
      }
    });
    const result = await env.download("/redirect");
    expect(result.isError, result.output).not.toBe(true);
    const saved = result.details!.web as Record<string, unknown>;
    expect(saved.path).toBe(
      await import("node:fs/promises").then((fs) =>
        fs.realpath(join(env.root, "image.png")),
      ),
    );
    expect(await readFile(saved.path as string)).toEqual(image);
    expect(saved.bytes).toBe(image.length);
    expect(saved.contentType).toBe("image/png");
    expect(saved.sha256).toBe(createHash("sha256").update(image).digest("hex"));
    expect(saved.finalUrl).toBe("https://images.example/image");
    expect(result.output).not.toContain(image.toString("base64"));
    expect(
      (await readdir(env.root)).filter((name) => name.endsWith(".download")),
    ).toEqual([]);
    await env.received;
    expect(published).toBe(true);
  } finally {
    await env.close();
  }
});
test("encoded downloads verify the decoded file and do not claim compressed wire length as saved-file progress", async () => {
  const env = await environment();
  try {
    const chunks: Buffer[] = [];
    let total: number | undefined;
    const response = await env.client.get("https://images.example/gzip", {
      authorization: { assertDestination() {} },
      bodySink: {
        maxBytes: 1000,
        start(value) {
          total = value;
        },
        async write(chunk) {
          chunks.push(chunk);
        },
      },
    });
    expect(total).toBeUndefined();
    expect(Buffer.concat(chunks)).toEqual(image);
    expect(response.bytes.length).toBe(0);
    const download = await env.download("/gzip");
    expect(download.isError, download.output).not.toBe(true);
    expect(await readFile(join(env.root, "image.png"))).toEqual(image);
    expect(download.details!.web).toMatchObject({
      bytes: image.length,
      sha256: createHash("sha256").update(image).digest("hex"),
    });
  } finally {
    await env.close();
  }
});
test("429 retries honor Retry-After and a shared deadline; persistent errors stop after bounded attempts", async () => {
  const env = await environment();
  try {
    expect((await env.download("/retry")).isError).not.toBe(true);
    expect(env.counts.get("/retry")).toBe(3);
    const start = Date.now();
    expect(
      (await env.download("/retry-after", { path: "second.png" })).isError,
    ).not.toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(950);
    const refused = await env.download("/refused", { path: "third.png" });
    expect(refused.errorCode).toBe("WEB_RATE_LIMITED");
    expect(refused.output).toContain("другой источник");
    expect(env.counts.get("/refused")).toBe(1);
    expect(
      (await env.download("/error", { path: "third.png" })).errorCode,
    ).toBe("WEB_HTTP_ERROR");
    expect(env.counts.get("/error")).toBe(3);
  } finally {
    await env.close();
  }
}, 10000);
test("existing files, interrupted responses, excessive bytes and unsafe redirects preserve the original and clean staging", async () => {
  const env = await environment();
  try {
    const path = join(env.root, "image.png");
    await writeFile(path, "old");
    expect((await env.download("/image")).errorCode).toBe("WEB_TARGET_EXISTS");
    expect(env.counts.get("/image")).toBeUndefined();
    for (const [route, expected] of [
      ["/broken", "WEB_PROTOCOL_ERROR"],
      ["/huge", "WEB_TOO_LARGE"],
      ["/private", "WEB_UNSAFE_ADDRESS"],
    ]) {
      const result = await env.download(route!, {
        overwrite: true,
        maxBytes: 100,
      });
      expect(result.errorCode, result.output).toBe(expected!);
      expect(await readFile(path, "utf8")).toBe("old");
      expect(
        (await readdir(env.root)).filter((name) => name.endsWith(".download")),
      ).toEqual([]);
    }
    expect(
      (await env.download("/image", { overwrite: true })).isError,
    ).not.toBe(true);
    expect(await readFile(path)).toEqual(image);
  } finally {
    await env.close();
  }
}, 10000);
test("cancellation and timeout clean partial files, and a slow network transfer holds no workspace-wide lease", async () => {
  for (const cancel of [true, false]) {
    const env = await environment({ timeout: cancel ? 5000 : 500 });
    try {
      const before = await readdir(env.root);
      const abort = new AbortController();
      const pending = env.download("/hold", {}, abort.signal);
      await env.received;
      expect(await readdir(env.root)).toEqual(before);
      const lease = await workspaceCoordinator.acquirePlanLease([
        { resource: env.root, mode: "write" },
      ]);
      await lease.finish();
      if (cancel) abort.abort();
      expect((await pending).errorCode).toBe(
        cancel ? "CANCELLED" : "WEB_TIMEOUT",
      );
      expect(
        (await readdir(env.root)).filter(
          (name) => name.endsWith(".download") || name === "image.png",
        ),
      ).toEqual([]);
    } finally {
      await env.close();
    }
  }
});
test("a competing write is fenced at publication; simultaneous downloads never clobber the winning file", async () => {
  const env = await environment();
  try {
    const path = join(env.root, "image.png");
    const pending = env.download("/hold");
    await env.received;
    await writeFile(path, "concurrent writer");
    env.finish();
    expect((await pending).errorCode).toBe("WEB_DOWNLOAD_CONFLICT");
    expect(await readFile(path, "utf8")).toBe("concurrent writer");
    await rm(path);
    const results = await Promise.all([
      env.download("/image"),
      env.download("/image"),
    ]);
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(await readFile(path)).toEqual(image);
  } finally {
    await env.close();
  }
});
test("Plan and network denies cannot write; allowing public fetch does not grant write permission", async () => {
  for (const options of [
    { mode: "plan" as const },
    { denied: true },
    { ask: true },
  ]) {
    const env = await environment(options);
    try {
      const result = await env.download("/image");
      if (options.ask) {
        expect(result.isError, result.output).not.toBe(true);
        expect(env.approvals).toHaveLength(1);
        expect(env.approvals[0]!.preview).toContain(
          join(env.root, "image.png"),
        );
      } else {
        expect(result.errorCode).toBe(
          options.denied ? "WEB_NETWORK_DENIED" : "MODE_RESTRICTION",
        );
        expect(env.counts.size).toBe(0);
      }
    } finally {
      await env.close();
    }
  }
});
test("readonly cannot download; coding can download in its root but cannot export to the user's Desktop", async () => {
  for (const child of ["readonly", "coding"] as const) {
    const env = await environment({ child });
    try {
      const result = await env.download("/image");
      if (child === "readonly") {
        expect(result.errorCode).toBe("PERMISSION_DENIED");
        expect(env.counts.size).toBe(0);
      } else {
        expect(result.isError, result.output).not.toBe(true);
        const external = await env.download("/image", {
          path: undefined,
          directory: "desktop",
          filename: "child-export.png",
        });
        expect(external.errorCode).toBe("PERMISSION_DENIED");
        expect(env.counts.get("/image")).toBe(1);
      }
    } finally {
      await env.close();
    }
  }
});

test("XDG localized and redirected folders are parsed as data; native OS queries return absolute destinations", async () => {
  expect(
    xdgUserFolder(
      'XDG_DESKTOP_DIR="$HOME/OneDrive/Рабочий стол"',
      "desktop",
      "/users/alice",
    ),
  ).toBe("/users/alice/OneDrive/Рабочий стол");
  expect(
    xdgUserFolder(
      'XDG_DOWNLOAD_DIR="/data/Загрузки"',
      "downloads",
      "/users/alice",
    ),
  ).toBe("/data/Загрузки");
  expect(() =>
    xdgUserFolder('XDG_DESKTOP_DIR="$(evil)"', "desktop", "/users/alice"),
  ).toThrow();
  expect(isAbsolute(await userFolder("desktop"))).toBe(true);
  expect(isAbsolute(await userFolder("downloads"))).toBe(true);
}, 12000); // Two bounded 5-second OS queries must fit within the test budget.
