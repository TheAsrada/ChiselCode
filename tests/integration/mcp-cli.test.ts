import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "chisel-mcp-cli-"));
  roots.push(root);
  return root;
}
async function cli(root: string, args: string[]) {
  const child = Bun.spawn(
    [process.execPath, resolve("src/cli.ts"), "--cwd", root, ...args, "--json"],
    {
      env: { ...process.env, XDG_CONFIG_HOME: root, APPDATA: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code, value: JSON.parse(out.trim()) };
}
// Each lifecycle scenario starts several real CLI/stdio processes; bound the whole flow,
// rather than applying Bun's five-second unit-test default to every launch together.
test("MCP CLI list/add/info/tools/doctor/enable/disable/remove is usable without TUI", async () => {
  const root = await setup();
  expect((await cli(root, ["mcp", "list"])).value).toEqual({ servers: [] });
  const command = `"${process.execPath}" "${resolve("tests/fixtures/mcp-server.ts")}"`;
  expect(
    (await cli(root, ["mcp", "add", "fixture", "--command", command])).code,
  ).toBe(0);
  const info = await cli(root, ["mcp", "info", "fixture"]);
  expect(info.value.config.transport.args).toEqual([
    resolve("tests/fixtures/mcp-server.ts"),
  ]);
  expect(info.value.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (await cli(root, ["mcp", "tools", "fixture"])).value.tools.some(
      (tool: { name: string }) => tool.name === "fixture.get_note",
    ),
  ).toBe(true);
  const doctor = await cli(root, ["mcp", "doctor", "fixture"]);
  expect(doctor.code).toBe(0);
  expect(
    doctor.value.servers[0].checks.some(
      (check: { name: string }) => check.name === "protocol",
    ),
  ).toBe(true);
  expect(
    (await cli(root, ["mcp", "disable", "fixture"])).value.server.state,
  ).toBe("disabled");
  expect((await cli(root, ["mcp", "enable", "fixture"])).code).toBe(0);
  expect((await cli(root, ["mcp", "remove", "fixture"])).code).toBe(0);
  expect((await cli(root, ["mcp"])).value.servers).toEqual([]);
}, 30000);
test("MCP doctor nonzero exit codes and project trust are deterministic", async () => {
  const root = await setup();
  const command = `"${process.execPath}" "${resolve("tests/fixtures/mcp-server.ts")}"`;
  expect(
    (
      await cli(root, [
        "mcp",
        "add",
        "project",
        "--command",
        command,
        "--project",
      ])
    ).code,
  ).toBe(0);
  const blocked = await cli(root, ["mcp", "doctor"]);
  expect(blocked.code).toBe(2);
  expect(
    blocked.value.servers[0].checks.some(
      (check: { name: string }) => check.name === "trust",
    ),
  ).toBe(true);
  const info = await cli(root, ["mcp", "info", "project"]);
  expect(
    (
      await cli(root, [
        "mcp",
        "trust",
        "project",
        "--fingerprint",
        "0".repeat(64),
      ])
    ).code,
  ).toBe(1);
  expect(
    (
      await cli(root, [
        "mcp",
        "trust",
        "project",
        "--fingerprint",
        info.value.fingerprint,
      ])
    ).code,
  ).toBe(0);
  expect((await cli(root, ["mcp", "doctor", "project"])).code).toBe(0);
  expect((await cli(root, ["mcp", "info", "missing"])).code).toBe(1);
}, 30000);
test("CLI rejects credential literals without echoing them or writing config", async () => {
  const root = await setup();
  const path = join(root, "input.json");
  const secret = "never-echo-private-credential";
  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "stdio", command: "node", args: [] },
      env: { API_KEY: { literal: secret } },
    }),
  );
  const result = await cli(root, ["mcp", "add", "bad", "--config", path]);
  expect(result.code).toBe(1);
  expect(result.out + result.err).not.toContain(secret);
  expect((await cli(root, ["mcp", "list"])).value.servers).toHaveLength(0);
});
test("headless CLI completes a real MCP call with valid model wire names and no credential leakage", async () => {
  const root = await setup();
  const secret = "headless-mcp-credential-987654321";
  const requests: Array<{ tools: Array<{ function: { name: string } }> }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname.endsWith("/models"))
        return Response.json({ data: [{ id: "smoke-model" }] });
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);
      const tool = body.tools.find((item) =>
        item.function.name.startsWith("mcp_fixture_get_secret_echo_"),
      );
      const choice =
        requests.length === 1
          ? {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "remote-read",
                    type: "function",
                    function: { name: tool?.function.name, arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            }
          : {
              index: 0,
              delta: { content: `MCP done ${secret}` },
              finish_reason: "stop",
            };
      return new Response(
        `data: ${JSON.stringify({ id: "chat-smoke", object: "chat.completion.chunk", choices: [choice] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    await mkdir(join(root, "chiselcode"), { recursive: true });
    await writeFile(
      join(root, "AGENTS.md"),
      `Instructions with a private value: ${secret}`,
    );
    await writeFile(
      join(root, "chiselcode", "config.json"),
      JSON.stringify({
        schemaVersion: 2,
        defaultProfileId: "smoke",
        profiles: {
          smoke: {
            providerId: "openai-compatible",
            baseUrl: `${server.url}v1`,
            defaultModel: "smoke-model",
          },
        },
        mcp: {
          schemaVersion: 1,
          servers: {
            fixture: {
              transport: {
                type: "stdio",
                command: process.execPath,
                args: [resolve("tests/fixtures/mcp-server.ts")],
              },
              env: { API_TOKEN: { envRef: "MCP_SMOKE_SECRET" } },
              permissions: {
                categories: {
                  read: "allow",
                  write: "ask",
                  destructive: "ask",
                  unknown: "ask",
                },
              },
            },
          },
        },
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "--cwd",
        root,
        "--mode",
        "plan",
        "--json",
        "--no-pause",
        `Read MCP safely ${secret}`,
      ],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          APPDATA: root,
          LOCALAPPDATA: root,
          OPENAI_API_KEY: "fixture-provider-key",
          MCP_SMOKE_SECRET: secret,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out).status).toBe("completed");
    expect(JSON.parse(out).text).toContain("MCP done");
    expect(out + err).not.toContain(secret);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain(secret);
    for (const request of requests)
      for (const tool of request.tools)
        expect(tool.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    async function savedFiles(path: string): Promise<string[]> {
      const result: string[] = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const target = join(path, entry.name);
        if (entry.isDirectory()) result.push(...(await savedFiles(target)));
        else if (entry.name.endsWith(".json")) result.push(target);
      }
      return result;
    }
    const saved = await savedFiles(root);
    const sessions = saved.filter(
      (path) =>
        path.includes("sessions") &&
        !path.endsWith("index.json") &&
        !path.endsWith("project.json"),
    );
    expect(sessions.length).toBeGreaterThan(0);
    for (const path of sessions)
      expect(await readFile(path, "utf8")).not.toContain(secret);
    expect(
      (await Promise.all(sessions.map((path) => readFile(path, "utf8")))).join(
        "\n",
      ),
    ).toContain("fixture.get_secret_echo");
  } finally {
    server.stop(true);
  }
});
