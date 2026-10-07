import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withExtensionWorkspace } from "../../src/extensions/composition.js";
import type { ExtensionContext } from "../../src/extensions/contracts.js";
import { canonicalWorkspaceRoot } from "../../src/extensions/host.js";
import {
  createServiceToken,
  ExtensionHost,
  ServiceRegistry,
} from "../../src/extensions/index.js";
import { ExtensionLifecycleError } from "../../src/extensions/lifecycle.js";

const roots: string[] = [];
const hosts: ExtensionHost[] = [];
afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const path = await canonicalWorkspaceRoot(
    await mkdtemp(join(tmpdir(), "chisel-extensions-")),
  );
  roots.push(path);
  return path;
}
function host(definitions: ConstructorParameters<typeof ExtensionHost>[0]) {
  const value = new ExtensionHost(definitions);
  hosts.push(value);
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("service tokens carry unique identity and invariant types; missing/duplicate services are explicit", () => {
  const a = createServiceToken<{ value: number }>("counter");
  const sameName = createServiceToken<{ value: number }>("counter");
  const otherType = createServiceToken<{ value: string }>("counter");
  const registry = new ServiceRegistry();
  const value = { value: 2 };
  const registration = registry.provide(a, value);
  expect(registry.get(a)).toBe(value);
  expect(registry.lookup(sameName)).toBeUndefined();
  expect(() => registry.get(sameName)).toThrow(
    "Required service counter is missing",
  );
  expect(() => registry.provide(a, value)).toThrow("already registered");
  // @ts-expect-error Different contracts cannot share a typed token.
  const wrong: typeof a = otherType;
  expect(wrong.key).not.toBe(a.key);
  // @ts-expect-error Token T is invariant, including related types.
  const covariant: import("../../src/extensions/index.js").ServiceToken<object> =
    a;
  expect(covariant.key).toBe(a.key);
  registration.dispose();
  expect(registry.lookup(a)).toBeUndefined();
  registry.dispose();
  expect(() => registry.lookup(a)).toThrow("closed");
});

test("parent lookup rejects shadowing; child registrations/cleanup never own parent services", () => {
  const token = createServiceToken<{ dispose(): void }>("parent");
  const local = createServiceToken<number>("child");
  let disposed = 0;
  const parent = new ServiceRegistry();
  const service = {
    dispose: () => {
      disposed++;
    },
  };
  parent.provide(token, service);
  const child = parent.child();
  child.provide(local, 3);
  expect(() => parent.provide(local, 5)).toThrow("shadowing");
  expect(child.get(token)).toBe(service);
  expect(() => child.provide(token, service)).toThrow("shadowing");
  child.dispose();
  expect(parent.get(token)).toBe(service);
  expect(disposed).toBe(0);
  const survivingChild = parent.child();
  survivingChild.provide(local, 4);
  parent.dispose();
  expect(() => survivingChild.get(local)).toThrow("closed");
  expect(() => survivingChild.lookup(token)).toThrow("closed");
  expect(disposed).toBe(0);
});

test("duplicate extension IDs are rejected before activation", () => {
  let activated = 0;
  const extension = {
    id: "a",
    activate: () => {
      activated++;
    },
  };
  expect(() => new ExtensionHost([extension, extension])).toThrow(
    "Duplicate extension a",
  );
  expect(activated).toBe(0);
});

test("activation order makes services available; cleanup is reverse, explicit and concurrent-idempotent", async () => {
  const order: string[] = [];
  const token = createServiceToken<{ dispose(): void }>("shared");
  const unowned = createServiceToken<{ dispose(): void }>("unowned");
  let ctx!: ExtensionContext;
  const h = host([
    {
      id: "a",
      activate(context) {
        ctx = context;
        order.push("a");
        const service = {
          dispose: () => {
            order.push("service");
          },
        };
        context.add(service);
        context.services.provide(token, service);
        context.services.provide(unowned, {
          dispose: () => {
            throw new Error("not owned");
          },
        });
        context.add({
          dispose: () => {
            order.push("a-last");
          },
        });
      },
    },
    {
      id: "b",
      activate(context) {
        expect(context.services.get(token)).toBe(ctx.services.get(token));
        order.push("b");
        context.add({
          dispose: () => {
            order.push("b-first");
          },
        });
        context.add({
          dispose: () => {
            order.push("b-last");
          },
        });
      },
    },
  ]);
  const scope = await h.open(await root());
  expect(order).toEqual(["a", "b"]);
  expect(() => ctx.services.provide(createServiceToken("late"), {})).toThrow(
    "closed",
  );
  expect(() =>
    ctx.guards.beforeExecute(() => ({ action: "continue" })),
  ).toThrow("closed");
  expect(() =>
    ctx.contextProviders.register({ id: "late", collect: () => undefined }),
  ).toThrow("closed");
  expect(() => ctx.add({ dispose() {} })).toThrow("closed");
  const first = scope.dispose();
  expect(scope.dispose()).toBe(first);
  await Promise.all([first, scope.dispose()]);
  expect(order).toEqual(["a", "b", "b-last", "b-first", "a-last", "service"]);
  expect(scope.signal.aborted).toBe(true);
  expect(() => scope.services.get(token)).toThrow("closed");
  await h.dispose();
  expect(h.dispose()).toBe(h.dispose());
  await expect(h.open(scope.workspaceRoot)).rejects.toThrow("host is closed");
});

test("partial failure rolls back B then A, including registrations, while preserving cleanup failures", async () => {
  const order: string[] = [];
  const token = createServiceToken<number>("value");
  let a!: ExtensionContext;
  let b!: ExtensionContext;
  const cause = new Error("raw credential not serialized");
  const h = host([
    {
      id: "a",
      activate(ctx) {
        a = ctx;
        ctx.services.provide(token, 1);
        ctx.add({
          dispose: () => {
            order.push("a");
          },
        });
      },
    },
    {
      id: "b",
      activate(ctx) {
        b = ctx;
        ctx.add({
          dispose: () => {
            order.push("b-first");
          },
        });
        ctx.add({
          dispose: () => {
            order.push("b-error");
            throw cause;
          },
        });
        ctx.guards.afterPrepare(() => ({ action: "continue" }));
        ctx.contextProviders.register({
          id: "data",
          collect: () => ({ text: "data" }),
        });
        throw new Error("activation original");
      },
    },
  ]);
  const error = await h.open(await root()).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ExtensionLifecycleError);
  expect(error).toMatchObject({
    extensionId: "b",
    cleanupFailures: [{ extensionId: "b", phase: "cleanup" }],
  });
  expect((error as Error).cause).toBeInstanceOf(ExtensionLifecycleError);
  expect(JSON.stringify(error)).not.toContain("credential");
  expect(order).toEqual(["b-error", "b-first", "a"]);
  expect(() => a.services.get(token)).toThrow("closed");
  expect(() => b.guards.afterPrepare(() => ({ action: "continue" }))).toThrow(
    "closed",
  );
});

test("duplicate services/providers and missing required services cause attributed activation rollback", async () => {
  for (const operation of ["service", "provider", "missing"] as const) {
    const token = createServiceToken<number>("required");
    let cleanup = 0;
    const h = host([
      {
        id: "bad",
        activate(ctx) {
          ctx.add({
            dispose: () => {
              cleanup++;
            },
          });
          if (operation === "missing") ctx.services.get(token);
          else if (operation === "service") {
            ctx.services.provide(token, 1);
            ctx.services.provide(token, 2);
          } else {
            ctx.contextProviders.register({
              id: "same",
              collect: () => undefined,
            });
            ctx.contextProviders.register({
              id: "same",
              collect: () => undefined,
            });
          }
        },
      },
    ]);
    await expect(h.open(await root())).rejects.toMatchObject({
      extensionId: "bad",
    });
    expect(cleanup).toBe(1);
  }
});

test("concurrent opens and symlink/relative aliases activate once and publish only after success", async () => {
  const path = await root();
  const nested = join(path, "nested");
  const alias = join(path, "alias");
  await mkdir(nested);
  await symlink(
    nested,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const started = deferred<void>();
  const finish = deferred<void>();
  let activations = 0;
  const h = host([
    {
      id: "a",
      async activate() {
        activations++;
        started.resolve();
        await finish.promise;
      },
    },
  ]);
  let published = false;
  const one = h.open(nested).then((scope) => {
    published = true;
    return scope;
  });
  const two = h.open(join(path, "nested", "..", "alias"));
  await started.promise;
  expect(published).toBe(false);
  finish.resolve();
  expect(await one).toBe(await two);
  expect(activations).toBe(1);
});

test("failed open is retryable and other roots remain independent, including nested roots", async () => {
  const a = await root();
  const b = await root();
  const nested = join(b, "nested");
  await mkdir(nested);
  let fail = true;
  const token = createServiceToken<object>("unique");
  const h = host([
    {
      id: "a",
      activate(ctx) {
        ctx.services.provide(token, {});
        if (ctx.workspaceRoot === a && fail) throw new Error("retry");
      },
    },
  ]);
  const healthy = await h.open(b);
  await expect(h.open(a)).rejects.toThrow("activation failed");
  expect(await h.open(b)).toBe(healthy);
  fail = false;
  expect((await h.open(a)).services.get(token)).not.toBe(
    healthy.services.get(token),
  );
  expect((await h.open(nested)).services.get(token)).not.toBe(
    healthy.services.get(token),
  );
});

test("shutdown during unfinished activation rolls back and cannot publish a late result", async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  let ctx!: ExtensionContext;
  let disposed = 0;
  const h = host([
    {
      id: "slow",
      async activate(context) {
        ctx = context;
        context.add({
          dispose: () => {
            disposed++;
          },
        });
        started.resolve();
        await finish.promise;
      },
    },
  ]);
  const opened = h.open(await root()).catch((error: unknown) => error);
  await started.promise;
  const closing = h.dispose();
  expect(h.dispose()).toBe(closing);
  await closing;
  expect(await opened).toBeInstanceOf(ExtensionLifecycleError);
  expect(disposed).toBe(1);
  expect(ctx.signal.aborted).toBe(true);
  expect(() => ctx.services.provide(createServiceToken("late"), {})).toThrow(
    "closed",
  );
  finish.reject(new Error("late failure must be consumed"));
  await Promise.resolve();
});

test("prompt cancellation does not cancel borrowed activation or a different prompt", async () => {
  const path = await root();
  const started = deferred<void>();
  const finish = deferred<void>();
  let lifetime!: AbortSignal;
  const h = host([
    {
      id: "slow",
      async activate(ctx) {
        lifetime = ctx.signal;
        started.resolve();
        await finish.promise;
      },
    },
  ]);
  const abort = new AbortController();
  const cancelled = withExtensionWorkspace(
    path,
    { host: h },
    abort.signal,
    async () => {
      throw new Error("not called");
    },
  ).catch((error: unknown) => error);
  const other = withExtensionWorkspace(
    path,
    { host: h },
    undefined,
    async (scope) => scope,
  );
  await started.promise;
  abort.abort();
  expect(await cancelled).toMatchObject({ code: "CANCELLED" });
  expect(lifetime.aborted).toBe(false);
  finish.resolve();
  expect((await other).signal.aborted).toBe(false);
});

test("owned composition closes services on errors before runtime; borrowed scope survives and validates identity", async () => {
  const path = await root();
  let disposed = 0;
  const definitions = [
    {
      id: "a",
      activate(ctx: ExtensionContext) {
        ctx.add({
          dispose: () => {
            disposed++;
          },
        });
      },
    },
  ];
  await expect(
    withExtensionWorkspace(
      path,
      { extensions: definitions },
      undefined,
      async () => {
        throw new Error("config failed");
      },
    ),
  ).rejects.toThrow("config failed");
  expect(disposed).toBe(1);
  const h = host(definitions);
  const scope = await h.open(path);
  await withExtensionWorkspace(path, { scope }, undefined, async () => {});
  expect(disposed).toBe(1);
  await expect(
    withExtensionWorkspace(await root(), { scope }, undefined, async () => {}),
  ).rejects.toThrow("different workspace");
  await scope.dispose();
  expect(disposed).toBe(2);
});

test("cleanup errors do not replace the original operation error or skip later resources", async () => {
  const primary = new Error("primary run failed");
  let last = false;
  const error = await withExtensionWorkspace(
    await root(),
    {
      extensions: [
        {
          id: "a",
          activate(ctx) {
            ctx.add({
              dispose: () => {
                last = true;
              },
            });
            ctx.add({
              dispose: () => {
                throw new Error("cleanup failed");
              },
            });
          },
        },
      ],
    },
    undefined,
    async () => {
      throw primary;
    },
  ).catch((error: unknown) => error);
  expect(error).toMatchObject({ cleanupFailures: [{ extensionId: "a" }] });
  expect((error as Error).cause).toBe(primary);
  expect(last).toBe(true);
});

test("dispose reentry from lifetime listeners shares one promise and host waits for an already closing scope", async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  let disposed = 0;
  const h = host([
    {
      id: "a",
      activate(ctx) {
        ctx.add({
          async dispose() {
            disposed++;
            started.resolve();
            await finish.promise;
          },
        });
      },
    },
  ]);
  const path = await root();
  const scope = await h.open(path);
  let reentry: Promise<void> | undefined;
  scope.signal.addEventListener(
    "abort",
    () => {
      reentry = scope.dispose();
    },
    { once: true },
  );
  const closing = scope.dispose();
  expect(reentry).toBe(closing);
  await started.promise;
  await expect(h.open(path)).rejects.toThrow("not available");
  let hostClosed = false;
  const hostClosing = h.dispose().then(() => {
    hostClosed = true;
  });
  await Promise.resolve();
  expect(hostClosed).toBe(false);
  finish.resolve();
  await Promise.all([closing, hostClosing]);
  expect(disposed).toBe(1);
});

test("cleanup continues across workspaces and duplicate resource ownership is rejected", async () => {
  const paths = [await root(), await root()];
  const closed: string[] = [];
  const h = host([
    {
      id: "a",
      activate(ctx) {
        ctx.add({
          dispose() {
            closed.push(ctx.workspaceRoot);
            throw new Error("unsafe raw cleanup message");
          },
        });
      },
    },
  ]);
  for (const path of paths) await h.open(path);
  const result = await h.dispose().catch((error: unknown) => error);
  expect(result).toMatchObject({
    cleanupFailures: [{ extensionId: "a" }, { extensionId: "a" }],
  });
  expect((result as Error).message).toContain("a");
  expect(closed).toEqual([...paths].reverse());
  expect(JSON.stringify(result)).not.toContain("unsafe raw cleanup");
  let once = 0;
  const duplicate = host([
    {
      id: "duplicate",
      activate(ctx) {
        const resource = {
          dispose() {
            once++;
          },
        };
        ctx.add(resource);
        ctx.add(resource);
      },
    },
  ]);
  await expect(duplicate.open(await root())).rejects.toMatchObject({
    extensionId: "duplicate",
  });
  expect(once).toBe(1);
});
