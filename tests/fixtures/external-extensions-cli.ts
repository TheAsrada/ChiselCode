import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { quoteShellArg } from "../helpers/shell.js";

/** External bytes are authored outside checkout and copied after application compilation. */
export async function smokeExternalCli(
  command: string,
  prefix: string[],
  installedPackage = resolve(
    import.meta.dir,
    "../../dist/install-smoke/node_modules/chiselcode",
  ),
) {
  const temp = await mkdtemp(join(tmpdir(), "chisel-external-cli-")),
    project = join(temp, "Проект с пробелами"),
    author = join(temp, "Автор пакета");
  const data = join(temp, "Home"),
    home = join(
      data,
      process.platform === "win32" ? "ChiselCode" : "chiselcode",
    ),
    packageDir = join(home, "extensions", "Заметки проекта");
  const env: NodeJS.ProcessEnv = {
    // Windows environment keys are case-insensitive. Do not send duplicate
    // LocalAppData/LOCALAPPDATA values to a child, which could select the real Home.
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          ![
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "APPDATA",
            "LOCALAPPDATA",
          ].includes(key.toUpperCase()),
      ),
    ),
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: data,
    APPDATA: data,
    LOCALAPPDATA: data,
  };
  const invoke = (args: string[]) =>
    execa(command, [...prefix, ...args], {
      env,
      // env is already a complete inherited snapshot with Home aliases normalized.
      // Execa's default merge would reintroduce the original Windows casing.
      extendEnv: false,
      reject: false,
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    });
  await mkdir(project, { recursive: true });
  await mkdir(join(author, "node_modules"), { recursive: true });
  await mkdir(packageDir, { recursive: true });
  const example = resolve(
    import.meta.dir,
    "../../examples/extensions/project-notes",
  );
  let modelServer: ReturnType<typeof Bun.serve> | undefined;
  try {
    // Only the installed public entry and declarations; no neighboring checkout src.
    await mkdir(join(author, "node_modules/chiselcode/dist/extension-sdk"), {
      recursive: true,
    });
    const packageManifest = JSON.parse(
      await readFile(join(installedPackage, "package.json"), "utf8"),
    );
    await writeFile(
      join(author, "node_modules/chiselcode/package.json"),
      JSON.stringify({
        name: "chiselcode",
        type: "module",
        exports: packageManifest.exports,
      }),
    );
    for (const file of ["index.d.ts", "index.js"])
      await copyFile(
        join(installedPackage, "dist/extension-sdk", file),
        join(author, "node_modules/chiselcode/dist/extension-sdk", file),
      );
    await writeFile(
      join(author, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const authored = await readFile(join(example, "index.ts"), "utf8");
    await writeFile(
      join(author, "index.ts"),
      authored.replace(
        "export default factory;",
        `
      const checkedFactory: ExtensionFactory = input => {
        const definition = factory(input);
        if (definition instanceof Promise) throw Error('Example factory must be synchronous');
        return { ...definition, activate(context) {
          definition.activate(context);
          context.commands.register({ name: 'sdk-native', description: 'Проверить штатные операции проекта через SDK',
            parse(args) { return JSON.parse(args) as {tool:string;input:JsonObject}; },
            execute(invocation, request) { return invocation.tools.execute(request.tool, request.input); }
          });
        } };
      };
      export default checkedFactory;
    `,
      ),
    );
    await writeFile(
      join(author, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: false,
        },
        include: ["index.ts"],
      }),
    );
    const types = await execa(
      process.execPath,
      [
        resolve(import.meta.dir, "../../node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--project",
        join(author, "tsconfig.json"),
      ],
      { cwd: author, reject: false },
    );
    assert.equal(types.exitCode, 0, types.stdout + types.stderr);
    await execa(
      process.execPath,
      [
        "build",
        join(author, "index.ts"),
        "--target",
        "bun",
        "--outfile",
        join(author, "index.mjs"),
      ],
      { cwd: author },
    );
    const source = await readFile(join(author, "index.mjs"), "utf8");
    assert.ok(!source.includes("chiselcode/extension-sdk"));
    assert.ok(!source.includes("/src/"));
    const sentinel = join(temp, "import-sentinel.txt");
    await writeFile(
      join(packageDir, "index.mjs"),
      `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(sentinel)}, 'import\\n');\n` +
        source,
    );
    await copyFile(
      join(example, "chisel-extension.json"),
      join(packageDir, "chisel-extension.json"),
    );
    await writeFile(
      join(packageDir, "asset.txt"),
      "Все assets участвуют в digest",
    );
    const config = join(data, "chiselcode/config.json");
    await mkdir(join(data, "chiselcode"), { recursive: true });
    await writeFile(
      config,
      JSON.stringify({
        schemaVersion: 2,
        profiles: {},
        lsp: { mode: "off", servers: {} },
        web: { enabled: false },
      }),
    );
    await writeFile(join(project, "note.txt"), "Исходная заметка\n");
    await execa("git", ["init", "-q"], { cwd: project });
    await execa("git", ["add", "note.txt"], { cwd: project });
    await execa(
      "git",
      [
        "-c",
        "user.name=SDK fixture",
        "-c",
        "user.email=sdk@example.test",
        "commit",
        "-qm",
        "base",
      ],
      { cwd: project },
    );
    const actualHome = await invoke(["extensions", "path"]);
    assert.equal(actualHome.exitCode, 0, actualHome.stderr);
    const parent = await realpath(join(home, "extensions"));
    assert.equal(
      actualHome.stdout.trim().toLowerCase(),
      parent.toLowerCase(),
      "Prepared package and child process must use the same canonical Home",
    );
    const inspected = await invoke([
      "extensions",
      "inspect",
      packageDir,
      "--json",
    ]);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    const candidate = JSON.parse(inspected.stdout);
    await assert.rejects(readFile(sentinel));
    const status = await invoke(["extensions", "status", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    await assert.rejects(readFile(sentinel));
    const version = await invoke(["--version"]);
    assert.equal(version.exitCode, 0);
    await assert.rejects(readFile(sentinel));
    const approved = await invoke([
      "extensions",
      "approve",
      packageDir,
      "--id",
      candidate.manifest.id,
      "--digest",
      candidate.digest,
      "--enable",
      "--ack-process-access",
    ]);
    assert.equal(approved.exitCode, 0, approved.stderr);
    await assert.rejects(readFile(sentinel));
    const approvedInspection = await invoke([
      "extensions",
      "inspect",
      packageDir,
      "--json",
    ]);
    assert.equal(approvedInspection.exitCode, 0, approvedInspection.stderr);
    assert.equal(JSON.parse(approvedInspection.stdout).trusted, true);
    assert.equal(JSON.parse(approvedInspection.stdout).enabled, true);
    await assert.rejects(readFile(sentinel));
    const read = await invoke(["--cwd", project, "--json", "/notes note.txt"]);
    assert.equal(read.exitCode, 0, read.stdout + read.stderr);
    assert.match(read.stdout, /Исходная заметка/);
    assert.equal(await readFile(sentinel, "utf8"), "import\n");
    const write = await invoke([
      "--cwd",
      project,
      "--json",
      "--approval",
      "acceptEdits",
      `/notes-write ${JSON.stringify({ path: "note.txt", content: "Настоящая запись внешнего SDK\n" })}`,
    ]);
    assert.equal(write.exitCode, 0, write.stdout + write.stderr);
    assert.equal(
      await readFile(join(project, "note.txt"), "utf8"),
      "Настоящая запись внешнего SDK\n",
    );
    const plan = await invoke([
      "--cwd",
      project,
      "--json",
      "--mode",
      "plan",
      "--approval",
      "acceptEdits",
      `/notes-write ${JSON.stringify({ path: "note.txt", content: "нельзя" })}`,
    ]);
    assert.notEqual(plan.exitCode, 0, plan.stdout + plan.stderr);
    assert.equal(
      await readFile(join(project, "note.txt"), "utf8"),
      "Настоящая запись внешнего SDK\n",
    );
    let requests = 0,
      scenario: "side" | "child" = "side";
    modelServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const body = (await request.json()) as {
          model: string;
          tools?: unknown[];
          max_tokens?: number;
          max_completion_tokens?: number;
          messages?: { role: string }[];
        };
        assert.equal(body.model, "fixture-model");
        assert.ok(
          (body.max_tokens ?? body.max_completion_tokens ?? 0) <=
            (scenario === "side" ? 64 : 4096),
        );
        if (scenario === "side") assert.equal(body.tools?.length ?? 0, 0);
        else assert.ok((body.tools?.length ?? 0) > 0);
        const writing =
          scenario === "child" &&
          !body.messages?.some((message) => message.role === "tool");
        return new Response(
          [
            {
              id: "sdk",
              choices: [
                {
                  index: 0,
                  delta: writing
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: "sdk-child-write",
                            type: "function",
                            function: {
                              name: "write_file",
                              arguments: JSON.stringify({
                                path: "child-proof.txt",
                                content: "Настоящий child loop SDK\n",
                              }),
                            },
                          },
                        ],
                      }
                    : {
                        content:
                          scenario === "side"
                            ? "Отдельный ответ внешнего SDK"
                            : "Помощник SDK завершён",
                      },
                  finish_reason: writing ? "tool_calls" : "stop",
                },
              ],
            },
            {
              id: "sdk",
              choices: [],
              usage: { prompt_tokens: 11, completion_tokens: 7 },
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    env.OPENAI_API_KEY = "fixture-unused-sdk-model-key";
    await writeFile(
      config,
      JSON.stringify({
        schemaVersion: 2,
        defaultProfileId: "fixture",
        profiles: {
          fixture: {
            providerId: "openai-compatible",
            defaultModel: "fixture-model",
            baseUrl: `http://127.0.0.1:${modelServer.port}/v1`,
          },
        },
        lsp: { mode: "off", servers: {} },
        web: { enabled: false },
      }),
    );
    const answer = await invoke([
      "--cwd",
      project,
      "--profile",
      "fixture",
      "--json",
      "/notes-question Прочитай вопрос без истории",
    ]);
    assert.equal(answer.exitCode, 0, answer.stdout + answer.stderr);
    const modelResult = JSON.parse(answer.stdout);
    assert.equal(modelResult.status, "completed");
    assert.equal(modelResult.text, "Отдельный ответ внешнего SDK");
    assert.equal(modelResult.usage.inputTokens, 11);
    assert.equal(modelResult.usage.outputTokens, 7);
    assert.equal(requests, 1);
    const native = async (
      tool: string,
      input: Record<string, unknown>,
      extra: string[] = [],
    ) => {
      const result = await invoke([
        "--cwd",
        project,
        "--profile",
        "fixture",
        "--json",
        ...extra,
        `/sdk-native ${JSON.stringify({ tool, input })}`,
      ]);
      assert.equal(result.exitCode, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    const created = await native(
      "ext:builtin.worktrees:create",
      { label: "SDK copy" },
      ["--allow", "ext:builtin.worktrees:create"],
    );
    const copy = created.details?.worktree;
    assert.ok(copy, JSON.stringify(created));
    assert.ok(copy.id && copy.path);
    assert.equal(
      await readFile(join(copy.path, "note.txt"), "utf8"),
      "Исходная заметка\n",
      "Owned copy starts at committed base, not dirty origin",
    );
    await native("ext:builtin.worktrees:remove", { id: copy.id }, [
      "--allow",
      "ext:builtin.worktrees:remove",
    ]);
    const batch = `${quoteShellArg(process.execPath)} -e ${quoteShellArg("require('node:fs').appendFileSync('sdk-batch.txt','one\\n'); console.log('SDK batch real output')")}`;
    const started = await native(
      "run_shell",
      { command: batch, background: true, label: "SDK batch" },
      ["--allow", "run_shell"],
    );
    const task = started.details?.backgroundTasks?.[0];
    assert.ok(task, started.output);
    assert.equal(task.state, "completed");
    assert.equal(task.exitCode, 0);
    assert.equal(task.cleanup.confirmed, true);
    assert.equal(
      await readFile(join(project, "sdk-batch.txt"), "utf8"),
      "one\n",
    );
    const output = await native(
      "ext:builtin.background:read_output",
      { id: task.id },
      ["--resume", task.rootOwnerId],
    );
    assert.match(output.output, /SDK batch real output/);
    const foreign = await invoke([
      "--cwd",
      project,
      "--json",
      `/sdk-native ${JSON.stringify({ tool: "ext:builtin.background:status", input: { id: task.id } })}`,
    ]);
    assert.notEqual(
      foreign.exitCode,
      0,
      "New conversation cannot read another owner's task",
    );
    scenario = "child";
    const delegated = await native(
      "ext:builtin.subagents:submit_coding",
      {
        task: "Создай child-proof.txt штатным инструментом",
        label: "SDK helper",
        context: "none",
      },
      [
        "--approval",
        "acceptEdits",
        "--allow",
        "ext:builtin.subagents:submit_coding,ext:builtin.subagents:prepare_worktree",
      ],
    );
    const child = delegated.details?.children?.[0];
    assert.ok(child, delegated.output);
    assert.equal(child.status, "completed");
    assert.equal(child.cleanup.quiescent, true);
    assert.equal(
      await readFile(join(child.root, "child-proof.txt"), "utf8"),
      "Настоящий child loop SDK\n",
    );
    assert.equal(
      requests,
      3,
      "One side query and two genuine child model stages",
    );
    const expectedRequests = requests;
    const before = await readFile(sentinel, "utf8");
    await writeFile(join(packageDir, "asset.txt"), "изменён");
    const modified = await invoke([
      "--cwd",
      project,
      "--json",
      "/notes note.txt",
    ]);
    assert.notEqual(modified.exitCode, 0);
    assert.equal(await readFile(sentinel, "utf8"), before);
    const recovery = await invoke([
      "--no-external-extensions",
      "--cwd",
      project,
      "--json",
      "/tasks list",
    ]);
    assert.equal(recovery.exitCode, 0, recovery.stdout + recovery.stderr);
    assert.equal(await readFile(sentinel, "utf8"), before);
    assert.equal(
      requests,
      expectedRequests,
      "Ошибка/modified package не запускает fallback model request",
    );
    console.log(
      "External SDK: standalone author/types, exact trust, ordinary import/read/write/Plan, modified asset refusal and recovery verified",
    );
  } finally {
    modelServer?.stop(true);
    await rm(temp, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [command, ...prefix] = process.argv.slice(2);
  if (!command) throw Error("Укажите ordinary CLI/npm/compiled executable.");
  await smokeExternalCli(command, prefix);
}
