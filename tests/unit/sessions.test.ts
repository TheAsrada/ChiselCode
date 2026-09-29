import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteSession,
  formatSessionList,
  listSessions,
  resolveSessionRef,
  sessionTitleForPrompt,
} from "../../src/sessions/store.js";
import type { Session } from "../../src/types/domain.js";

function makeSession(partial: Partial<Session> & { id: string }): Session {
  return {
    projectPath: "C:\\proj",
    messages: [],
    model: "gpt-5.6-sol",
    provider: "openai-compatible",
    totalTokens: {
      inputTokens: 0,
      outputTokens: 0,
    },
    totalCost: 0,
    undoStack: [],
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T12:00:00.000Z",
    ...partial,
  };
}

describe("session helpers", () => {
  test("legacy sessions copy into ChiselCode Home once without removing originals", async () => {
    const root = await mkdtemp(join(tmpdir(), "chiselcode-sessions-home-"));
    const previousLocal = process.env.LOCALAPPDATA;
    const previousApp = process.env.APPDATA;
    const previousXdg = process.env.XDG_DATA_HOME;
    const previousConfig = process.env.XDG_CONFIG_HOME;
    process.env.LOCALAPPDATA = join(root, "local");
    process.env.APPDATA = join(root, "roaming");
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.XDG_CONFIG_HOME = join(root, "config");
    try {
      const legacy =
        process.platform === "win32"
          ? join(root, "roaming", "chiselcode", "sessions")
          : join(root, "config", "chiselcode", "sessions");
      await mkdir(legacy, { recursive: true });
      const id = "12345678-aaaa-bbbb-cccc-ddeeff001122";
      const projectPath = join(root, "project");
      const text = JSON.stringify(makeSession({ id, projectPath }));
      await writeFile(join(legacy, `${id}.json`), text);
      expect(
        (await listSessions(projectPath)).map((session) => session.id),
      ).toContain(id);
      expect(await readFile(join(legacy, `${id}.json`), "utf8")).toBe(text);
      await deleteSession(id, projectPath);
      expect(
        (await listSessions(projectPath)).map((session) => session.id),
      ).not.toContain(id);
      expect(await readFile(join(legacy, `${id}.json`), "utf8")).toBe(text);
    } finally {
      for (const [key, value] of [
        ["LOCALAPPDATA", previousLocal],
        ["APPDATA", previousApp],
        ["XDG_DATA_HOME", previousXdg],
        ["XDG_CONFIG_HOME", previousConfig],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  test("builds a title from the first prompt line", () => {
    expect(sessionTitleForPrompt("  почини баг  ")).toBe("почини баг");
    expect(sessionTitleForPrompt("первая строка\nвторая строка")).toBe(
      "первая строка",
    );
    expect(sessionTitleForPrompt("x".repeat(100))).toBe(`${"x".repeat(60)}…`);
    expect(sessionTitleForPrompt("")).toBe("");
  });

  test("formats an empty session list", () => {
    expect(formatSessionList([])).toContain("пока нет");
  });

  test("formats sessions with titles, tokens and short ids", () => {
    const text = formatSessionList([
      makeSession({
        id: "12345678-aaaa-bbbb-cccc-ddeeff001122",
        title: "почини баг",
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
        totalTokens: { inputTokens: 1000, outputTokens: 500 },
      }),
      makeSession({ id: "abcdef01-0000-0000-0000-000000000000" }),
    ]);
    expect(text).toContain("Сессии проекта:");
    expect(text).toContain("1. почини баг");
    expect(text).toContain("2 сообщ.");
    expect(text).toContain("1500 токенов");
    expect(text).toContain("12345678");
    expect(text).toContain("без названия");
  });

  test("resolves sessions by number or id prefix", () => {
    const first = makeSession({ id: "aaa11111-0000-0000-0000-000000000000" });
    const second = makeSession({ id: "bbb22222-0000-0000-0000-000000000000" });
    const list = [first, second];
    expect(resolveSessionRef(list, "1")).toBe(first);
    expect(resolveSessionRef(list, "2")).toBe(second);
    expect(resolveSessionRef(list, "bbb2")).toBe(second);
    expect(resolveSessionRef(list, "AAA11111")).toBe(first);
    expect(resolveSessionRef(list, "0")).toBeUndefined();
    expect(resolveSessionRef(list, "3")).toBeUndefined();
    expect(resolveSessionRef(list, "zzz")).toBeUndefined();
    expect(resolveSessionRef(list, "")).toBeUndefined();
    expect(resolveSessionRef(list, "  ")).toBeUndefined();
  });
});
