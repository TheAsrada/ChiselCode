import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

/** Offline real-process harness shared by source, installed-package and compiled-CLI smoke. */
export async function smokeManifestCli(
  command: string,
  args: string[],
  malformedStream = false,
) {
  const root = await mkdtemp(join(tmpdir(), "chisel-manifest-smoke-"));
  let calls = 0;
  let failure: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        if (new URL(request.url).pathname.endsWith("/models"))
          return Response.json({
            data: [
              {
                id: "fixture-manifest-model",
                context_window: 65536,
                max_output_tokens: 2048,
              },
            ],
          });
        const body = (await request.json()) as {
          tools?: { function: { name: string } }[];
          messages: {
            role: string;
            name?: string;
            content?: string;
            tool_calls?: { function: { name: string } }[];
          }[];
        };
        const tool = body.tools?.find((tool) =>
          tool.function.name.startsWith("ext_ext_builtin_project_manifest_"),
        );
        if (!tool)
          throw new Error(
            "Default manifest contribution is absent from model schemas.",
          );
        const first = calls++ === 0;
        if (!first) {
          const result = body.messages.find(
            (message) => message.role === "tool",
          );
          if (
            !result?.content?.includes("fixture-manifest-acceptance") ||
            !result.content.includes("package.json")
          )
            throw new Error(
              "Manifest result did not reach the real provider adapter.",
            );
          if (
            !body.messages.some((message) =>
              message.tool_calls?.some(
                (call) => call.function.name === tool.function.name,
              ),
            )
          )
            throw new Error(
              "Canonical contribution tool history was not mapped for the provider.",
            );
        }
        const chunk = {
          id: "fixture",
          object: "chat.completion.chunk",
          model: "fixture-manifest-model",
          choices: [
            {
              index: 0,
              delta: first
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: "manifest-acceptance",
                        type: "function",
                        function: { name: tool.function.name, arguments: "{}" },
                      },
                    ],
                  }
                : { content: "Manifest contribution verified" },
              finish_reason: null,
            },
          ],
        };
        const records = [
          { type: "ping" },
          chunk,
          ...(malformedStream
            ? [{ choices: [{ delta: { tool_calls: [null] } }] }]
            : []),
          {
            choices: [
              { index: 0, finish_reason: first ? "tool_calls" : "stop" },
            ],
          },
          { usage: { prompt_tokens: 19, completion_tokens: 7 } },
        ];
        return new Response(
          `${records
            .map((record) => `data: ${JSON.stringify(record)}\n\n`)
            .join("")}data: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      } catch (error) {
        failure = error;
        return Response.json(
          { error: { message: "Fixture validation failed" } },
          { status: 400 },
        );
      }
    },
  });
  try {
    await mkdir(join(root, "chiselcode"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      '{"name":"fixture-manifest-acceptance"}\n',
    );
    await writeFile(
      join(root, "chiselcode", "config.json"),
      JSON.stringify({
        schemaVersion: 2,
        web: { enabled: false },
        defaultProfileId: "fixture",
        profiles: {
          fixture: {
            providerId: "openai-compatible",
            defaultModel: "fixture-manifest-model",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
          },
        },
      }),
    );
    const result = await execa(
      command,
      [
        ...args,
        "--cwd",
        root,
        "--mode",
        "plan",
        "--json",
        "Inspect the root project manifests",
      ],
      {
        reject: false,
        timeout: 30000,
        env: {
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          APPDATA: root,
          LOCALAPPDATA: root,
          OPENAI_API_KEY: "fixture-offline-key",
        },
      },
    );
    if (failure) throw failure;
    if (!malformedStream && result.exitCode !== 0)
      throw new Error(
        `Manifest CLI smoke failed (${result.exitCode}): ${result.stderr}`,
      );
    const output = JSON.parse(result.stdout);
    if (malformedStream) {
      assert.notEqual(result.exitCode, 0);
      assert.equal(output.status, "failed");
      assert.equal(output.errorCode, "transport");
      assert.match(
        output.error,
        /Некорректное событие OpenAI Chat Completions/,
      );
      assert.equal(
        calls,
        1,
        "Malformed streams must not replay a model/tool request",
      );
    } else if (
      output.status !== "completed" ||
      output.text !== "Manifest contribution verified" ||
      calls !== 2
    )
      throw new Error(
        "Manifest CLI smoke did not complete the full model/tool/model cycle.",
      );
    const home =
      process.platform === "win32"
        ? join(root, "ChiselCode")
        : join(root, "chiselcode");
    const projects = join(home, "sessions", "projects");
    let persisted = false;
    for (const directory of await readdir(projects)) {
      const sessionFile = join(projects, directory, `${output.sessionId}.json`);
      try {
        const session = JSON.parse(await readFile(sessionFile, "utf8"));
        if (malformedStream) {
          assert.deepEqual(Object.keys(session.runtime?.invocations ?? {}), []);
          assert.equal(session.messages.length, 1);
          assert.equal(session.requestTimings.at(-1).error.code, "transport");
          persisted = true;
          continue;
        }
        const invocation = session.runtime.invocations["manifest-acceptance"];
        if (
          invocation.name !== "ext:builtin.project:manifest" ||
          invocation.state !== "succeeded" ||
          invocation.toolSource?.type !== "extension" ||
          invocation.toolSource.extensionId !== "builtin.project" ||
          invocation.result.details.extension.tool !== "manifest"
        )
          throw new Error("Manifest checkpoint lost extension attribution.");
        persisted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!persisted)
      throw new Error("No actual persisted contribution checkpoint.");
    if (malformedStream) return { calls, status: output.status };
    return {
      calls,
      canonicalName: "ext:builtin.project:manifest",
      status: output.status,
    };
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (!command)
    throw new Error(
      "Usage: bun tests/fixtures/manifest-cli.ts <CLI command> [entry path]",
    );
  const malformed = args.includes("--malformed-stream");
  await smokeManifestCli(
    command,
    args.filter((arg) => arg !== "--malformed-stream"),
    malformed,
  );
  process.stdout.write(
    malformed
      ? "Malformed stream smoke: OK (typed failure, no tools/replay, durable reason)\n"
      : "Manifest contribution smoke: OK (gateway SSE → tool → model → persisted source)\n",
  );
}
