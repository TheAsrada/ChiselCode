import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { ContextManager } from "../../src/context/context-manager.js";
import { createChatGptExtension } from "../../src/extensions/builtins/chatgpt/index.js";
import { enterpriseFetch } from "../../src/network/fetch.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { resolveProviderRuntime } from "../../src/providers/runtime.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { CredentialStore } from "../../src/security/credentials.js";
import { createSession } from "../../src/sessions/store.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";

test("ChatGPT device login, encrypted profile, live HTTP Responses and real file tool complete an agent turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-chatgpt-runtime-"));
  const token = `header.${Buffer.from(JSON.stringify({ email: "fixture@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
  let generations = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/usercode"))
        return Response.json({
          device_auth_id: "fixture",
          user_code: "TEST-CODE",
        });
      if (path.endsWith("/deviceauth/token"))
        return Response.json({
          authorization_code: "fixture-grant",
          code_verifier: "fixture-verifier",
        });
      if (path === "/oauth/token")
        return Response.json({
          access_token: token,
          id_token: token,
          refresh_token: "fixture-refresh",
          expires_in: 3600,
        });
      expect(request.headers.get("Authorization")).toBe(`Bearer ${token}`);
      expect(request.headers.get("ChatGPT-Account-Id")).toBe("fixture-account");
      if (path.endsWith("/models"))
        return Response.json({
          models: [
            {
              slug: "fixture-codex",
              display_name: "Fixture Codex",
              context_window: 128000,
              visibility: "list",
            },
          ],
        });
      expect(path).toBe("/backend-api/codex/responses");
      const body = (await request.json()) as {
        store: boolean;
        input: { type?: string; call_id?: string; output?: string }[];
      };
      expect(body.store).toBe(false);
      generations++;
      if (generations > 1)
        expect(
          body.input.find((item) => item.type === "function_call_output"),
        ).toMatchObject({ call_id: "call_write" });
      const output =
        generations === 1
          ? [
              {
                type: "function_call",
                call_id: "call_write",
                name: "write_file",
                arguments: JSON.stringify({
                  path: "result.txt",
                  content: "Подписка работает\n",
                }),
              },
            ]
          : [
              {
                type: "message",
                content: [{ type: "output_text", text: "Файл записан" }],
              },
            ];
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`,
        {
          headers: {
            "Content-Type": "text/event-stream",
            "x-codex-primary-used-percent": "20",
          },
        },
      );
    },
  });
  const credentials = new CredentialStore(join(root, "credentials"));
  const extension = createChatGptExtension({
    credentials,
    lockDirectory: root,
    fetch: (url, init) => {
      const upstream = new URL(
        typeof url === "string" || url instanceof URL ? url : url.url,
      );
      return enterpriseFetch(
        `${server.url.origin}${upstream.pathname}${upstream.search}`,
        init,
      );
    },
  });
  const registry = new ProviderRegistry();
  registry.registerContribution(extension.providers![0]!, extension.id);
  let tools: ReturnType<typeof createLocalToolRuntime> | undefined;
  try {
    await registry.connection("chatgpt")!.connect({
      profileId: "fixture",
      signal: new AbortController().signal,
      challenge(value) {
        expect(value.code).toBe("TEST-CODE");
      },
    });
    expect(
      await readFile(join(root, "credentials", "credentials.enc"), "utf8"),
    ).not.toContain("fixture-refresh");
    const { adapter } = await resolveProviderRuntime({
      profile: { providerId: "chatgpt" },
      profileId: "fixture",
      registry,
    });
    expect(await adapter.listModels!()).toMatchObject([
      { id: "fixture-codex", contextWindow: 128000 },
    ]);
    const session = createSession(root, "chatgpt", "fixture-codex");
    const events = new RuntimeEventBus(session.id);
    const gate = new ApprovalGate(
      DEFAULT_PROJECT_CONFIG,
      {
        approvalMode: "bypassPermissions",
        allowBypassPermissions: true,
        autoApprove: false,
        allowedTools: new Set(),
        nonInteractive: true,
      },
      { requestApproval: async () => "unavailable" },
    );
    tools = createLocalToolRuntime(root, [], gate, session, [], {
      events,
      artifactDirectory: join(root, "artifacts"),
    });
    const runtime = new AgentRuntime(
      adapter,
      new ContextManager({}, events),
      {
        selectForTurn: () =>
          tools!.catalog
            .selectForTurn()
            .filter((tool) => tool.name === "write_file"),
        execute: (calls, signal) => tools!.scheduler.execute(calls, signal),
      },
      "Запиши файл",
      events,
    );
    const result = await runtime.run(session, "Запиши result.txt", {
      workspaceRoot: root,
      approvalMode: "bypassPermissions",
      maxIterations: 3,
    });
    expect(result.text).toBe("Файл записан");
    expect(await readFile(join(root, "result.txt"), "utf8")).toBe(
      "Подписка работает\n",
    );
    expect(generations).toBe(2);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("ChatGPT launches the production child runtime and populates the OpenTUI model picker from the profile catalog", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/chatgpt-subagent-cli.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("ChatGPT subagent CLI: Responses");
  expect(output).toContain("ChatGPT OpenTUI: full profile catalog");
}, 45000);
