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

/** Same ordinary CLI consumer through source, installed npm package and compiled binary. */
export async function smokeSideQueryCli(command: string, args: string[]) {
  const storage = await mkdtemp(join(tmpdir(), "chisel-btw-cli-"));
  const root = join(storage, "workspace");
  await mkdir(root);
  const configHome = process.platform === "win32" ? "ChiselCode" : "chiselcode";
  const providerRoot = join(storage, configHome, "providers");
  let attempts = 0;
  let responseMode = "success";
  let anthropic = false;
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      attempts++;
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      assert.equal((body.tools as unknown[] | undefined)?.length ?? 0, 0);
      assert.equal(body.model, "fixture-model");
      assert.ok(
        ((body.max_tokens as number | undefined) ??
          (body.max_completion_tokens as number)) <= 2048,
      );
      if (responseMode === "retry" && attempts < 3)
        return Response.json(
          {
            error: {
              type: "overloaded_error",
              message: "retry",
              code: "server_error",
            },
          },
          { status: 503 },
        );
      if (responseMode === "auth")
        return Response.json(
          {
            error: {
              type: "authentication_error",
              message: "authentication failed",
            },
          },
          { status: 401 },
        );
      const text =
        responseMode === "oversize"
          ? "Ж".repeat(40000)
          : "Отдельный ответ через настоящий protocol driver.";
      const oa = [
        {
          id: "s",
          choices: [
            { index: 0, delta: { content: text }, finish_reason: "stop" },
          ],
        },
        {
          id: "s",
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        },
      ];
      const anth = [
        {
          type: "message_start",
          message: {
            id: "s",
            type: "message",
            role: "assistant",
            model: "fixture-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 11, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 7 },
        },
        { type: "message_stop" },
      ];
      if (responseMode === "duplicate") {
        if (anthropic) anth.push({ type: "message_stop" });
        else if (oa[0]) oa.push(oa[0]);
      }
      if (responseMode === "partial") {
        if (anthropic) anth.splice(4);
        else if (oa[0]?.choices[0])
          oa[0].choices[0].finish_reason = null as unknown as string;
      }
      if (responseMode === "tool") {
        if (anthropic) {
          Object.assign(anth[1]?.content_block ?? {}, {
            type: "tool_use",
            id: "forbidden",
            name: "run_shell",
            input: {},
          });
          Object.assign(anth[2]?.delta ?? {}, {
            type: "input_json_delta",
            partial_json: '{"command":"must never execute"}',
          });
          Object.assign(anth[4]?.delta ?? {}, { stop_reason: "tool_use" });
        } else {
          Object.assign(oa[0]?.choices[0]?.delta ?? {}, {
            content: "",
            tool_calls: [
              {
                index: 0,
                id: "forbidden",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: '{"command":"must never execute"}',
                },
              },
            ],
          });
          if (oa[0]?.choices[0]) oa[0].choices[0].finish_reason = "tool_calls";
        }
      }
      const data =
        (anthropic ? anth : oa)
          .map(
            (event) =>
              `${anthropic ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
          )
          .join("") + (anthropic ? "" : "data: [DONE]\n\n");
      return new Response(data, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: storage,
    XDG_DATA_HOME: storage,
    APPDATA: storage,
    LOCALAPPDATA: storage,
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  };
  try {
    await mkdir(providerRoot, { recursive: true });
    for (const protocol of ["openai-chat", "anthropic-messages"]) {
      const provider = join(providerRoot, protocol);
      await mkdir(provider);
      await writeFile(
        join(provider, "provider.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: `fixture/${protocol}`,
          label: "Offline no-auth provider",
          driver: protocol,
          auth: { required: false, envVars: [] },
          endpoint: {
            required: true,
            normalization:
              protocol === "openai-chat" ? "openai-v1" : "anthropic-root",
          },
          defaults: { model: "fixture-model" },
          capabilities: {
            modelListing: false,
            tokenCounting: "unsupported",
            usageReporting: "stream",
            toolCalling: true,
            thinking: false,
          },
        }),
      );
    }
    const configDir =
      process.platform === "win32"
        ? join(storage, "chiselcode")
        : join(storage, "chiselcode");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({
        schemaVersion: 2,
        defaultProfileId: "oa",
        profiles: {
          oa: {
            providerId: "fixture/openai-chat",
            defaultModel: "fixture-model",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
          },
          anth: {
            providerId: "fixture/anthropic-messages",
            defaultModel: "fixture-model",
            baseUrl: `http://127.0.0.1:${server.port}`,
          },
        },
        lsp: { mode: "off", servers: {} },
      }),
    );
    for (const protocol of ["oa", "anth"]) {
      anthropic = protocol === "anth";
      for (const mode of [
        "success",
        "retry",
        "auth",
        "partial",
        "duplicate",
        "tool",
        "oversize",
      ]) {
        attempts = 0;
        responseMode = mode;
        const result = await execa(
          command,
          [
            ...args,
            "--cwd",
            root,
            "--profile",
            protocol,
            "--json",
            "/btw Что происходит?",
          ],
          { env, reject: false, timeout: 20000 },
        );
        const output = JSON.parse(result.stdout);
        assert.equal(output.owner.extensionId, "builtin.btw");
        assert.equal(
          output.status,
          mode === "success" || mode === "retry"
            ? "completed"
            : mode === "oversize"
              ? "truncated"
              : "failed",
          `${protocol}/${mode}: ${result.stdout}\n${result.stderr}`,
        );
        assert.equal(
          attempts,
          mode === "retry" ? 3 : 1,
          "SDK/core retries multiplied or replayed text",
        );
        if (mode === "tool")
          assert.equal(output.error.code, "MODEL_REQUEST_TOOLS_UNSUPPORTED");
        if (mode === "oversize") {
          assert.ok(Buffer.byteLength(output.text, "utf8") <= 65536);
          assert.equal(output.error.code, "MODEL_REQUEST_TRUNCATED");
        }
        if (output.status === "completed") {
          assert.equal(output.usage.inputTokens, 11);
          assert.equal(output.usage.outputTokens, 7);
          assert.equal(output.cost.source, "unknown");
        }
      }
    }
    const before = attempts;
    const empty = await execa(
      command,
      [...args, "--cwd", root, "--json", "/btw"],
      { env, reject: false },
    );
    assert.notEqual(empty.exitCode, 0);
    assert.equal(attempts, before);
    const sessionRoot = join(storage, configHome, "sessions", "projects");
    for (const project of await readdir(sessionRoot)) {
      for (const file of await readdir(join(sessionRoot, project))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
        const saved = JSON.parse(
          await readFile(join(sessionRoot, project, file), "utf8"),
        );
        assert.deepEqual(saved.messages, []);
        assert.equal(saved.sideQueries.length, 1);
        assert.equal(saved.schemaVersion, 3);
      }
    }
    assert.ok(bodies.length >= 10);
    process.stdout.write(
      "Side query CLI: real OpenAI/Anthropic, no-auth custom providers, three HTTP attempts, partial/protocol/auth failures and durable isolated records passed\n",
    );
  } finally {
    server.stop(true);
    await rm(storage, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (!command)
    throw new Error("Specify a CLI executable and optional leading arguments.");
  await smokeSideQueryCli(command, args);
}
