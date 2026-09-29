import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkProviderConnection,
  listProviderModels,
} from "../../src/commands/run.js";
import { saveGlobalConfig } from "../../src/config/load.js";

describe("settings connection check", () => {
  test("reports a missing API key without touching the network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-conn-"));
    const configPath = join(directory, "config.json");
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await saveGlobalConfig({ providers: {} }, configPath);
      const result = await checkProviderConnection(
        { provider: "openai-compatible" },
        { configPath },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Нет API-ключа");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports a missing base URL without touching the network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-conn-"));
    const configPath = join(directory, "config.json");
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      await saveGlobalConfig({ providers: {} }, configPath);
      const result = await checkProviderConnection(
        {
          provider: "openai-compatible",
          baseUrl: undefined,
          model: "gpt-5.6-sol",
        },
        { configPath },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("baseUrl");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("reports an unreachable server instead of hanging", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-conn-"));
    const configPath = join(directory, "config.json");
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      await saveGlobalConfig({ providers: {} }, configPath);
      const result = await checkProviderConnection(
        {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "gpt-5.6-sol",
        },
        { configPath },
      );
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("model listing reports a missing API key without touching the network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-conn-"));
    const configPath = join(directory, "config.json");
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await saveGlobalConfig({ providers: {} }, configPath);
      const result = await listProviderModels(
        { provider: "openai-compatible" },
        { configPath },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Нет API-ключа");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("check uses a freshly typed key instead of the stored one", async () => {
    // Кнопка «Проверить подключение» тестирует то, что на экране: введённый,
    // но ещё не сохранённый ключ имеет приоритет — вместо «Нет API-ключа»
    // запрос уходит в сеть (здесь — в глухую).
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-conn-"));
    const configPath = join(directory, "config.json");
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await saveGlobalConfig({ providers: {} }, configPath);
      const result = await checkProviderConnection(
        {
          provider: "openai-compatible",
          apiKey: "sk-freshly-typed",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "gpt-5.6-sol",
        },
        { configPath },
      );
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain("Нет API-ключа");
      expect(result.message.length).toBeGreaterThan(0);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
