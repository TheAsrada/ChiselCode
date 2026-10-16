import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionToolRuntime } from "../../src/app/tool-runtime.js";
import {
  type BackgroundOwnerBinding,
  BackgroundTaskService,
} from "../../src/background/service.js";
import {
  DEFAULT_PROJECT_CONFIG,
  loadGlobalConfig,
} from "../../src/config/load.js";
import { createBackgroundExtension } from "../../src/extensions/builtins/background.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { WorktreeService } from "../../src/worktrees/service.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-background-owner-")),
  );
  const key = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
  const previous = process.env[key];
  process.env[key] = directory;
  cleanups.push(async () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const root = join(directory, "Проект");
  const alias = join(directory, "Ссылка на проект");
  await mkdir(root);
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const service = new BackgroundTaskService(new WorktreeService());
  const host = new ExtensionHost([createBackgroundExtension(service)]);
  cleanups.push(() => host.dispose());
  const scope = await host.open(alias);
  const store = await projectSessionStore(root);
  const session = store.create("openai", "fixture");
  await store.save(session);
  const owner = new AbortController();
  const binding: BackgroundOwnerBinding = {
    root: alias,
    scope,
    session,
    store,
    conversationId: "restored-conversation",
    generation: 1,
    signal: owner.signal,
    assertAvailable: () => scope.assertUsable(),
    config: DEFAULT_PROJECT_CONFIG,
    global: await loadGlobalConfig(join(directory, "config.json")),
    interactive: true,
    redactor: new SecretRedactor(),
  };
  return { service, binding, owner };
}

test("restored background owner and the next tool runtime share canonical workspace and generation", async () => {
  const { service, binding } = await fixture();
  const restored = await service.bind(binding);
  const equivalentRoot =
    process.platform === "win32"
      ? binding.scope.workspaceRoot.toUpperCase().replaceAll("\\", "/")
      : `${binding.scope.workspaceRoot}/.`;
  await service.bind({ ...binding, root: equivalentRoot });
  let controls: ReturnType<BackgroundTaskService["controls"]> | undefined;
  const tools = await createSessionToolRuntime({
    ...binding,
    mode: "build",
    approvalMode: "default",
    options: {
      interactive: true,
      subagentOwner: binding,
    },
    approvalOwner: {
      rootOwnerId: binding.session.id,
      sessionId: binding.session.id,
      generation: binding.generation,
      mode: "build",
      cwd: binding.scope.workspaceRoot,
    },
    events: new RuntimeEventBus(binding.session.id),
    resolver: { requestApproval: async () => "approved" },
    onBackgroundControls: (value) => {
      controls = value;
    },
  });
  try {
    expect(await restored.port.list()).toEqual([]);
    expect(await controls?.port.list()).toEqual([]);
    expect(await controls?.list()).toEqual([]);
  } finally {
    await tools.dispose();
  }
});

test("a live background owner rejects another conversation or generation", async () => {
  const { service, binding } = await fixture();
  const original = await service.bind(binding);
  for (const change of [
    { conversationId: "another-conversation" },
    { generation: binding.generation + 1 },
    { root: join(binding.root, "..") },
  ])
    await expect(service.bind({ ...binding, ...change })).rejects.toMatchObject(
      {
        code: "BACKGROUND_OWNER_CLOSED",
      },
    );
  expect(await original.port.list()).toEqual([]);
});

test("concurrent initial bindings cannot replace a live conversation owner", async () => {
  const { service, binding } = await fixture();
  const results = await Promise.allSettled([
    service.bind(binding),
    service.bind({ ...binding, conversationId: "another-conversation" }),
  ]);
  expect(results[0]?.status).toBe("fulfilled");
  expect(results[1]?.status).toBe("rejected");
});

test("background controls use the same effective generation as the tool binding", async () => {
  const { binding } = await fixture();
  const checks: Promise<unknown>[] = [];
  const tools = await createSessionToolRuntime({
    ...binding,
    mode: "build",
    approvalMode: "default",
    options: { interactive: true },
    approvalOwner: {
      rootOwnerId: binding.session.id,
      sessionId: binding.session.id,
      generation: binding.generation,
      mode: "build",
      cwd: binding.scope.workspaceRoot,
    },
    events: new RuntimeEventBus(binding.session.id),
    resolver: { requestApproval: async () => "approved" },
    onBackgroundControls: (controls) => {
      expect(controls).toBeDefined();
      checks.push(controls.port.list(), controls.list());
    },
  });
  try {
    expect(await Promise.all(checks)).toEqual([[], []]);
  } finally {
    await tools.dispose();
  }
});

test("an abort during restoration cannot leave a background owner registered", async () => {
  const { service, binding, owner } = await fixture();
  const list = service.storage.list.bind(service.storage);
  service.storage.list = async (id) => {
    const records = await list(id);
    owner.abort();
    return records;
  };
  try {
    await expect(service.bind(binding)).rejects.toMatchObject({
      code: "CANCELLED",
    });
  } finally {
    service.storage.list = list;
  }
  const restored = await service.bind({
    ...binding,
    conversationId: "reopened-conversation",
    signal: new AbortController().signal,
  });
  expect(await restored.port.list()).toEqual([]);
});

test("closing during reconciliation cannot publish a background owner after cleanup", async () => {
  const { service, binding } = await fixture();
  const fenced = service.storage.fencedTaskIds.bind(service.storage);
  service.storage.fencedTaskIds = async (id) => {
    const ids = await fenced(id);
    await service.closeOwner(id);
    return ids;
  };
  try {
    await expect(service.bind(binding)).rejects.toMatchObject({
      code: "BACKGROUND_OWNER_CLOSED",
    });
  } finally {
    service.storage.fencedTaskIds = fenced;
  }
  const restored = await service.bind({
    ...binding,
    conversationId: "reopened-after-cleanup",
  });
  expect(await restored.port.list()).toEqual([]);
});
