import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { execa } from "execa";

/** Ordinary CLI uses a user-configured HTTP proxy; no production test flag or transport injection. */
export async function smokeWebDownloadCli(command: string, prefix: string[]) {
  const storage = await mkdtemp(join(tmpdir(), "chisel-web-cli-"));
  const root = join(storage, "project with spaces");
  await mkdir(root);
  const bytes = Buffer.from("core streaming file via a trusted local proxy\n");
  let tunnels = 0,
    verified = false;
  const sockets = new Set<Duplex>();
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    assert.equal(request.url, "93.184.216.34:80");
    tunnels++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let headers = "";
    socket.on("data", (part) => {
      headers += part.toString();
      if (!headers.includes("\r\n\r\n")) return;
      assert.match(headers, /^GET \/image\.bin HTTP\/1\.1/);
      socket.end(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`,
          ),
          bytes,
        ]),
      );
    });
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.url.endsWith("/models"))
        return Response.json({
          data: [
            {
              id: "fixture-model",
              context_window: 131072,
              max_output_tokens: 4096,
            },
          ],
        });
      const body = (await request.json()) as {
        messages: Array<{ role: string; content: unknown }>;
        tools: Array<{ function: { name: string } }>;
      };
      assert.ok(
        body.tools.some((tool) => tool.function.name === "web_download"),
        "The shipped core must expose web_download",
      );
      const result = body.messages.find((message) => message.role === "tool");
      let delta: unknown;
      if (result) {
        const info = JSON.parse(String(result.content));
        assert.equal(info.path, join(await realpath(root), "image.bin"));
        assert.equal(info.bytes, bytes.length);
        assert.equal(
          info.sha256,
          createHash("sha256").update(bytes).digest("hex"),
        );
        verified = true;
        delta = {
          content:
            "Файл сохранён; фактический путь, размер и SHA-256 проверены.",
        };
      } else
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "download",
              type: "function",
              function: {
                name: "web_download",
                arguments: JSON.stringify({
                  url: "http://93.184.216.34/image.bin",
                  path: "image.bin",
                }),
              },
            },
          ],
        };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: result ? "stop" : "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const home = join(
    storage,
    process.platform === "win32" ? "ChiselCode" : "chiselcode",
  );
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: "fixture",
      profiles: {
        fixture: {
          providerId: "openai-compatible",
          defaultModel: "fixture-model",
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
        },
      },
      lsp: { mode: "off", servers: {} },
      web: { enabled: true },
    }),
  );
  try {
    const address = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const result = await execa(
      command,
      [
        ...prefix,
        "--cwd",
        root,
        "--json",
        "--allow",
        "web_download",
        "Скачай файл без shell и проверь сохранённый файл",
      ],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: storage,
          XDG_DATA_HOME: storage,
          APPDATA: storage,
          LOCALAPPDATA: storage,
          OPENAI_API_KEY: "fixture-local-model",
          HTTP_PROXY: address,
          http_proxy: address,
          HTTPS_PROXY: address,
          https_proxy: address,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
        reject: false,
        timeout: 45000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(verified, result.stdout);
    assert.equal(tunnels, 1);
    assert.deepEqual(await readFile(join(root, "image.bin")), bytes);
    console.log(
      "Web download CLI: shipped core, public address checks, trusted proxy, streaming file and verified SHA-256 passed",
    );
  } finally {
    model.stop(true);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => proxy.close(() => done()));
    await rm(storage, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [command, ...prefix] = process.argv.slice(2);
  if (!command) throw new Error("Укажите обычный CLI или compiled binary.");
  await smokeWebDownloadCli(command, prefix);
}
