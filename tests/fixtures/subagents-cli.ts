import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export async function smokeSubagentCli(command: string, prefix: string[]) {
  const storage = await mkdtemp(join(tmpdir(), "chisel-child-cli-"));
  const root = join(storage, "project with spaces");
  await mkdir(root);
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: storage,
    XDG_DATA_HOME: storage,
    APPDATA: storage,
    LOCALAPPDATA: storage,
    OPENAI_API_KEY: "fixture-offline-child-key",
  };
  const git = async (...args: string[]) =>
    (
      await execa(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: root, env },
      )
    ).stdout;
  await git("init", "--initial-branch=main");
  await writeFile(join(root, "source.txt"), "base text\n");
  await git("add", "source.txt");
  await git("commit", "-m", "base");
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: Array<{ role: string; content: string }>;
        tools: Array<{ function: { name: string } }>;
      };
      assert.ok(
        String(body.messages[0]?.content).includes(
          "Поручение выполняется отдельным помощником.",
        ),
      );
      count++;
      let delta: unknown, finish: string;
      if (count === 1) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "read",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "source.txt" }),
              },
            },
          ],
        };
        finish = "tool_calls";
      } else if (count === 2) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "edit",
              type: "function",
              function: {
                name: "edit_file",
                arguments: JSON.stringify({
                  path: "source.txt",
                  old_str: "base text",
                  new_str: "isolated CLI result",
                }),
              },
            },
          ],
        };
        finish = "tool_calls";
      } else {
        delta = {
          content: "Результат помощника сохранён; тесты не запускались.",
        };
        finish = "stop";
      }
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 25, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    await mkdir(join(storage, "chiselcode"), { recursive: true });
    await writeFile(
      join(storage, "chiselcode", "config.json"),
      JSON.stringify({
        schemaVersion: 2,
        defaultProfileId: "fixture",
        profiles: {
          fixture: {
            providerId: "openai-compatible",
            defaultModel: "fixture-model",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
          },
        },
        lsp: { mode: "off", servers: {} },
        web: { enabled: false },
      }),
    );
    const result = await execa(
      command,
      [
        ...prefix,
        "--cwd",
        root,
        "--json",
        "--allow",
        "ext:builtin.subagents:submit_coding,ext:builtin.subagents:prepare_worktree,edit_file",
        "/agent coding Измени source.txt в отдельной копии",
      ],
      { env, reject: false, timeout: 45000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(count, 3);
    const dto = JSON.parse(result.stdout.trim().split("\n").at(-1) as string);
    const children = dto.details?.children ?? dto.children;
    assert.equal(children.length, 1);
    assert.equal(children[0].status, "completed");
    const ref = children[0].root;
    assert.ok(ref);
    assert.equal(
      await readFile(join(ref, "source.txt"), "utf8"),
      "isolated CLI result\n",
    );
    assert.equal(
      await readFile(join(root, "source.txt"), "utf8"),
      "base text\n",
    );
    for (const extra of [
      [
        "--mode",
        "plan",
        "--allow",
        "ext:builtin.subagents:submit_coding",
        "/agent coding Не записывай ничего",
      ],
      [
        "--allow",
        "ext:builtin.subagents:submit_coding",
        "/agent coding Для копии требуется отдельное разрешение",
      ],
    ]) {
      const refused = await execa(
        command,
        [...prefix, "--cwd", root, "--json", ...extra],
        { env, reject: false, timeout: 45000 },
      );
      assert.notEqual(refused.exitCode, 0, refused.stdout);
      assert.equal(
        count,
        3,
        "Plan или недоступное разрешение не запускают child provider",
      );
      if (extra[0] === "--allow") {
        const denied = JSON.parse(refused.stdout.trim().split("\n").at(-1)!);
        assert.equal(denied.details.children[0].status, "approval_unavailable");
      }
    }
    const rejectedResume = await execa(
      command,
      [
        ...prefix,
        "--cwd",
        ref,
        "--resume",
        children[0].sessionId,
        "--json",
        "Продолжи незавершённые инструменты",
      ],
      { env, reject: false, timeout: 45000 },
    );
    assert.notEqual(rejectedResume.exitCode, 0);
    assert.equal(
      count,
      3,
      "Обычный resume дочерней истории не запускает новый agent loop",
    );
    process.stdout.write(
      "Subagents CLI: builtin consumer, real model/tool loop, isolated edits and durable child references passed\n",
    );
  } finally {
    server.stop(true);
    await rm(storage, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [command, ...prefix] = process.argv.slice(2);
  if (!command) throw new Error("Укажите обычный CLI или compiled binary.");
  await smokeSubagentCli(command, prefix);
}
