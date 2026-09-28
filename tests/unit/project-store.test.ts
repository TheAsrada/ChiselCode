import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionProjectsDir, sessionsRootDir } from "../../src/paths/home.js";
import { withLock } from "../../src/sessions/lock.js";
import {
  projectSessionStore,
  SessionProjectRegistry,
} from "../../src/sessions/project-store.js";

let root: string;
let previous: string | undefined;
const variable =
  process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chisel-project-store-"));
  previous = process.env[variable];
  process.env[variable] = root;
});
afterEach(async () => {
  if (previous === undefined) delete process.env[variable];
  else process.env[variable] = previous;
  await rm(root, { recursive: true, force: true });
});

describe("project session storage", () => {
  test("old sessions load without a snapshot; a new snapshot persists and is invalidated on model switch", async () => {
    const store = await projectSessionStore(join(root, "work"));
    const old = store.create("anthropic", "model-one");
    await store.save(old);
    expect((await store.load(old.id)).contextSnapshot).toBeUndefined();
    old.contextSnapshot = {
      model: "model-one",
      observedInputTokens: 80,
      observedAt: new Date().toISOString(),
      source: "provider_usage",
      status: "observed",
    };
    await store.save(old);
    expect(
      (await store.load(old.id)).contextSnapshot?.observedInputTokens,
    ).toBe(80);
    await store.startNew(
      old.id,
      { provider: "anthropic", model: "model-one" },
      { model: "model-two" },
    );
    expect((await store.load(old.id)).contextSnapshot).toBeUndefined();
  });
  test("startNew saves the old conversation and creates a separate empty session", async () => {
    const store = await projectSessionStore(join(root, "work"));
    const old = store.create("anthropic", "old-model");
    old.messages.push({
      role: "user",
      content: [{ type: "text", text: "Старый разговор" }],
    });
    await store.save(old);
    const next = await store.startNew(
      old.id,
      { provider: "anthropic", model: "old-model" },
      { model: "new-model" },
    );
    expect(next.id).not.toBe(old.id);
    expect(next.messages).toEqual([]);
    expect(next.model).toBe("new-model");
    expect((await store.load(old.id)).messages).toHaveLength(1);
    expect((await store.list()).map((item) => item.id)).toEqual(
      expect.arrayContaining([old.id, next.id]),
    );
  });
  test("registry uses canonical path and keeps same-name projects separate", async () => {
    const a = join(root, "one", "same");
    const b = join(root, "two", "same");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    const first = await projectSessionStore(a);
    const again = await projectSessionStore(join(a, "..", "same"));
    const second = await projectSessionStore(b);
    expect(first.projectId).toBe(again.projectId);
    expect(second.projectId).not.toBe(first.projectId);
    expect((await new SessionProjectRegistry().list()).length).toBe(2);
    expect(
      JSON.parse(await readFile(join(first.directory, "project.json"), "utf8"))
        .id,
    ).toBe(first.projectId);
    expect((await readdir(sessionProjectsDir())).length).toBe(2);
  });
  test("saves individual validated sessions and repairs index without touching transcripts", async () => {
    const store = await projectSessionStore(join(root, "work"));
    const one = store.create("anthropic", "model-one");
    one.title = "Первый";
    const two = store.create("openai", "model-two");
    two.title = "Второй";
    await store.save(one);
    await store.save(two);
    expect(
      (await readdir(store.directory)).filter((name) =>
        /^[0-9a-f-]{36}\.json$/.test(name),
      ),
    ).toHaveLength(2);
    expect((await store.list()).map((item) => item.id)).toContain(one.id);
    expect((await store.load(one.id)).projectPath).toBe(store.project.path);
    expect(
      await readFile(join(store.directory, `${one.id}.json`), "utf8"),
    ).not.toContain('"projectPath"');
    expect(store.load("../projects.json")).rejects.toThrow();
    await writeFile(join(store.directory, "index.json"), "bad");
    expect((await store.list()).map((item) => item.id)).toContain(two.id);
    await rm(join(store.directory, "index.json"));
    expect(await store.list()).toHaveLength(2);
    await writeFile(join(store.directory, `${two.id}.json`), "bad");
    expect((await store.rebuildIndex()).map((item) => item.id)).toEqual([
      one.id,
    ]);
    await writeFile(join(store.directory, "not-a-session.json.tmp"), "bad");
    expect((await store.rebuildIndex()).map((item) => item.id)).toEqual([
      one.id,
    ]);
  });
  test("rename, delete, prefix resolution and registry recovery", async () => {
    const store = await projectSessionStore(join(root, "work"));
    const session = store.create("anthropic", "test");
    await store.save(session);
    await store.rename(session.id, "Название пользователя");
    expect((await store.load(session.id)).titleSource).toBe("user");
    expect((await store.getSummary(session.id))?.title).toBe(
      "Название пользователя",
    );
    expect((await store.resolve(session.id.slice(0, 8))).id).toBe(session.id);
    expect(store.resolve("../bad")).rejects.toThrow();
    await rm(join(sessionsRootDir(), "projects.json"));
    expect((await new SessionProjectRegistry().list())[0]?.id).toBe(
      store.projectId,
    );
    await store.delete(session.id);
    expect(await store.list()).toHaveLength(0);
    expect(await readdir(store.directory)).toContain("project.json");
  });
  test("two stores merge index changes instead of losing another session", async () => {
    const a = await projectSessionStore(join(root, "work"));
    const b = await projectSessionStore(join(root, "work"));
    const one = a.create("anthropic", "one");
    const two = b.create("anthropic", "two");
    await a.save(one);
    await b.save(two);
    await a.save(one);
    expect(new Set((await a.list()).map((item) => item.id))).toEqual(
      new Set([one.id, two.id]),
    );
  });
  test("recovers abandoned legacy locks without deleting sessions", async () => {
    const store = await projectSessionStore(join(root, "work"));
    const first = store.create("anthropic", "one");
    await store.save(first);
    const indexLock = join(store.directory, "index.json.lock");
    await mkdir(indexLock);
    const old = new Date(Date.now() - 60_000);
    await utimes(indexLock, old, old);
    const second = store.create("anthropic", "two");
    await store.save(second);
    expect(new Set((await store.list()).map((item) => item.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(await readdir(store.directory)).not.toContain("index.json.lock");

    const registryLock = join(sessionsRootDir(), "projects.json.lock");
    await mkdir(registryLock);
    await utimes(registryLock, old, old);
    await projectSessionStore(join(root, "another"));
    expect((await new SessionProjectRegistry().list()).length).toBe(2);
  });
  test("a second writer waits for an active lock", async () => {
    const store = await projectSessionStore(join(root, "work"));
    const indexPath = join(store.directory, "index.json");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const first = withLock(indexPath, async () => {
      entered = true;
      await held;
    });
    while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));
    const session = store.create("anthropic", "test");
    const second = store.save(session);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readdir(store.directory)).not.toContain(`${session.id}.json`);
    release();
    await Promise.all([first, second]);
    expect((await store.list()).map((item) => item.id)).toContain(session.id);
  });
  test("concurrent writers recover one abandoned lock and retain every session", async () => {
    const store = await projectSessionStore(join(root, "work"));
    const lock = join(store.directory, "index.json.lock");
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const sessions = Array.from({ length: 8 }, (_, index) =>
      store.create("anthropic", `model-${index}`),
    );
    await Promise.all(sessions.map((session) => store.save(session)));
    expect(new Set((await store.list()).map((item) => item.id))).toEqual(
      new Set(sessions.map((session) => session.id)),
    );
  });
});
