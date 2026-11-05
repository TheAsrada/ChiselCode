import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatGptAuth,
  type ChatGptFetch,
} from "../../src/extensions/builtins/chatgpt/auth.js";
import { createChatGptExtension } from "../../src/extensions/builtins/chatgpt/index.js";
import { ChatGptTransport } from "../../src/extensions/builtins/chatgpt/transport.js";
import {
  ChatGptUsage,
  usageUi,
} from "../../src/extensions/builtins/chatgpt/usage.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { resolveProviderRuntime } from "../../src/providers/runtime.js";
import type { ProviderRequest, StreamEvent } from "../../src/types/domain.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
export function jwt(
  account: string,
  exp = Math.floor(Date.now() / 1000) + 3600,
) {
  return `header.${Buffer.from(JSON.stringify({ exp, email: `${account}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
}
async function fixture(fetch: ChatGptFetch) {
  const root = await mkdtemp(join(tmpdir(), "chisel-chatgpt-"));
  roots.push(root);
  const secrets = new Map<string, string>();
  const credentials = {
    async get(key: string) {
      return secrets.get(key);
    },
    async set(key: string, value: string) {
      secrets.set(key, value);
    },
    async delete(key: string) {
      secrets.delete(key);
    },
  };
  return {
    root,
    secrets,
    options: { fetch, credentials, lockDirectory: root },
  };
}
function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}
function loginFetch(url: string | URL | Request) {
  const path = new URL(
    typeof url === "string" || url instanceof URL ? url : url.url,
  ).pathname;
  if (path.endsWith("/usercode"))
    return json({
      device_auth_id: "device",
      user_code: "ABCD-1234",
      interval: "1",
    });
  if (path.endsWith("/deviceauth/token"))
    return json({ authorization_code: "code", code_verifier: "verifier" });
  if (path === "/oauth/token")
    return json({
      access_token: jwt("personal"),
      id_token: jwt("personal"),
      refresh_token: "refresh-personal",
      expires_in: 3600,
    });
  throw new Error(`Unexpected request ${path}`);
}
async function login(auth: ChatGptAuth, profileId = "personal") {
  return auth.connect({
    profileId,
    signal: new AbortController().signal,
    challenge() {},
  });
}
const request: ProviderRequest = {
  model: "codex-test",
  system: "system",
  messages: [{ role: "user", content: [{ type: "text", text: "Задача" }] }],
  tools: [
    {
      name: "ext:test.reader:read",
      description: "Read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      requiresApproval: false,
    },
  ],
};
function sse(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("device login stores each account separately and never sends API keys or follows redirects", async () => {
  const seen: string[] = [];
  const f = await fixture(async (url, init) => {
    expect(init?.redirect).toBe("error");
    seen.push(String(url));
    return loginFetch(url);
  });
  const auth = new ChatGptAuth(f.options);
  const challenges: unknown[] = [];
  await auth.connect({
    profileId: "personal",
    signal: new AbortController().signal,
    challenge: (value) => challenges.push(value),
  });
  expect(challenges[0]).toMatchObject({
    url: "https://auth.openai.com/codex/device",
    code: "ABCD-1234",
  });
  expect((await auth.status("personal")).label).toBe("personal@example.test");
  expect((await auth.status("work")).connected).toBe(false);
  await login(auth, "work");
  await auth.disconnect("personal");
  expect((await auth.status("personal")).connected).toBe(false);
  expect((await auth.status("work")).connected).toBe(true);
  expect(seen.every((url) => url.startsWith("https://auth.openai.com/"))).toBe(
    true,
  );
});

test("cancelled and rejected device login preserve a previous account and stop polling", async () => {
  let pending = false;
  let polls = 0;
  const abort = new AbortController();
  const f = await fixture(async (url) => {
    if (pending && String(url).endsWith("/deviceauth/token")) {
      polls++;
      abort.abort();
      return new Response(null, { status: 403 });
    }
    return loginFetch(url);
  });
  const auth = new ChatGptAuth(f.options);
  await login(auth);
  const before = [...f.secrets];
  pending = true;
  await expect(
    auth.connect({
      profileId: "personal",
      signal: abort.signal,
      challenge() {},
    }),
  ).rejects.toThrow();
  expect([...f.secrets]).toEqual(before);
  expect(polls).toBe(1);
});

test("concurrent expired sessions refresh once, preserve token rotation, and disconnect prevents reuse", async () => {
  let refreshes = 0;
  const f = await fixture(async (url, init) => {
    if (
      String(url).endsWith("/oauth/token") &&
      String(init?.body).includes("refresh_token")
    ) {
      refreshes++;
      return json({
        access_token: jwt("personal"),
        refresh_token: "rotated",
        expires_in: 3600,
      });
    }
    return loginFetch(url);
  });
  const auth = new ChatGptAuth(f.options);
  await login(auth);
  const key = "subscription:chatgpt:personal";
  f.secrets.set(
    key,
    JSON.stringify({ ...JSON.parse(f.secrets.get(key) ?? "{}"), expiresAt: 1 }),
  );
  const [a, b] = await Promise.all([
    auth.sessionFor("personal"),
    auth.sessionFor("personal"),
  ]);
  expect(a.refreshToken).toBe("rotated");
  expect(b).toEqual(a);
  expect(refreshes).toBe(1);
  await auth.disconnect("personal");
  await expect(auth.sessionFor("personal")).rejects.toThrow("Войдите");
});

test("extension registers a real runtime provider; subscription credentials cannot be redirected or replaced by API keys", async () => {
  const f = await fixture(async (url) => loginFetch(url));
  const extension = createChatGptExtension(f.options);
  const registry = new ProviderRegistry();
  registry.registerContribution(extension.providers![0]!, extension.id);
  const runtime = await resolveProviderRuntime({
    profile: { providerId: "chatgpt" },
    profileId: "personal",
    registry,
    apiKey: "never-send",
    environment: { OPENAI_API_KEY: "never-send" },
    credentials: {
      async get() {
        throw new Error("API key store must not be read");
      },
    },
  });
  expect(runtime.adapter.providerId).toBe("chatgpt");
  await expect(runtime.adapter.listModels!()).rejects.toThrow("Войдите");
  await expect(
    resolveProviderRuntime({
      profile: { providerId: "chatgpt", baseUrl: "https://evil.example" },
      profileId: "personal",
      registry,
    }),
  ).rejects.toThrow("фиксирован");
  expect(registry.source("chatgpt")).toEqual({
    type: "extension",
    extensionId: "builtin.chatgpt",
  });
});

test("Responses normalizes text, namespaced tools, usage and terminal events", async () => {
  let body: Record<string, unknown> = {};
  const f = await fixture(async (url, init) => {
    if (String(url).includes("/codex/responses")) {
      body = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(
        "personal",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${jwt("personal")}`,
      );
      const tools = body.tools as { name: string }[];
      return sse([
        { type: "response.output_text.delta", delta: "Проверю" },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Проверю" }],
              },
              {
                type: "function_call",
                call_id: "call-1",
                name: tools[0]?.name,
                arguments: '{"path":"README.md"}',
              },
            ],
            usage: {
              input_tokens: 42,
              output_tokens: 9,
              input_tokens_details: { cached_tokens: 12 },
            },
          },
        },
      ]);
    }
    return loginFetch(url);
  });
  const extension = createChatGptExtension(f.options);
  const provider = extension.providers![0]!;
  await provider.connection!.connect({
    profileId: "personal",
    signal: new AbortController().signal,
    challenge() {},
  });
  const adapter = provider.create({
    definition: provider.definition,
    profile: { providerId: "chatgpt" },
    profileId: "personal",
  });
  const events = await Array.fromAsync(adapter.streamChat(request));
  expect(body.store).toBe(false);
  expect(body.max_output_tokens).toBeUndefined();
  expect(events.find((event) => event.type === "tool_call")).toMatchObject({
    call: {
      id: "call-1",
      name: request.tools[0]?.name,
      input: { path: "README.md" },
    },
  });
  expect(events.at(-1)).toMatchObject({
    type: "turn_complete",
    stopReason: "tool_use",
    usage: {
      inputTokens: 42,
      contextInputTokens: 42,
      outputTokens: 9,
      cacheReadTokens: 12,
    },
  });
});

for (const scenario of [
  "truncated",
  "invalid-tool",
  "incomplete",
  "rate-limit",
] as const)
  test(`Responses rejects ${scenario} without emitting executable tools or a successful turn`, async () => {
    const f = await fixture(async (url) => {
      if (!String(url).includes("/responses")) return loginFetch(url);
      if (scenario === "rate-limit")
        return new Response("not logged", {
          status: 429,
          headers: { "Retry-After": "4" },
        });
      if (scenario === "truncated")
        return sse([{ type: "response.output_text.delta", delta: "часть" }]);
      if (scenario === "incomplete")
        return sse([{ type: "response.incomplete" }]);
      return sse([
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "call-1",
                name: "read_file",
                arguments: '{"path":',
              },
            ],
          },
        },
      ]);
    });
    const extension = createChatGptExtension(f.options);
    const provider = extension.providers![0]!;
    await provider.connection!.connect({
      profileId: "personal",
      signal: new AbortController().signal,
      challenge() {},
    });
    const adapter = provider.create({
      definition: provider.definition,
      profile: { providerId: "chatgpt" },
      profileId: "personal",
    });
    const events: StreamEvent[] = await Array.fromAsync(
      adapter.streamChat(request),
    );
    expect(
      events.some(
        (event) => event.type === "tool_call" || event.type === "turn_complete",
      ),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code:
        scenario === "rate-limit"
          ? "rate_limit"
          : scenario === "invalid-tool"
            ? "invalid_tool_arguments"
            : scenario === "incomplete"
              ? "output_truncated"
              : "transport",
    });
    if (scenario === "rate-limit")
      expect(events.at(-1)).toMatchObject({ retryAfterMs: 4000 });
  });

test("quota uses observed windows, caches per profile, updates from headers and marks failures as stale", async () => {
  let usageCalls = 0;
  const f = await fixture(async (url) => {
    if (!String(url).includes("/wham/usage")) return loginFetch(url);
    usageCalls++;
    return json({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 22,
          limit_window_seconds: 18000,
          reset_at: 1800000000,
        },
        secondary_window: { used_percent: 65, limit_window_seconds: 604800 },
      },
    });
  });
  const auth = new ChatGptAuth(f.options);
  await login(auth);
  const usage = new ChatGptUsage(new ChatGptTransport(auth, f.options.fetch));
  const one = await usage.read("personal");
  expect(one.windows.map((window) => window.remaining)).toEqual([78, 35]);
  expect(usageUi(one).rows?.[0]?.value).toContain("78%");
  await usage.read("personal");
  expect(usageCalls).toBe(1);
  const missing = await usage.read("work");
  expect(missing.windows).toHaveLength(0);
  expect(usageUi(missing).state).toBe("unavailable");
  usage.headers(
    "personal",
    new Headers({
      "x-codex-primary-used-percent": "95",
      "x-codex-primary-window-minutes": "300",
    }),
  );
  expect((await usage.read("personal")).windows[0]?.remaining).toBe(5);
  expect(usageUi(await usage.read("personal")).tone).toBe("warning");
  expect(
    (await usage.read("personal")).windows.find(
      (window) => window.id === "secondary",
    )?.remaining,
  ).toBe(35);
});
