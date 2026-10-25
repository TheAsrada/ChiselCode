import { expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { ContextManager } from "../../src/context/context-manager.js";
import { buildSystemPrompt } from "../../src/core/prompt.js";
import { userSkillsDir } from "../../src/paths/home.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../src/security/approval.js";
import { createSession } from "../../src/sessions/store.js";
import { readSkillReference } from "../../src/skills/references.js";
import { RemoteSkills } from "../../src/skills/remote.js";
import { loadSkills } from "../../src/skills/skills.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import type { ProviderAdapter, StreamEvent } from "../../src/types/domain.js";
import { SafeWebHttpClient } from "../../src/web/http-client.js";
import { WebConfigSchema } from "../../src/web/schema.js";
import { UrlPolicy } from "../../src/web/url-policy.js";
import {
  importedSkill,
  skillCommit,
  skillSourceHttp,
} from "../fixtures/skill-source-http.js";

async function fixture(
  options: {
    denyNetwork?: boolean;
    denyWrite?: boolean;
    mode?: "plan" | "build";
    signal?: AbortSignal;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "chisel-install-"));
  const oldData = process.env.XDG_DATA_HOME,
    oldLocal = process.env.LOCALAPPDATA;
  process.env.XDG_DATA_HOME = directory;
  process.env.LOCALAPPDATA = directory;
  const api = skillSourceHttp();
  const server = createServer(api.handle);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const config = WebConfigSchema.parse(
    options.denyNetwork ? { permissions: { fetch: "deny" } } : {},
  );
  const client = new SafeWebHttpClient(
    config.limits,
    new UrlPolicy(async () => [{ address: "93.184.216.34", family: 4 }]),
    (target, init, onResponse) =>
      request(
        {
          ...init,
          hostname: "127.0.0.1",
          port,
          path: target.url.pathname + target.url.search,
          agent: false,
        },
        onResponse,
      ),
  );
  const session = createSession(directory, "test", "scripted");
  const approvals: ApprovalRequest[] = [];
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    {
      autoApprove: false,
      approvalMode: "default",
      allowedTools: new Set(),
      nonInteractive: false,
      network: { scope: directory, config },
    },
    {
      async requestApproval(value) {
        approvals.push(value);
        return options.denyWrite ? "denied" : "approved";
      },
    },
  );
  const runtime = createLocalToolRuntime(directory, [], gate, session, [], {
    mode: options.mode ?? "build",
    signal: options.signal,
    remoteSkills: new RemoteSkills(client),
    skillsCatalog: () => loadSkills(directory),
    artifactDirectory: join(directory, "artifacts"),
  });
  let index = 0;
  return {
    directory,
    api,
    session,
    approvals,
    runtime,
    call: (name: string, input: Record<string, unknown>) =>
      runtime.executor.execute({ id: `install-${index++}`, name, input }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      if (oldData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldData;
      if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = oldLocal;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const input = {
  source: "npx skills add https://github.com/acme/repo --skill folder-name",
};

test("a direct HTTPS SKILL.md installs only that file and respects its registered name", async () => {
  const env = await fixture();
  try {
    const result = await env.call("install_skill", {
      source: "https://skills.example/standalone/SKILL.md",
    });
    expect(result.isError, result.output).not.toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      name: "ui-design",
      files: ["SKILL.md"],
    });
    expect(
      (await env.call("load_skill", { name: "ui-design" })).output,
    ).toContain("Read references/guide.md");
  } finally {
    await env.close();
  }
});

test("a single root skill can be selected by its frontmatter name, and invocation flags survive import", async () => {
  const permissions = { denyWrite: false };
  const env = await fixture(permissions);
  try {
    env.api.files.clear();
    env.api.files.set(
      "SKILL.md",
      Buffer.from(
        "---\nname: root-design\ndescription: Root skill.\ndisable-model-invocation: true\nuser-invocable: false\nallowed-tools: run_shell\n---\nDo not execute during installation.",
      ),
    );
    const result = await env.call("install_skill", {
      source: "npx skills add acme/repo --skill root-design",
    });
    expect(result.isError, result.output).not.toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      name: "root-design",
      modelInvocable: false,
      userInvocable: false,
    });
    expect(
      (await env.call("load_skill", { name: "root-design" })).isError,
    ).toBe(true);
    expect(env.approvals).toHaveLength(1);
    permissions.denyWrite = true;
    expect(
      (await env.call("run_shell", { command: "echo SHOULD_NOT_RUN" })).isError,
    ).toBe(true);
    expect(env.approvals).toHaveLength(2);
  } finally {
    await env.close();
  }
});

test("native installation pins the snapshot, retains binary assets and loads instructions/references immediately", async () => {
  const env = await fixture();
  try {
    const result = await env.call("install_skill", input);
    expect(result.isError, result.output).not.toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "installed",
      name: "ui-design",
      origin: { revision: skillCommit },
    });
    expect(env.approvals).toHaveLength(1);
    expect(env.approvals[0]?.preview).toContain(userSkillsDir());
    const target = join(userSkillsDir(), "ui-design");
    expect(await readFile(join(target, "SKILL.md"))).toEqual(importedSkill);
    expect(await readFile(join(target, "assets/pixel.bin"))).toEqual(
      Buffer.from([0, 255, 128, 13, 10]),
    );
    expect(
      (await env.call("load_skill", { name: "ui-design" })).output,
    ).toContain("Read references/guide.md");
    expect(
      (
        await env.call("load_skill", {
          name: "ui-design",
          path: "references/guide.md",
        })
      ).output,
    ).toContain("preserve keyboard navigation");
    expect(
      JSON.parse((await env.call("install_skill", input)).output).status,
    ).toBe("already_installed");
    await writeFile(join(target, "references/guide.md"), "user edit");
    expect((await env.call("install_skill", input)).isError).toBe(true);
    expect(await readFile(join(target, "references/guide.md"), "utf8")).toBe(
      "user edit",
    );
    expect(
      (await readdir(userSkillsDir())).filter((name) => name.startsWith(".")),
    ).toEqual([]);
    expect(
      env.api.hits.some((path) => path.includes(`/git/trees/${skillCommit}`)),
    ).toBe(true);
  } finally {
    await env.close();
  }
});

test("inspection resolves a monorepo folder and installation uses the inspected commit without rereading the branch", async () => {
  const env = await fixture();
  try {
    const inspected = await env.call("inspect_skills", {
      source: "https://github.com/acme/repo/tree/main/skills/folder-name",
    });
    expect(JSON.parse(inspected.output)).toMatchObject({
      status: "inspected",
      name: "ui-design",
    });
    const installed = await env.call("install_skill", {
      ...input,
      revision: skillCommit,
    });
    expect(installed.isError, installed.output).not.toBe(true);
    expect(
      env.api.hits.filter((path) => path.includes("/commits")),
    ).toHaveLength(1);
  } finally {
    await env.close();
  }
});

test("ambiguous and missing names never silently substitute or write a skill", async () => {
  const env = await fixture();
  try {
    const result = await env.call("inspect_skills", { source: "acme/repo" });
    expect(JSON.parse(result.output)).toMatchObject({
      status: "selection_required",
      total: 2,
    });
    expect(
      (await env.call("install_skill", { source: "acme/repo" })).isError,
    ).toBe(true);
    expect(
      (
        await env.call("install_skill", {
          source: "acme/repo",
          skill: "frontend-skill",
        })
      ).output,
    ).toContain("не найден");
    expect(
      env.api.hits.filter((path) => path.includes("/git/blobs/")),
    ).toHaveLength(0);
    expect(await readdir(userSkillsDir()).catch(() => [])).toEqual([]);
  } finally {
    await env.close();
  }
});

for (const options of [
  { denyWrite: true },
  { denyNetwork: true },
  { mode: "plan" as const },
])
  test(`normal permissions stop installation before network or writes: ${JSON.stringify(options)}`, async () => {
    const env = await fixture(options);
    try {
      expect((await env.call("install_skill", input)).isError).toBe(true);
      expect(env.api.hits).toHaveLength(0);
      expect(await readdir(userSkillsDir()).catch(() => [])).toEqual([]);
    } finally {
      await env.close();
    }
  });

test("parallel installs publish one complete directory; source symlinks and altered Git blobs are rejected", async () => {
  const env = await fixture();
  try {
    const results = await Promise.all([
      env.call("install_skill", input),
      env.call("install_skill", input),
    ]);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(
      results.map((result) => JSON.parse(result.output).status).sort(),
    ).toEqual(["already_installed", "installed"]);
    await rm(join(userSkillsDir(), "ui-design"), { recursive: true });
    env.api.corrupt = true;
    expect((await env.call("install_skill", input)).isError).toBe(true);
    env.api.corrupt = false;
    env.api.link = true;
    expect((await env.call("install_skill", input)).isError).toBe(true);
    expect(await readdir(userSkillsDir())).toEqual([]);
  } finally {
    await env.close();
  }
});

test("cancellation and redirected private addresses leave no installed directory", async () => {
  const abort = new AbortController();
  const env = await fixture({ signal: abort.signal });
  try {
    env.api.redirect = "http://127.0.0.1/private";
    expect((await env.call("install_skill", input)).isError).toBe(true);
    env.api.redirect = "";
    env.api.block = () => abort.abort();
    await env.call("install_skill", input).catch(() => {});
    expect(abort.signal.aborted).toBe(true);
    expect(await readdir(userSkillsDir()).catch(() => [])).toEqual([]);
  } finally {
    await env.close();
  }
});

test("a failed parallel asset preserves its integrity error while cancelling and draining other downloads", async () => {
  const env = await fixture();
  try {
    env.api.corruptAsset = true;
    env.api.holdReference = true;
    const result = await env.call("install_skill", input);
    expect(result.output).toContain("GitHub blob не совпадает");
    expect(result.errorCode).not.toBe("CANCELLED");
    expect(await readdir(userSkillsDir()).catch(() => [])).toEqual([]);
  } finally {
    await env.close();
  }
});

test("references cannot escape the managed skill or read binary assets", async () => {
  const env = await fixture();
  try {
    await env.call("install_skill", input);
    const root = join(userSkillsDir(), "ui-design");
    for (const path of [
      "../outside",
      "assets/pixel.bin",
      ".chisel-source.json",
    ])
      expect(
        (await env.call("load_skill", { name: "ui-design", path })).isError,
      ).toBe(true);
    if (process.platform !== "win32") {
      await symlink(join(root, "references"), join(root, "linked"));
      await expect(
        readSkillReference(root, "linked/guide.md"),
      ).rejects.toThrow();
    }
  } finally {
    await env.close();
  }
});

test("AgentRuntime continues install → load → reference in the same user task without activating skills", async () => {
  const env = await fixture();
  try {
    const turns = [
      [{ name: "install_skill", input }],
      [{ name: "load_skill", input: { name: "ui-design" } }],
      [
        {
          name: "load_skill",
          input: { name: "ui-design", path: "references/guide.md" },
        },
      ],
    ];
    let index = 0;
    const adapter: ProviderAdapter = {
      kind: "openai",
      providerId: "fixture",
      listModels: async () => [],
      countTokens: async () => 0,
      async *streamChat(request): AsyncIterable<StreamEvent> {
        if (index === 1)
          expect(JSON.stringify(request.messages)).not.toContain(
            "Read references/guide.md",
          );
        if (index === 3)
          expect(JSON.stringify(request.messages)).toContain(
            "preserve keyboard navigation",
          );
        const calls = turns[index++] ?? [];
        yield {
          type: "turn_complete",
          stopReason: calls.length ? "tool_use" : "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
          message: {
            role: "assistant",
            content: calls.length
              ? calls.map((call) => ({
                  type: "tool_use",
                  id: `skill-turn-${index}`,
                  ...call,
                }))
              : [{ type: "text", text: "Навык установлен и прочитан." }],
          },
        };
      },
    };
    const tools = env.runtime;
    const result = await new AgentRuntime(
      adapter,
      new ContextManager({}, tools.context.events),
      {
        selectForTurn: () => tools.catalog.selectForTurn(),
        instructionsForTurn: (selected) =>
          tools.catalog.instructionsForTurn(selected),
        execute: (calls, signal) => tools.scheduler.execute(calls, signal),
      },
      buildSystemPrompt("", {
        os: process.platform,
        cwd: env.directory,
        date: "2026-10-25",
      }),
      tools.context.events,
    ).run(env.session, "Установи навык и используй его для текущей задачи");
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(index).toBe(4);
  } finally {
    await env.close();
  }
});
