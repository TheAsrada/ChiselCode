import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

/** The ordinary production CLI, shared by source/npm/compiled/released smoke. */
export async function smokeWorktreeCli(command: string, prefix: string[]) {
  const storage = await mkdtemp(join(tmpdir(), "chisel-worktree-cli-"));
  const root = join(storage, "project с пробелами");
  await mkdir(root);
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: storage,
    XDG_DATA_HOME: storage,
    APPDATA: storage,
    LOCALAPPDATA: storage,
    OPENAI_API_KEY: "fixture-offline-key",
  };
  const git = async (cwd: string, ...args: string[]) =>
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
        { cwd },
      )
    ).stdout;
  let steps = 0,
    value = "first",
    failure: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        if (new URL(request.url).pathname.endsWith("/models"))
          return Response.json({
            data: [
              {
                id: "fixture-worktree",
                context_window: 65536,
                max_output_tokens: 2048,
              },
            ],
          });
        const body = (await request.json()) as {
          tools: { function: { name: string } }[];
          messages: { role: string; content?: string }[];
        };
        assert.ok(
          body.tools.some((tool) =>
            tool.function.name.startsWith("ext_ext_builtin_worktrees_create_"),
          ),
        );
        const manifest = body.tools.find((tool) =>
          tool.function.name.startsWith("ext_ext_builtin_project_manifest_"),
        );
        assert.ok(manifest);
        const calls = [
          { name: "read_file", input: { path: "same.txt" } },
          {
            name: "write_file",
            input: { path: "same.txt", content: `${value}\n` },
          },
          { name: manifest.function.name, input: {} },
          { name: "git_status", input: {} },
        ];
        const call = calls[steps++];
        const delta = call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${steps}`,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.input),
                  },
                },
              ],
            }
          : {
              content:
                "Isolated worktree edited through the ordinary agent runtime.",
            };
        return new Response(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      } catch (error) {
        failure = error;
        return Response.json(
          { error: { message: "Fixture failed" } },
          { status: 400 },
        );
      }
    },
  });
  const run = async (
    cwd: string,
    text: string,
    extra: string[] = [],
    expected = 0,
  ) => {
    const result = await execa(
      command,
      [
        ...prefix,
        "--cwd",
        cwd,
        "--json",
        "--approval",
        "acceptEdits",
        "--allow",
        "ext:builtin.worktrees:create,ext:builtin.worktrees:apply,ext:builtin.worktrees:remove",
        ...extra,
        text,
      ],
      { env, reject: false, timeout: 45000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(
      result.exitCode,
      expected,
      `${result.stdout}\n${result.stderr}`,
    );
    if (failure) throw failure;
    return JSON.parse(result.stdout.trim().split("\n").at(-1) as string);
  };
  try {
    await git(root, "init", "--initial-branch=main");
    await git(root, "config", "core.autocrlf", "false");
    await writeFile(join(root, "same.txt"), "base\r\n");
    await writeFile(
      join(root, "package.json"),
      '{"name":"worktree-installed-fixture"}\n',
    );
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");
    const branch = await git(root, "for-each-ref", "refs/heads");
    const head = await git(root, "rev-parse", "HEAD");
    await mkdir(join(storage, "chiselcode"), { recursive: true });
    await writeFile(
      join(storage, "chiselcode", "config.json"),
      JSON.stringify({
        schemaVersion: 2,
        defaultProfileId: "fixture",
        profiles: {
          fixture: {
            providerId: "openai-compatible",
            defaultModel: "fixture-worktree",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
          },
        },
        lsp: { mode: "off", servers: {} },
        web: { enabled: false },
      }),
    );
    const a = (await run(root, "/worktree create Первая задача")).details
      .worktree;
    const b = (await run(root, "/worktree create Вторая задача")).details
      .worktree;
    assert.equal(await git(root, "for-each-ref", "refs/heads"), branch);
    assert.equal(
      (await run(root, `/worktree open ${a.id}`)).details.worktree.path,
      a.path,
    );
    for (const tree of [a, b]) {
      steps = 0;
      value = tree === a ? "first" : "second";
      await run(tree.path, "Read and edit same.txt in this isolated task.");
      assert.equal(steps, 5);
      assert.equal(
        await readFile(join(tree.path, "same.txt"), "utf8"),
        `${value}\n`,
      );
    }
    assert.equal(await readFile(join(root, "same.txt"), "utf8"), "base\r\n");
    assert.ok(
      (await run(root, `/worktree diff ${a.id}`)).diffs.some(
        (diff: { path: string }) => diff.path === "same.txt",
      ),
    );
    await run(root, `/worktree apply ${a.id}`);
    assert.equal(await readFile(join(root, "same.txt"), "utf8"), "first\n");
    assert.equal(
      (await run(root, `/worktree apply ${b.id}`, [], 1)).errorCode,
      "WORKTREE_CONFLICT",
    );
    assert.equal(
      (await run(root, `/worktree remove ${b.id}`, [], 1)).errorCode,
      "WORKTREE_DIRTY",
    );
    await git(a.path, "add", "same.txt");
    await git(a.path, "commit", "-m", "retained result");
    const retained = (await run(root, `/worktree remove ${a.id}`)).details
      .worktree;
    assert.equal(
      await git(root, "show", `${retained.retainedRef}:same.txt`),
      "first",
    );
    assert.equal(await git(root, "rev-parse", "HEAD"), head);
    assert.equal(
      (await run(root, "/worktree list")).details.worktrees.find(
        (tree: { id: string }) => tree.id === b.id,
      ).state,
      "ready",
    );
    assert.equal(
      (await run(root, "/worktree create Blocked", ["--mode", "plan"], 1))
        .errorCode,
      "MODE_RESTRICTION",
    );
    process.stdout.write(
      "Worktree CLI: detached create, isolated agent edits/manifest/Git, preview/apply/conflict, safe remove and durable commit retention passed.\n",
    );
  } finally {
    server.stop(true);
    await rm(storage, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [command, ...prefix] = process.argv.slice(2);
  if (!command)
    throw new Error("Provide an ordinary CLI executable and prefix arguments.");
  await smokeWorktreeCli(command, prefix);
}
