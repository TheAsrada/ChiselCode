import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { saveGlobalConfig } from "../../src/config/load.js";

test("CLI status/configure/test report JSON and sensible approval/safety exit codes without a model", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-cli-"));
  const run = (args: string[]) =>
    execa(
      process.execPath,
      [resolve("src/cli.ts"), "--cwd", root, "--json", ...args],
      {
        reject: false,
        env: {
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          APPDATA: root,
          LOCALAPPDATA: root,
          BRAVE_SEARCH_API_KEY: "",
        },
      },
    );
  try {
    const status = await run(["web", "status"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).localAddresses).toBe("blocked");
    const pending = await run([
      "web",
      "test",
      "--url",
      "https://react.dev/reference",
    ]);
    expect(pending.exitCode).toBe(2);
    expect(JSON.parse(pending.stdout).status).toBe("approval_required");
    const unsafe = await run([
      "--allow",
      "web_fetch",
      "web",
      "test",
      "--url",
      "http://127.0.0.1/secret",
    ]);
    expect(unsafe.exitCode).toBe(1);
    expect(JSON.parse(unsafe.stdout).results[0].result.errorCode).toBe(
      "WEB_UNSAFE_ADDRESS",
    );
    const configured = await run([
      "web",
      "configure",
      "--fetch",
      "allow",
      "--allow-domain",
      "react.dev",
      "--key-env",
      "TEST_SEARCH_KEY",
    ]);
    expect(configured.exitCode).toBe(0);
    const next = JSON.parse((await run(["web", "status"])).stdout);
    expect(next.fetch.permission).toBe("allow");
    expect(next.search.configured).toBe(false);
    const invalid = await run(["web", "configure", "--fetch", "invalid"]);
    expect(invalid.exitCode).toBe(1);
    const disabled = await run(["web", "configure", "--disable"]);
    expect(disabled.exitCode).toBe(0);
    expect(JSON.parse((await run(["web", "status"])).stdout).enabled).toBe(
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("headless model-to-tool composition exposes native schemas and saves approval_required without granting internet", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-cli-agent-"));
  const requests: Record<string, unknown>[] = [];
  const key = "fixture-brave-key-not-in-transcript";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models"))
        return Response.json({
          data: [
            {
              id: "fixture-web-model",
              context_window: 32768,
              max_output_tokens: 2048,
            },
          ],
        });
      requests.push((await request.json()) as Record<string, unknown>);
      const chunk = {
        id: "fixture-response",
        object: "chat.completion.chunk",
        model: "fixture-web-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "web-call",
                  type: "function",
                  function: {
                    name: "web_fetch",
                    arguments:
                      '{"url":"https://react.dev/reference/rsc/server-functions"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    await mkdir(join(root, "chiselcode"), { recursive: true });
    await saveGlobalConfig(
      {
        schemaVersion: 2,
        defaultProfileId: "fixture",
        profiles: {
          fixture: {
            providerId: "openai-compatible",
            defaultModel: "fixture-web-model",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
          },
        },
      },
      join(root, "chiselcode", "config.json"),
    );
    const result = await execa(
      process.execPath,
      [
        resolve("src/cli.ts"),
        "--cwd",
        root,
        "--mode",
        "plan",
        "--json",
        "Find official docs",
      ],
      {
        reject: false,
        env: {
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          APPDATA: root,
          LOCALAPPDATA: root,
          OPENAI_API_KEY: "fixture-llm-key",
          BRAVE_SEARCH_API_KEY: key,
        },
      },
    );
    expect(result.exitCode).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.status).toBe("approval_required");
    expect(output.pendingApproval.preview).toContain(
      "https://react.dev/reference/rsc/server-functions",
    );
    expect(JSON.stringify(requests)).toContain('"name":"web_fetch"');
    expect(JSON.stringify(requests)).toContain('"name":"web_search"');
    expect(JSON.stringify(requests)).not.toContain(key);
    expect(JSON.stringify(requests)).not.toContain('"name":"edit_file"');
    const projects = JSON.parse(
      await readFile(
        join(root, "chiselcode", "sessions", "projects.json"),
        "utf8",
      ),
    );
    const session = await readFile(
      join(
        root,
        "chiselcode",
        "sessions",
        "projects",
        projects.projects[0].id,
        `${output.sessionId}.json`,
      ),
      "utf8",
    );
    expect(session).not.toContain(key);
    expect(JSON.parse(session).runtime.invocations["web-call"].state).toBe(
      "awaiting_approval",
    );
    expect(
      JSON.parse(session).runtime.invocations["web-call"].toolSource.type,
    ).toBe("web");
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
