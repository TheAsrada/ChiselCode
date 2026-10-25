import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import {
  listen,
  networkCertificates,
  startNetworkProxy,
} from "./network-proxy.js";
import {
  importedSkill,
  skillCommit,
  skillSourceHttp,
} from "./skill-source-http.js";

/** Real shipped CLI: normal HTTPS/TLS, public DNS, configured proxy and tool permissions. */
export async function smokeSkillInstallCli(command: string, prefix: string[]) {
  const storage = await mkdtemp(join(tmpdir(), "chisel-skill-cli-"));
  const root = join(storage, "project with spaces");
  await mkdir(root);
  const api = skillSourceHttp();
  const certificates = await networkCertificates();
  const certPath = resolve("tests/fixtures/network-tls/skill-origin.pem");
  const origin = createServer(
    { key: certificates.key, cert: await readFile(certPath) },
    api.handle,
  );
  const originPort = await listen(origin);
  const proxy = await startNetworkProxy({ destinationPort: originPort });
  let verified = false;
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
        body.tools.some((tool) => tool.function.name === "install_skill"),
      );
      const results = body.messages.filter(
        (message) => message.role === "tool",
      );
      let delta: unknown;
      if (results.length === 3) {
        const installed = JSON.parse(String(results[0]?.content));
        assert.equal(installed.status, "installed");
        assert.equal(installed.name, "ui-design");
        assert.equal(installed.origin.revision, skillCommit);
        assert.match(String(results[1]?.content), /Read references\/guide\.md/);
        assert.match(
          String(results[2]?.content),
          /preserve keyboard navigation/,
        );
        verified = true;
        delta = {
          content:
            "Навык установлен; инструкции и справочный файл доступны в этой же задаче.",
        };
      } else {
        assert.ok(results.length < 3);
        const call = [
          {
            name: "install_skill",
            input: {
              source:
                "npx skills add https://github.com/acme/repo --skill folder-name",
            },
          },
          { name: "load_skill", input: { name: "ui-design" } },
          {
            name: "load_skill",
            input: { name: "ui-design", path: "references/guide.md" },
          },
        ][results.length];
        assert.ok(call);
        delta = {
          tool_calls: [
            {
              index: 0,
              id: `skill-cli-${results.length}`,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.input),
              },
            },
          ],
        };
      }
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: verified ? "stop" : "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
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
    const result = await execa(
      command,
      [
        ...prefix,
        "--cwd",
        root,
        "--json",
        "--allow",
        "install_skill,load_skill",
        "Установи указанный навык и прочитай его справку для задачи",
      ],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: storage,
          XDG_DATA_HOME: storage,
          APPDATA: storage,
          LOCALAPPDATA: storage,
          OPENAI_API_KEY: "fixture-local-model",
          HTTP_PROXY: proxy.url,
          http_proxy: proxy.url,
          HTTPS_PROXY: proxy.url,
          https_proxy: proxy.url,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
          NODE_EXTRA_CA_CERTS: certPath,
        },
        reject: false,
        timeout: 45000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(verified, result.stdout);
    assert.ok(api.hits.length >= 5);
    assert.ok(
      proxy.requests.every(
        (request) =>
          request.target.endsWith(":443") && !request.target.startsWith("127."),
      ),
    );
    const target = join(home, "skills/user/ui-design");
    assert.deepEqual(await readFile(join(target, "SKILL.md")), importedSkill);
    assert.deepEqual(
      await readFile(join(target, "assets/pixel.bin")),
      Buffer.from([0, 255, 128, 13, 10]),
    );
    console.log(
      "Skill install CLI: shipped core, HTTPS/proxy, pinned snapshot, managed library and immediate reference loading passed",
    );
  } finally {
    model.stop(true);
    await proxy.close();
    origin.closeAllConnections();
    await new Promise<void>((done) => origin.close(() => done()));
    await rm(storage, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [command, ...prefix] = process.argv.slice(2);
  if (!command) throw new Error("Укажите обычный CLI или compiled binary.");
  await smokeSkillInstallCli(command, prefix);
}
