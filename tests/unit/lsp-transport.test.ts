import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import {
  type LspClock,
  LspFrameGuard,
  LspTransport,
} from "../../src/lsp/transport.js";
import { installedLsp } from "../fixtures/lsp-runtime.js";

const roots: string[] = [];
const transports: LspTransport[] = [];
afterEach(async () => {
  await Promise.all(
    transports.splice(0).map((transport) => transport.dispose()),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  control: Record<string, unknown> = {},
  timers?: LspClock,
) {
  const root = await mkdtemp(join(tmpdir(), "chisel-lsp-peer-"));
  roots.push(root);
  await writeFile(join(root, "peer.json"), JSON.stringify(control));
  const installed = await installedLsp();
  let failures = 0;
  const transport = new LspTransport(
    root,
    {
      id: "peer",
      ...installed,
      args: [join(import.meta.dir, "../fixtures/lsp-server.mjs")],
      fingerprint: "fixture",
      serverVersion: "fixture",
      typescriptVersion: "fixture",
    },
    () => {
      ++failures;
    },
    timers,
  );
  transports.push(transport);
  await transport.request("initialize", {});
  await transport.notification("initialized", {});
  return { root, transport, failures: () => failures };
}
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Protocol fixture did not settle within its bound.");
}
test("Content-Length guard accepts byte fragments/coalesced UTF-8 and rejects malformed/large/incomplete frames", async () => {
  const body = Buffer.from(JSON.stringify({ message: "😀 кириллица" }));
  const bytes = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
  const guard = new LspFrameGuard();
  const chunks: Buffer[] = [];
  guard.on("data", (chunk) => chunks.push(chunk));
  for (const byte of bytes) guard.write(Buffer.from([byte]));
  guard.end(Buffer.concat([bytes, bytes]));
  await finished(guard);
  expect(Buffer.concat(chunks)).toEqual(Buffer.concat([bytes, bytes, bytes]));
  for (const invalid of [
    "Content-Length: 9000000\r\n\r\n",
    "Content-Length: 1\r\nContent-Length: 1\r\n\r\nx",
    "Content-Length: 4\r\n\r\nx",
    "header".repeat(1400),
  ]) {
    const stream = new LspFrameGuard();
    stream.resume();
    const done = finished(stream);
    stream.end(invalid);
    await expect(done).rejects.toMatchObject({ code: "LSP_PROTOCOL_ERROR" });
  }
});
test("official JSON-RPC correlation, sanitized server requests and minimal environment", async () => {
  const { root, transport, failures } = await fixture();
  expect(
    await Promise.all([
      transport.request("fixture/echo", "😀"),
      transport.request("fixture/echo", { b: 2 }),
    ]),
  ).toEqual(["😀", { b: 2 }]);
  const env = await transport.request<Record<string, string>>(
    "fixture/env",
    {},
  );
  expect(env).not.toHaveProperty("OPENAI_API_KEY");
  expect(env).not.toHaveProperty("NODE_OPTIONS");
  expect(env.NODE_ENV).toBe("production");
  await transport.request("fixture/serverRequests", {});
  await until(async () =>
    (await readFile(join(root, "peer.log"), "utf8")).includes(
      '"server-unknown","error"',
    ),
  );
  const log = (await readFile(join(root, "peer.log"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(
    log.find((item) => item.id === "server-config" && "result" in item).result,
  ).toEqual([{}]);
  expect(
    log.find((item) => item.id === "server-edit" && "result" in item).result
      .applied,
  ).toBe(false);
  expect(
    log.find((item) => item.id === "server-unknown" && "error" in item).error
      .code,
  ).toBe(-32601);
  expect(failures()).toBe(0);
});
test("cancel/timeout free pending slots, notify the server, ignore late responses, and keep siblings connected", async () => {
  const { root, transport } = await fixture();
  const abort = new AbortController();
  const first = transport
    .request("fixture/delay", {}, abort.signal)
    .catch((error: unknown) => error);
  const sibling = transport.request("fixture/echo", "sibling");
  abort.abort();
  expect(await first).toMatchObject({ code: "CANCELLED" });
  expect(await sibling).toBe("sibling");
  const pending = Array.from({ length: 32 }, () =>
    transport
      .request("fixture/hang", {}, undefined, 80)
      .catch((error: unknown) => error),
  );
  await expect(transport.request("fixture/hang", {})).rejects.toMatchObject({
    code: "LSP_UNAVAILABLE",
  });
  expect(
    (await Promise.all(pending)).every(
      (error) => (error as { code: string }).code === "TOOL_TIMEOUT",
    ),
  ).toBe(true);
  await Bun.sleep(90);
  expect(await transport.request<string>("fixture/echo", "still alive")).toBe(
    "still alive",
  );
  expect(await readFile(join(root, "peer.log"), "utf8")).toContain(
    "$/cancelRequest",
  );
});
for (const method of [
  "fixture/oversize",
  "fixture/malformed",
  "fixture/EOF",
  "fixture/crash",
])
  test(`${method} fences pending operations and cleans the generation`, async () => {
    const { transport, failures } = await fixture();
    await expect(transport.request(method, {})).rejects.toMatchObject({
      code: "LSP_UNAVAILABLE",
    });
    await transport.dispose();
    expect(failures()).toBe(1);
    await expect(transport.request("fixture/echo", {})).rejects.toMatchObject({
      code: "LSP_UNAVAILABLE",
    });
  });
test("injected request deadline cancels its waiter without terminating the shared transport", async () => {
  let deadline: (() => void) | undefined;
  const timers: LspClock = {
    setTimeout(callback, milliseconds) {
      if (milliseconds === 1234) deadline = callback;
      return setTimeout(callback, milliseconds);
    },
    clearTimeout,
  };
  const { root, transport, failures } = await fixture({}, timers);
  const pending = transport
    .request("fixture/hang", {}, undefined, 1234)
    .catch((error: unknown) => error);
  await until(async () =>
    (await readFile(join(root, "peer.log"), "utf8")).includes("fixture/hang"),
  );
  expect(deadline).toBeDefined();
  deadline?.();
  expect(await pending).toMatchObject({ code: "TOOL_TIMEOUT" });
  expect(
    await transport.request<string>("fixture/echo", "sibling survives"),
  ).toBe("sibling survives");
  expect(failures()).toBe(0);
});
for (const crashed of [false, true])
  test(`${crashed ? "crash" : "shutdown"} closes descendants as well as the parent; dispose is shared/idempotent`, async () => {
    const { root, transport } = await fixture({ children: true });
    await until(async () => {
      try {
        return (
          (await readFile(join(root, "peer-pids.json"), "utf8")).length > 0
        );
      } catch {
        return false;
      }
    });
    const pids: number[] = JSON.parse(
      await readFile(join(root, "peer-pids.json"), "utf8"),
    );
    if (crashed)
      await expect(
        transport.request("fixture/crash", {}),
      ).rejects.toMatchObject({ code: "LSP_UNAVAILABLE" });
    const a = transport.dispose();
    expect(transport.dispose() === a).toBe(true);
    await a;
    await until(async () =>
      (
        await Promise.all(
          pids.map(async (pid) => {
            try {
              process.kill(pid, 0);
              if (process.platform === "linux")
                return /\) Z /.test(
                  await readFile(`/proc/${pid}/stat`, "utf8"),
                );
              return false;
            } catch {
              return true;
            }
          }),
        )
      ).every(Boolean),
    );
  });
