import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHistoryCatalog } from "../../src/sessions/history.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { filterSessions } from "../../src/ui/session-filter.js";

test("global history preserves project identity, rejects ambiguous refs and reads damaged indexes without rewriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-history-"));
  const environment = Object.fromEntries(
    ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA"].map(
      (key) => [key, process.env[key]],
    ),
  );
  for (const key of Object.keys(environment))
    process.env[key] = join(directory, "home");
  try {
    const a = await projectSessionStore(join(directory, "Alpha"));
    const b = await projectSessionStore(join(directory, "Beta"));
    const first = a.create("openai", "fixture");
    first.title = "Проверка индекса";
    await a.save(first);
    // A copied legacy UUID must remain two distinct choices.
    const copy = {
      ...first,
      projectPath: b.project.path,
      title: "Другой проект",
    };
    await b.save(copy);
    const indexPath = join(a.directory, "index.json");
    await writeFile(indexPath, "broken-index");
    const history = new SessionHistoryCatalog();
    const entries = await history.list();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.summary.id)).size).toBe(2);
    expect(await readFile(indexPath, "utf8")).toBe("broken-index");
    expect(
      (await history.resolve(`${a.projectId}:${first.id}`)).store.projectId,
    ).toBe(a.projectId);
    await expect(history.resolve(first.id)).rejects.toThrow("неоднозначен");
    await expect(history.resolve("../index")).rejects.toThrow("Некорректный");
    await expect(history.resolve("ffffffffff")).rejects.toThrow("не найдена");
    const summaries = entries.map((entry) => entry.summary);
    expect(
      filterSessions(summaries, "Beta Другой").map((item) => item.projectPath),
    ).toEqual([b.project.path]);
    expect(filterSessions(summaries, a.project.path)).toHaveLength(1);
    expect(await readFile(indexPath, "utf8")).toBe("broken-index");
  } finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
