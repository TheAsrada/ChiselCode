import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionProjectsDir, sessionsRootDir } from "../../src/paths/home.js";
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
});
