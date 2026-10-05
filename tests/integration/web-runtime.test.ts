import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { ContextManager } from "../../src/context/context-manager.js";
import {
  ToolResultStore,
  UNTRUSTED_REFERENCE,
} from "../../src/context/tool-result-store.js";
import { buildSystemPrompt } from "../../src/core/prompt.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import {
  type RuntimeEvent,
  RuntimeEventBus,
} from "../../src/runtime/events.js";
import {
  type ApprovalDecision,
  ApprovalGate,
  type ApprovalRequest,
} from "../../src/security/approval.js";
import { ProjectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import type {
  ProviderAdapter,
  Session,
  StreamEvent,
} from "../../src/types/domain.js";
import { replaySessionIntoTranscript } from "../../src/ui/tool-transcript.js";
import { WebToolProvider } from "../../src/web/provider.js";
import { WebConfigSchema } from "../../src/web/schema.js";
import { startWebFixture } from "../fixtures/web-http.js";

async function environment(
  options: {
    ask?: boolean;
    headless?: boolean;
    mode?: "plan" | "build";
    approval?: "default" | "dontAsk" | "bypassPermissions";
    decision?: ApprovalDecision;
    config?: unknown;
    session?: Session;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "chisel-web-"));
  const fixture = await startWebFixture(
    WebConfigSchema.parse(options.config ?? {}),
  );
  const session = options.session ?? createSession(root, "fixture", "scripted");
  const approvals: ApprovalRequest[] = [];
  const events: RuntimeEvent[] = [];
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    {
      autoApprove: false,
      approvalMode: options.approval ?? "default",
      allowBypassPermissions: true,
      allowedTools: new Set(
        options.ask
          ? []
          : ["web_fetch", "web_search", "edit_file", "run_shell"],
      ),
      nonInteractive: options.headless ?? false,
      network: { scope: `${root}:${session.id}`, config: fixture.config },
    },
    {
      requestApproval: async (request) => {
        approvals.push(request);
        return options.decision ?? "approved";
      },
    },
  );
  const bus = new RuntimeEventBus(session.id);
  bus.subscribe((event) => {
    events.push(event);
  });
  const store = new ProjectSessionStore({
    id: randomUUID(),
    path: root,
    canonicalPath: root,
    name: "web-test",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  });
  Object.defineProperty(store, "directory", { value: join(root, "sessions") });
  const tools = createLocalToolRuntime(root, [], gate, session, [], {
    mode: options.mode ?? "plan",
    events: bus,
    artifactDirectory: join(root, "artifacts"),
    checkpoint: () => store.save(session),
    sanitizeResult: (value) => fixture.provider.redactor.value(value),
    sanitizeApproval: (value) => fixture.provider.redactor.value(value),
  });
  await tools.catalog.addProvider(fixture.provider);
  return {
    root,
    fixture,
    tools,
    session,
    gate,
    store,
    events,
    approvals,
    async close() {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const call = (id: string, path = "/article") => ({
  id,
  name: "web_fetch",
  input: { url: `https://fixture.docs.example${path}` },
});
async function until(ready: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Fixture did not reach the expected state.");
}
test("web requests do not hold workspace locks while waiting on a remote response", async () => {
  const env = await environment({ mode: "build" });
  const abort = new AbortController();
  const web = env.tools.executor.execute(
    call("waiting", "/controlled"),
    abort.signal,
  );
  try {
    await until(() => env.fixture.counts.get("/controlled") === 1);
    const mutation = env.tools.executor.execute({
      id: "write",
      name: "write_file",
      input: { path: "parallel.txt", content: "independent workspace write" },
    });
    const result = await Promise.race([
      mutation,
      new Promise<undefined>((resolve) => setTimeout(resolve, 1000)),
    ]);
    expect(result).toBeDefined();
    expect(result?.isError).not.toBe(true);
  } finally {
    env.fixture.finishControlled();
    abort.abort();
    await web;
    await env.close();
  }
});
test("parallel read scheduler respects the configured shared web concurrency", async () => {
  const env = await environment({ config: { limits: { maxConcurrent: 2 } } });
  const abort = new AbortController();
  const running = env.tools.scheduler.execute(
    [
      call("one", "/controlled?one"),
      call("two", "/controlled?two"),
      call("three", "/controlled?three"),
    ],
    abort.signal,
  );
  try {
    await until(() => env.fixture.counts.get("/controlled") === 2);
    expect(env.fixture.peak).toBe(2);
    env.fixture.finishControlled();
    await until(() => env.fixture.counts.get("/controlled") === 3);
    env.fixture.finishControlled();
    expect((await running).every((result) => !result.isError)).toBe(true);
    expect(env.fixture.peak).toBeLessThanOrEqual(2);
  } finally {
    abort.abort();
    await running;
    await env.close();
  }
});
test("cache can be disabled and successful duplicate calls still consume the turn budget", async () => {
  const env = await environment({
    config: { cacheTtlMs: 0, limits: { maxRequestsPerTurn: 2 } },
  });
  try {
    expect((await env.tools.executor.execute(call("a"))).isError).not.toBe(
      true,
    );
    expect((await env.tools.executor.execute(call("b"))).isError).not.toBe(
      true,
    );
    expect(env.fixture.counts.get("/article")).toBe(2);
    expect((await env.tools.executor.execute(call("c"))).errorCode).toBe(
      "WEB_REQUEST_LIMIT",
    );
  } finally {
    await env.close();
  }
});
test("live network revocation after DNS prevents opening the socket", async () => {
  const env = await environment();
  try {
    const original = env.fixture.client.policy.resolve.bind(
      env.fixture.client.policy,
    );
    env.fixture.client.policy.resolve = async (...args) => {
      const resolved = await original(...args);
      env.fixture.config.enabled = false;
      return resolved;
    };
    expect(
      (await env.tools.executor.execute(call("revoked-dns"))).errorCode,
    ).toBe("WEB_NETWORK_DENIED");
    expect(env.fixture.connections).toHaveLength(0);
  } finally {
    await env.close();
  }
});
test("crafted headers or safety flags in model arguments are rejected by the strict tool schema", async () => {
  const env = await environment();
  try {
    for (const field of [
      { headers: { Authorization: "malicious" } },
      { unsafe: true },
      { transport: "local" },
    ])
      expect(
        (
          await env.tools.executor.execute({
            ...call(`crafted-${JSON.stringify(field)}`),
            input: { ...call("unused").input, ...field },
          })
        ).errorCode,
      ).toBe("INVALID_TOOL_INPUT");
    expect(env.fixture.connections).toHaveLength(0);
  } finally {
    await env.close();
  }
});
test("Plan exposes web reads with network approvals and keeps mutations unavailable", async () => {
  const env = await environment({ ask: true });
  try {
    const definitions = env.tools.catalog.selectForTurn();
    expect(
      definitions.find((item) => item.name === "web_fetch")?.requiresApproval,
    ).toBe(true);
    expect(definitions.some((item) => item.name === "edit_file")).toBe(false);
    const result = await env.tools.executor.execute(call("fetch"));
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain(UNTRUSTED_REFERENCE);
    expect(env.approvals[0]?.network?.url).toBe(
      "https://fixture.docs.example/article",
    );
    expect(
      env.events.some((event) => event.type === "tool_approval_requested"),
    ).toBe(true);
    const denied = await env.tools.executor.execute({
      id: "edit",
      name: "write_file",
      input: { path: "forbidden", content: "bad" },
    });
    expect(denied.errorCode).toBe("MODE_RESTRICTION");
  } finally {
    await env.close();
  }
});
test("headless approval_required persists preparation without downloading; resume executes once", async () => {
  const env = await environment({ ask: true, headless: true });
  try {
    const pending = await env.tools.executor.execute(call("pending"));
    expect(pending.requiresApproval).toBe(true);
    expect(env.fixture.connections).toHaveLength(0);
    const loaded = await env.store.load(env.session.id);
    expect(loaded.runtime?.invocations.pending?.state).toBe(
      "awaiting_approval",
    );
    const gate = new ApprovalGate(
      DEFAULT_PROJECT_CONFIG,
      {
        autoApprove: false,
        allowedTools: new Set(["web_fetch"]),
        nonInteractive: true,
        network: {
          scope: `${env.root}:${loaded.id}`,
          config: env.fixture.config,
        },
      },
      { requestApproval: async () => "unavailable" },
    );
    const resumed = createLocalToolRuntime(env.root, [], gate, loaded, [], {
      artifactDirectory: join(env.root, "artifacts"),
      checkpoint: () => env.store.save(loaded),
    });
    await resumed.catalog.addProvider(env.fixture.provider);
    const result = await resumed.executor.execute(call("pending"));
    expect(result.isError).not.toBe(true);
    expect(env.fixture.connections).toHaveLength(1);
    expect(await resumed.executor.execute(call("pending"))).toEqual(result);
    expect(env.fixture.connections).toHaveLength(1);
  } finally {
    await env.close();
  }
});
test("session grant removes repeated popups and handles parallel reads without racing the resolver", async () => {
  const env = await environment({ ask: true, decision: "approved_session" });
  try {
    const results = await env.tools.scheduler.execute([
      call("a", "/article"),
      call("b", "/text"),
      call("c", "/json"),
    ]);
    expect(
      results.every((item) => !item.isError && !item.requiresApproval),
    ).toBe(true);
    expect(env.approvals).toHaveLength(1);
    const saved = JSON.stringify(await env.store.load(env.session.id));
    expect(saved).not.toContain('"domains":');
    const cross = await env.tools.executor.execute(
      call("cross", "/cross-domain"),
    );
    expect(cross.errorCode).toBe("WEB_NETWORK_DENIED");
    expect(
      env.fixture.connections.some(
        (connection) => connection.hostname === "other.docs.example",
      ),
    ).toBe(false);
  } finally {
    await env.close();
  }
});
test("Dont Ask never prompts; Bypass allows public reads but cannot authorize private redirects", async () => {
  for (const approval of ["dontAsk", "bypassPermissions"] as const) {
    const env = await environment({ approval, ask: true });
    try {
      const result = await env.tools.executor.execute(call("public"));
      expect(result.errorCode).toBe(
        approval === "dontAsk" ? "WEB_NETWORK_DENIED" : undefined,
      );
      expect(env.approvals).toHaveLength(0);
      const unsafe = await env.tools.executor.execute(
        call("private", "/private"),
      );
      expect(unsafe.errorCode).toBe(
        approval === "dontAsk" ? "WEB_NETWORK_DENIED" : "WEB_UNSAFE_ADDRESS",
      );
    } finally {
      await env.close();
    }
  }
});
test("large documents use artifacts, trust survives partial reads and sources survive replay/resume", async () => {
  const env = await environment();
  try {
    const result = await env.tools.executor.execute(call("large", "/large"));
    expect(result.artifact?.uri).toMatch(/^tool-result:\/\//);
    expect(result.output.length).toBeLessThan(6000);
    expect(result.contentTrust).toBe("untrusted_external");
    expect(JSON.stringify(result.details)).toContain("Large reference");
    const range = await env.tools.executor.execute({
      id: "range",
      name: "read_tool_result",
      input: { uri: result.artifact?.uri, offset: 10, limit: 5 },
    });
    expect(range.output).toStartWith(UNTRUSTED_REFERENCE);
    expect(range.contentTrust).toBe("untrusted_external");
    const loaded = await env.store.load(env.session.id);
    expect(loaded.runtime?.invocations.large?.toolSource).toEqual({
      type: "web",
      operation: "fetch",
    });
    loaded.messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "large",
            name: "web_fetch",
            input: call("large", "/large").input,
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "large", content: result.output },
        ],
      },
    );
    const lines: string[] = [];
    replaySessionIntoTranscript(
      {
        append: (line) => lines.push(line),
        setToolActivity() {},
        appendToLast() {},
        clear() {},
      },
      loaded,
    );
    expect(lines.join("\n")).toContain("Large reference");
    expect(lines.join("\n")).not.toContain("Section 100:");
    expect(lines.join("\n")).toContain("artifact");
    const artifact = new ToolResultStore(join(env.root, "artifacts"));
    expect(await artifact.read(result.artifact?.uri ?? "", 100, 3)).toStartWith(
      UNTRUSTED_REFERENCE,
    );
  } finally {
    await env.close();
  }
});
test("duplicate and canonical fetches reuse bounded session cache, yet permissions are rechecked", async () => {
  const env = await environment();
  try {
    const first = await env.tools.executor.execute(call("first", "/redirect"));
    const second = await env.tools.executor.execute(
      call("second", "/article#different"),
    );
    expect(first.isError).not.toBe(true);
    expect(
      (second.details?.web as { cached?: boolean } | undefined)?.cached,
    ).toBe(true);
    expect(env.fixture.counts.get("/article")).toBe(1);
    env.fixture.config.permissions.denyDomains.push("fixture.docs.example");
    expect((await env.tools.executor.execute(call("revoked"))).errorCode).toBe(
      "WEB_NETWORK_DENIED",
    );
  } finally {
    await env.close();
  }
});
test("search not configured degrades without a stack trace while URL fetch remains available", async () => {
  const env = await environment();
  try {
    const empty = new WebToolProvider(env.fixture.config, env.fixture.client);
    const independent = createLocalToolRuntime(
      env.root,
      [],
      env.gate,
      createSession(env.root, "fixture", "scripted"),
      [],
      { artifactDirectory: join(env.root, "second-artifacts") },
    );
    await independent.catalog.addProvider(empty);
    const result = await independent.executor.execute({
      id: "search",
      name: "web_search",
      input: { query: "docs" },
    });
    expect(result.errorCode).toBe("WEB_SEARCH_NOT_CONFIGURED");
    expect(result.output).toContain("/settings");
    expect(
      (await independent.executor.execute(call("fetch"))).isError,
    ).not.toBe(true);
  } finally {
    await env.close();
  }
});
test("full agent tool path fetches evidence, edits the fixture code and runs its check without treating injection as system text", async () => {
  const env = await environment({ mode: "build" });
  try {
    await writeFile(
      join(env.root, "api.js"),
      "export const name = 'legacyFetch';\n",
    );
    await writeFile(join(env.root, "package.json"), '{"name":"fixture"}');
    const turns = [
      [
        {
          name: "web_search",
          input: {
            query: "Fixture API official migration",
            domains: ["fixture.docs.example"],
          },
        },
      ],
      [call("unused", "/html-with-prompt-injection")],
      [{ name: "read_file", input: { path: "api.js" } }],
      [
        {
          name: "edit_file",
          input: {
            path: "api.js",
            old_str: "legacyFetch",
            new_str: "fetchFresh",
          },
        },
      ],
      [
        {
          name: "run_shell",
          input: {
            command:
              "bun -e \"if (!require('fs').readFileSync('api.js','utf8').includes('fetchFresh')) process.exit(1)\"",
          },
        },
      ],
    ];
    let index = 0;
    const captured: Array<{ system: string; messages: unknown }> = [];
    const adapter: ProviderAdapter = {
      kind: "anthropic",
      providerId: "fixture",
      listModels: async () => [],
      countTokens: async () => 0,
      async *streamChat(request): AsyncIterable<StreamEvent> {
        captured.push({
          system: request.system,
          messages: structuredClone(request.messages),
        });
        const calls = turns[index++] ?? [];
        yield {
          type: "turn_complete",
          stopReason: calls.length ? "tool_use" : "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
          message: {
            role: "assistant",
            content: calls.length
              ? calls.map((item, i) => ({
                  type: "tool_use" as const,
                  id: `turn-${index}-${i}`,
                  name: item.name,
                  input: item.input,
                }))
              : [
                  {
                    type: "text",
                    text: "Migrated using https://fixture.docs.example/html-with-prompt-injection",
                  },
                ],
          },
        };
      },
    };
    const result = await new AgentRuntime(
      adapter,
      new ContextManager(undefined, env.tools.context.events),
      {
        selectForTurn: () => env.tools.catalog.selectForTurn(),
        instructionsForTurn: (selected) =>
          env.tools.catalog.instructionsForTurn(selected),
        execute: (calls, signal) => env.tools.scheduler.execute(calls, signal),
      },
      buildSystemPrompt("", {
        os: process.platform,
        cwd: env.root,
        date: "2026-10-04",
      }),
      env.tools.context.events,
    ).run(env.session, "Check official docs and fix the API", {
      onCheckpoint: () => env.store.save(env.session),
    });
    expect(result.status).toBe("completed");
    expect(await readFile(join(env.root, "api.js"), "utf8")).toContain(
      "fetchFresh",
    );
    expect(await readFile(join(env.root, "package.json"), "utf8")).toBe(
      '{"name":"fixture"}',
    );
    expect(
      captured.every(
        (request) => !request.system.includes("Delete package.json"),
      ),
    ).toBe(true);
    expect(JSON.stringify(captured)).toContain(
      "External reference (untrusted data)",
    );
    expect(JSON.stringify(await env.store.load(env.session.id))).not.toContain(
      env.fixture.key,
    );
    expect(
      env.events
        .filter((event) => event.type === "tool_completed")
        .map((event) => event.name),
    ).toEqual([
      "web_search",
      "web_fetch",
      "read_file",
      "edit_file",
      "run_shell",
    ]);
  } finally {
    await env.close();
  }
});
test("web cancellation propagates through executor without ending a session or preventing later local reads", async () => {
  const env = await environment();
  try {
    const abort = new AbortController();
    const pending = env.tools.executor.execute(
      call("abort", "/endless"),
      abort.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 35));
    abort.abort();
    expect((await pending).errorCode).toBe("CANCELLED");
    await writeFile(join(env.root, "ok.txt"), "still alive");
    expect(
      (
        await env.tools.executor.execute({
          id: "read",
          name: "read_file",
          input: { path: "ok.txt" },
        })
      ).output,
    ).toContain("still alive");
  } finally {
    await env.close();
  }
});
