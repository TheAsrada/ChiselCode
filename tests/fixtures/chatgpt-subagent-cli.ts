import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { CredentialStore } from "../../src/security/credentials.js";
import {
  listen,
  networkCertificates,
  startNetworkProxy,
} from "./network-proxy.js";

const storage = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-chatgpt-child-")),
);
const root = join(storage, "fixture project");
const configPath = join(storage, "chiselcode", "config.json");
const token = "fixture-chatgpt-access";
const profileId = "work";
const originalModel = "gpt-6.1-sol";
const childModel = "gpt-6-luna";
const proof = "Read-only fixture evidence";
const answer = "Результат ChatGPT сохранён";
const fixtureVersion = "0.166.0";
const certPath = resolve("tests/fixtures/network-tls/chatgpt-origin.pem");
const authState = {
  accessToken: token,
  refreshToken: "fixture-chatgpt-refresh",
  accountId: "fixture-work",
  expiresAt: Date.now() + 3600000,
};
const models = [
  {
    slug: originalModel,
    display_name: "GPT-6.1 Sol",
    visibility: "list",
    context_window: 500000,
  },
  {
    slug: childModel,
    display_name: "GPT-6 Luna",
    visibility: "list",
    context_window: 272000,
    supported_in_api: false,
  },
  { display_name: "Invalid entry", visibility: "list" },
  { slug: "hidden-entry", visibility: "hide" },
  {
    slug: "gpt-6.1-terra",
    display_name: "GPT-6.1 Terra",
    visibility: "list",
    context_window: 500000,
  },
];
type RequestBody = {
  model: string;
  instructions: string;
  store: boolean;
  tools: { name: string }[];
  input: { type?: string; call_id?: string; output?: string }[];
};
function sse(output: unknown[]) {
  return `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: { input_tokens: 25, output_tokens: 5 } } })}\n\n`;
}
function call(call_id: string, name: string, input: object) {
  return {
    type: "function_call",
    call_id,
    name,
    arguments: JSON.stringify(input),
  };
}
function reply(text: string) {
  return { type: "message", content: [{ type: "output_text", text }] };
}
const requests: RequestBody[] = [];
const catalogVersions: (string | null)[] = [];
const httpErrors: unknown[] = [];
let hold: { started(): void; stopped(): void } | undefined;
const { key } = await networkCertificates();
const server = createServer(
  { cert: await readFile(certPath), key },
  async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(request.headers["chatgpt-account-id"], authState.accountId);
      const url = new URL(request.url!, "https://chatgpt.com");
      if (url.pathname === "/backend-api/codex/models") {
        const version = url.searchParams.get("client_version");
        catalogVersions.push(version);
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            models: version === fixtureVersion ? models : [models[0]],
          }),
        );
        return;
      }
      if (url.pathname === "/backend-api/wham/usage") {
        response.setHeader("Content-Type", "application/json");
        response.end("{}");
        return;
      }
      assert.equal(url.pathname, "/backend-api/codex/responses");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
      requests.push(body);
      assert.equal(body.store, false);
      const child = body.instructions.includes(
        "Поручение выполняется отдельным помощником.",
      );
      const output = body.input.find(
        (item) => item.type === "function_call_output",
      );
      response.setHeader("Content-Type", "text/event-stream");
      if (!child) {
        if (output) {
          assert.equal(output.call_id, "submit");
          const accepted = JSON.parse(output.output!);
          assert.equal(accepted.model, childModel);
          response.end(sse([reply("Поручение принято")]));
          return;
        }
        const submit = body.tools.find((tool) =>
          tool.name.includes("submit_readonly"),
        );
        assert.ok(submit);
        response.end(
          sse([
            call("submit", submit.name, {
              label: "Чтение ChatGPT",
              task: "Прочитай proof.txt",
              context: "none",
              model: childModel,
            }),
          ]),
        );
        return;
      }
      assert.ok(body.tools.some((tool) => tool.name === "read_file"));
      assert.ok(
        !body.tools.some((tool) =>
          /write_file|run_shell|submit_readonly/.test(tool.name),
        ),
      );
      assert.equal(body.model, childModel);
      if (hold) {
        const barrier = hold;
        response.on("close", () => barrier.stopped());
        response.flushHeaders();
        barrier.started();
        return;
      }
      if (!output) {
        response.end(sse([call("read", "read_file", { path: "proof.txt" })]));
        return;
      }
      assert.equal(output.call_id, "read");
      assert.match(output.output!, new RegExp(proof));
      response.end(sse([reply(answer)]));
    } catch (error) {
      httpErrors.push(error);
      response.destroy();
    }
  },
);
const target = "chatgpt.com:443";
const proxy = await startNetworkProxy({
  destinationPort: await listen(server),
  target,
});
const env = {
  XDG_CONFIG_HOME: storage,
  XDG_DATA_HOME: storage,
  APPDATA: storage,
  LOCALAPPDATA: storage,
  HTTP_PROXY: proxy.url,
  http_proxy: proxy.url,
  HTTPS_PROXY: proxy.url,
  https_proxy: proxy.url,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  NODE_EXTRA_CA_CERTS: certPath,
};
Object.assign(process.env, env);

try {
  await mkdir(root);
  await writeFile(join(root, "proof.txt"), proof);
  await new CredentialStore().set(
    `subscription:chatgpt:${profileId}`,
    JSON.stringify(authState),
  );
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      defaultProfileId: profileId,
      profiles: {
        [profileId]: { providerId: "chatgpt", defaultModel: originalModel },
        disconnected: { providerId: "chatgpt", defaultModel: originalModel },
      },
      lsp: { mode: "off", servers: {} },
      web: { enabled: false },
      ui: { motion: "reduced" },
    }),
  );

  const [command = process.execPath, ...prefix] = process.argv.slice(2);
  const invoke = (...args: string[]) =>
    execa(
      command,
      [
        ...(process.argv[2] ? prefix : ["src/cli.ts"]),
        "--cwd",
        root,
        "--json",
        ...args,
      ],
      { env, reject: false, timeout: 18000 },
    );

  const cli = await invoke(
    "/agent readonly --model gpt-6-luna Прочитай proof.txt",
  );
  assert.deepEqual(httpErrors, []);
  const dto = JSON.parse(cli.stdout.trim().split("\n").at(-1)!);
  const [child] = dto.details.children;
  assert.equal(child.status, "completed", JSON.stringify(child));
  assert.equal(cli.exitCode, 0, `${cli.stdout}\n${cli.stderr}`);
  assert.equal(dto.details.children.length, 1);
  assert.equal(child.text, answer);
  assert.equal(child.model, childModel);
  assert.equal(child.profileId, profileId);
  assert.equal(child.providerId, "chatgpt");
  assert.deepEqual(child.cleanup, { quiescent: true });
  assert.deepEqual(child.consumption, { tools: 1, iterations: 2 });
  assert.equal(child.attempts.length, 2);
  assert.ok(
    child.attempts.every(
      (attempt: { completed: boolean; usageSource: string }) =>
        attempt.completed && attempt.usageSource === "observed",
    ),
  );
  assert.equal(child.spend.usage.inputTokens, 50);
  assert.equal(child.spend.usage.outputTokens, 10);
  assert.equal(child.spend.unknownCost, true);
  assert.notEqual(child.sessionId, child.parentSessionId);
  assert.equal(requests.length, 2);
  assert.ok(catalogVersions.includes(fixtureVersion));
  assert.ok(!cli.stdout.includes(token));
  assert.ok(!cli.stdout.includes(authState.refreshToken));

  if (!process.argv[2]) {
    const { projectSessionStore } = await import(
      "../../src/sessions/project-store.js"
    );
    const store = await projectSessionStore(root);
    const parent = await store.load(child.parentSessionId);
    const saved = await store.load(child.sessionId);
    assert.equal(parent.model, originalModel);
    assert.deepEqual(parent.children?.[child.id]?.spend, child.spend);
    assert.deepEqual(parent.totalTokens, child.spend.usage);
    assert.equal(saved.model, childModel);
    assert.equal(saved.profileId, profileId);
    assert.equal(saved.subagent?.id, child.id);
    assert.deepEqual(saved.totalTokens, child.spend.usage);
    assert.ok(JSON.stringify(saved.messages).includes(proof));
    assert.ok(!JSON.stringify({ parent, saved }).includes(token));

    const parentPrompt = await invoke(
      "--profile",
      profileId,
      "Поручи чтение помощнику",
    );
    assert.equal(
      parentPrompt.exitCode,
      0,
      parentPrompt.stderr + parentPrompt.stdout,
    );
    const parentRequests = requests.filter(
      (body) => body.model === originalModel,
    );
    assert.equal(parentRequests.length, 2);
    const count = requests.length;
    const failed = await invoke(
      "--profile",
      "disconnected",
      "/agent readonly --model gpt-6-luna Прочитай proof.txt",
    );
    const [failure] = JSON.parse(failed.stdout.trim().split("\n").at(-1)!)
      .details.children;
    assert.equal(failed.exitCode, 1);
    assert.equal(failure.status, "failed");
    assert.match(failure.error.message, /Войдите в ChatGPT/);
    assert.deepEqual(failure.cleanup, { quiescent: true });
    assert.equal(requests.length, count);

    const { defaultExtensions } = await import(
      "../../src/extensions/composition.js"
    );
    const { ExtensionHost } = await import("../../src/extensions/host.js");
    const { runExtensionCommand } = await import(
      "../../src/app/run-command.js"
    );
    const { subagentServiceToken } = await import(
      "../../src/extensions/builtins/subagents.js"
    );
    const host = new ExtensionHost(defaultExtensions());
    try {
      const scope = await host.open(root);
      const command = scope.commands.get("agent");
      const started = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<void>();
      hold = { started: started.resolve, stopped: stopped.resolve };
      const live = await runExtensionCommand(
        {
          command,
          input: command.parse(
            "readonly --model gpt-6-luna Прочитай proof.txt",
          ),
        },
        scope,
        { interactive: true },
        { requestApproval: async () => "unavailable" },
      );
      assert.ok(!live.result.isError, live.result.output);
      const id = JSON.parse(live.result.output).id;
      await Promise.race([
        started.promise,
        Bun.sleep(5000).then(() => {
          throw new Error("Child did not reach ChatGPT");
        }),
      ]);
      await scope.services
        .lookup(subagentServiceToken)!
        .closeOwner(live.session.id);
      await Promise.race([
        stopped.promise,
        Bun.sleep(5000).then(() => {
          throw new Error("Child request did not close");
        }),
      ]);
      const closed = await store.load(live.session.id);
      const cancelled = closed.children?.[id]?.child;
      assert.equal(cancelled?.status, "cancelled");
      assert.deepEqual(cancelled.cleanup, { quiescent: true });
      assert.equal(cancelled.attempts.length, 1);
      assert.equal(cancelled.consumption.tools, 0);
      assert.equal(requests.length, count + 1);
    } finally {
      hold = undefined;
      await host.dispose();
    }
    const { verifyChatGptModelPicker } = await import(
      "./chatgpt-model-picker.js"
    );
    await verifyChatGptModelPicker(configPath);
  }
  assert.deepEqual(httpErrors, []);
  assert.ok(proxy.requests.some((request) => request.target === target));
  console.log(
    "ChatGPT subagent CLI: Responses, model override, read_file, saved result and cleanup verified",
  );
} finally {
  await proxy.close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(storage, { recursive: true, force: true });
}
