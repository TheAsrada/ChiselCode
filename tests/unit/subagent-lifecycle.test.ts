import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROJECT_CONFIG,
  loadGlobalConfig,
} from "../../src/config/load.js";
import { createSubagentExtension } from "../../src/extensions/builtins/subagents.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { attachExtensionTools } from "../../src/extensions/tools.js";
import { builtinDefinitions } from "../../src/providers/definitions/index.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import {
  type ChildRunInput,
  SubagentService,
} from "../../src/subagents/service.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import { WorktreeService } from "../../src/worktrees/service.js";

test("core lifecycle: durable FIFO, queued cancel, wait cancellation, duplicate operation and closed/depth/foreign owner fencing", async () => {
  const temp = await mkdtemp(join(tmpdir(), "chisel-child-lifecycle-"));
  const key = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
  const previous = process.env[key];
  process.env[key] = temp;
  const starts: ChildRunInput[] = [];
  let entered = () => {};
  let next = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const releases = new Map<string, () => void>();
  const service = new SubagentService(new WorktreeService(), async (input) => {
    starts.push(input);
    entered();
    await new Promise<void>((resolve) => {
      releases.set(input.record.id, resolve);
      input.abort.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    input.record.cleanup = { quiescent: true };
    input.record.status = input.abort.signal.aborted
      ? "cancelled"
      : "completed";
  });
  const host = new ExtensionHost([createSubagentExtension(service)]);
  try {
    const root = join(temp, "root");
    await mkdir(root);
    const configPath = join(temp, "global.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        profiles: {},
        subagents: { maxActive: 1 },
      }),
    );
    const global = await loadGlobalConfig(configPath);
    const scope = await host.open(root);
    const store = await projectSessionStore(root);
    const session = store.create("openai", "fixture-model");
    await store.save(session);
    const signal = new AbortController();
    const definition = builtinDefinitions.find((item) => item.id === "openai");
    if (!definition) throw new Error("Missing provider");
    const binding = {
      session,
      store,
      root,
      conversationId: session.id,
      generation: 0,
      signal: signal.signal,
      assertAvailable: () => scope.assertUsable(),
      scope,
      capturedModel: {
        definition,
        profileId: "fixture",
        profile: { providerId: definition.id },
        model: "fixture-model",
        capabilities: { tokenCounting: "local_estimate" as const },
      },
      config: DEFAULT_PROJECT_CONFIG,
      global,
      options: { configPath },
      approvalMode: "default" as const,
      resolver: { requestApproval: async () => "unavailable" as const },
      redactor: new SecretRedactor(),
      instructions: "",
    };
    let selectedModel = "selected-at-submit";
    const liveBinding = {
      ...binding,
      captureModel: () => ({ ...binding.capturedModel, model: selectedModel }),
    };
    const port = await service.bind(liveBinding);
    const tools = createLocalToolRuntime(
      root,
      [],
      new ApprovalGate(
        DEFAULT_PROJECT_CONFIG,
        { autoApprove: false, allowedTools: new Set(), nonInteractive: true },
        binding.resolver,
      ),
      session,
      [],
      { subagentTools: port },
    );
    const detach = await attachExtensionTools(scope, tools.catalog);
    const submit = (id: string, label: string) =>
      tools.executor.execute({
        id,
        name: "ext:builtin.subagents:submit_readonly",
        input: { task: "Изучи файл", label, context: "none" },
      });
    const a = JSON.parse((await submit("first", "Первая")).output);
    await next;
    expect(starts).toHaveLength(1);
    const b = JSON.parse((await submit("second", "Вторая")).output);
    const c = JSON.parse((await submit("third", "Третья")).output);
    selectedModel = "changed-after-submit";
    const control = service.controlFor(session.id, session.id, 0);
    expect((await control.status(b.id)).status).toBe("queued");
    await control.cancel(b.id);
    expect((await control.status(b.id)).status).toBe("cancelled");
    const duplicate = JSON.parse((await submit("first", "Первая")).output);
    expect(duplicate.id).toBe(a.id);
    expect(await control.list()).toHaveLength(3);
    const waiting = new AbortController();
    const wait = control.wait([a.id], 30000, waiting.signal);
    waiting.abort();
    await expect(wait).rejects.toThrow();
    expect(starts[0]?.abort.signal.aborted).toBe(false);
    next = new Promise<void>((resolve) => {
      entered = resolve;
    });
    releases.get(a.id)?.();
    await next;
    expect(starts.map((item) => item.record.id)).toEqual([a.id, c.id]);
    expect(starts[1]?.owner.capturedModel.model).toBe("selected-at-submit");
    expect(starts[1]?.record.model).toBe("selected-at-submit");
    await expect(control.status(crypto.randomUUID())).rejects.toThrow(
      "другому",
    );
    await service.closeOwner(session.id);
    expect(starts[1]?.abort.signal.aborted).toBe(true);
    await expect(control.list()).rejects.toThrow("закрыт");
    const child = {
      ...session,
      subagent: {
        id: crypto.randomUUID(),
        ownerId: session.id,
        parentRoot: root,
        mode: "readonly" as const,
        depth: 1 as const,
      },
    };
    await expect(service.bind({ ...binding, session: child })).rejects.toThrow(
      "делегировать",
    );
    await detach.dispose();
  } finally {
    for (const release of releases.values()) release();
    await service.dispose();
    await host.dispose();
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    await rm(temp, { recursive: true, force: true });
  }
}, 20000);
