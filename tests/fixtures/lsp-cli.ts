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
import { isAbsolute, join, resolve } from "node:path";
import { execa } from "execa";

/** Actual CLI + provider protocol + LSP + checkpoint; the model endpoint is local/scripted. */
export async function smokeLspCli(
  command: string,
  args: string[],
  language: "typescript" | "python" = "typescript",
) {
  const file = language === "python" ? "main.py" : "main.ts";
  const diagnosticCode =
    language === "python" ? "reportAssignmentType" : "2322";
  const executable =
    isAbsolute(command) || /[\\/]/.test(command) ? resolve(command) : command;
  const entryArgs = args[0] ? [resolve(args[0]), ...args.slice(1)] : [];
  const directory = await mkdtemp(join(tmpdir(), "chisel-lsp-cli-"));
  const root = join(directory, "project");
  await mkdir(root);
  const configDirectory = join(directory, "chiselcode");
  await mkdir(configDirectory);
  const configPath = join(configDirectory, "config.json");
  const requests: Record<string, unknown>[] = [];
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
                id: "fixture-lsp",
                context_window: 65536,
                max_output_tokens: 2048,
              },
            ],
          });
        const body = (await request.json()) as {
          tools?: { function: { name: string } }[];
          messages: {
            role: string;
            content?: string;
            tool_calls?: { function: { name: string } }[];
          }[];
        };
        requests.push(body);
        const tool = body.tools?.find((item) =>
          item.function.name.startsWith("ext_ext_builtin_lsp_diagnostics_"),
        );
        assert.ok(
          tool,
          "Ordinary built CLI omitted the configured LSP contribution",
        );
        const results = body.messages.filter(
          (message) => message.role === "tool",
        );
        const complete = results.some((message) =>
          message.content?.includes(diagnosticCode),
        );
        if (results.length) {
          const last = results.at(-1)?.content ?? "";
          assert.ok(!last.includes('"isError": true'), last);
          if (last.includes('"freshness": "current"'))
            assert.ok(last.includes("Server confirmed this document version."));
          else if (last.includes('"freshness": "observed"'))
            assert.ok(last.includes("версия анализа не подтверждена"));
          else
            assert.ok(
              last.includes('"freshness": "unavailable"') ||
                last.includes('"freshness": "pending"'),
              last,
            );
          if (language === "typescript") {
            assert.ok(
              body.messages.some(
                (message) =>
                  message.role === "user" &&
                  message.content?.includes(
                    "analysis version is not confirmed",
                  ),
              ),
              "Bounded request-only LSP context missing",
            );
          }
          assert.ok(
            !body.messages.some(
              (message) =>
                message.role === "system" &&
                message.content?.includes("LSP auto: ready"),
            ),
            "LSP context received system authority",
          );
        }
        assert.ok(
          requests.length <= 8,
          "Real diagnostics did not arrive within the attempt bound",
        );
        const chunk = {
          id: "fixture-lsp",
          object: "chat.completion.chunk",
          model: "fixture-lsp",
          choices: [
            {
              index: 0,
              delta: complete
                ? { content: "Real LSP contribution verified" }
                : {
                    tool_calls: [
                      {
                        index: 0,
                        id: `lsp-${requests.length}`,
                        type: "function",
                        function: {
                          name: tool.function.name,
                          arguments: JSON.stringify({ path: file }),
                        },
                      },
                    ],
                  },
              finish_reason: complete ? "stop" : "tool_calls",
            },
          ],
        };
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
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
    await writeFile(
      join(root, file),
      language === "python"
        ? 'value: int = "wrong"\n'
        : 'export const value: number = "wrong";\n',
    );
    await writeFile(
      join(root, "tsconfig.json"),
      '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
    );
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        web: { enabled: false },
        defaultProfileId: "fixture",
        profiles: {
          fixture: {
            providerId: "openai-compatible",
            defaultModel: "fixture-lsp",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
          },
        },
      }),
    );
    const result = await execa(
      executable,
      [
        ...entryArgs,
        "--cwd",
        root,
        "--mode",
        "plan",
        "--json",
        `Use Auto LSP to diagnose the saved ${language} file`,
      ],
      {
        cwd: root,
        reject: false,
        timeout: 120000,
        env: {
          XDG_CONFIG_HOME: directory,
          XDG_DATA_HOME: directory,
          APPDATA: directory,
          LOCALAPPDATA: directory,
          OPENAI_API_KEY: "fixture-local-endpoint-key",
        },
      },
    );
    if (failure) throw failure;
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    assert.equal(output.text, "Real LSP contribution verified");
    const projects = join(
      directory,
      process.platform === "win32" ? "ChiselCode" : "chiselcode",
      "sessions/projects",
    );
    let persisted = false;
    for (const folder of await readdir(projects)) {
      try {
        const session = JSON.parse(
          await readFile(
            join(projects, folder, `${output.sessionId}.json`),
            "utf8",
          ),
        );
        const invocations = Object.values(session.runtime.invocations) as {
          toolSource?: { extensionId: string };
          state: string;
          result: { details?: { lsp?: { generation: number } } };
        }[];
        assert.ok(
          invocations.some(
            (record) =>
              record.toolSource?.extensionId === "builtin.lsp" &&
              record.state === "succeeded" &&
              record.result.details?.lsp?.generation === 1,
          ),
        );
        assert.ok(
          !JSON.stringify(session.messages).includes("LSP auto: ready"),
        );
        persisted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    assert.ok(persisted);
    return {
      requests: requests.length,
      status: output.status,
      backend:
        language === "python"
          ? "Pyright 1.1.414 / Node 24.19.0"
          : "typescript-language-server 6.0.1 / TypeScript 6.0.3",
    };
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (!command)
    throw new Error(
      "Usage: bun tests/fixtures/lsp-cli.ts <CLI command> [entry path]",
    );
  process.stdout.write(`${JSON.stringify(await smokeLspCli(command, args))}\n`);
  process.stdout.write(
    `${JSON.stringify(await smokeLspCli(command, args, "python"))}\n`,
  );
}
