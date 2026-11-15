import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTrial } from "../../evals/harness.js";
import { EvalTaskSchema } from "../../evals/task-schema.js";

const root = await mkdtemp(join(tmpdir(), "chisel-live-eval-test-"));
process.env.XDG_CONFIG_HOME = root;
process.env.XDG_DATA_HOME = join(root, "data");
process.env.APPDATA = root;
process.env.LOCALAPPDATA = join(root, "data");
process.env.OPENAI_API_KEY = "fixture-live-eval-key";
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.url.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "fixture-live",
            context_window: 131072,
            max_output_tokens: 4096,
          },
        ],
      });
    const body = (await request.json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    const completed = requests++ > 0;
    if (completed)
      assert.ok(
        body.messages.some(
          (m) => m.role === "tool" && m.content.includes(Bun.version),
        ),
      );
    const delta = completed
      ? { content: "Команда выполнена." }
      : {
          tool_calls: [
            {
              index: 0,
              id: "shell-live",
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({ command: "bun --version" }),
              },
            },
          ],
        };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: completed ? "stop" : "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
try {
  await mkdir(join(root, "chiselcode"));
  await writeFile(
    join(root, "chiselcode", "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      profiles: {
        fixture: {
          providerId: "openai-compatible",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
        },
      },
    }),
  );
  const result = await runTrial(
    EvalTaskSchema.parse({
      id: "live-shell-approval",
      fixture: "basic-app",
      prompt: "Выполни bun --version.",
      timeout: 20,
      graders: [{ type: "tool_result", tool: "run_shell" }],
      constraints: { forbidden_paths: ["**/*"] },
    }),
    1,
    "live",
    "fixture-live",
    "openai-compatible",
    "fixture",
  );
  assert.equal(
    result.status,
    "success",
    JSON.stringify({ error: result.error, checks: result.tests_after }),
  );
  assert.equal(result.metrics.tool_call_count, 1);
  assert.equal(requests, 2);
  console.log(
    "Live eval: real shell completed through production driver and executor",
  );
} finally {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
