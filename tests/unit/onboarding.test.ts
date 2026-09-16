import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingApiKeyError } from "../../src/commands/run.js";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/load.js";
import {
  AGENTROUTER_BASE_URL,
  AGENTROUTER_DEFAULT_MODEL,
  defaultBaseUrlForProvider,
} from "../../src/providers/agentrouter.js";
import { ProviderKindSchema } from "../../src/types/domain.js";
import { defaultModelFor, isValidApiUrl } from "../../src/ui/setup.js";

describe("onboarding", () => {
  test("saves and loads global configuration without credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-test-"));
    const path = join(directory, "config.json");
    try {
      await Bun.write(path, '{"providers": {}}\n');
      await saveGlobalConfig(
        {
          defaultProvider: "anthropic",
          defaultModel: "claude-opus-5",
          providers: {
            anthropic: {
              provider: "anthropic",
              apiKeyRef: "anthropic-default",
              defaultModel: "claude-opus-5",
            },
          },
        },
        path,
      );
      expect(await loadGlobalConfig(path)).toMatchObject({
        defaultProvider: "anthropic",
        providers: { anthropic: { apiKeyRef: "anthropic-default" } },
      });
      expect(await readFile(path, "utf8")).not.toContain("test-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("saves Anthropic-compatible proxy configuration without credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-test-"));
    const path = join(directory, "config.json");
    try {
      await saveGlobalConfig(
        {
          defaultProvider: "anthropic-compatible",
          defaultModel: "gpt-5.6-terra",
          providers: {
            "anthropic-compatible": {
              provider: "anthropic-compatible",
              apiKeyRef: "anthropic-compatible-default",
              baseUrl: "https://proxy.example.test",
              defaultModel: "gpt-5.6-terra",
            },
          },
        },
        path,
      );
      expect(await loadGlobalConfig(path)).toMatchObject({
        defaultProvider: "anthropic-compatible",
        providers: {
          "anthropic-compatible": {
            apiKeyRef: "anthropic-compatible-default",
            baseUrl: "https://proxy.example.test",
          },
        },
      });
      expect(await readFile(path, "utf8")).not.toContain("test-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("validates setup defaults and compatible API addresses", () => {
    expect(ProviderKindSchema.parse("agentrouter")).toBe("agentrouter");
    expect(defaultModelFor("anthropic")).toBe("claude-opus-5");
    expect(defaultModelFor("openai-compatible")).toBe("");
    expect(defaultModelFor("agentrouter")).toBe(AGENTROUTER_DEFAULT_MODEL);
    expect(defaultBaseUrlForProvider("agentrouter")).toBe(AGENTROUTER_BASE_URL);
    expect(isValidApiUrl(AGENTROUTER_BASE_URL)).toBe(true);
    expect(isValidApiUrl("http://localhost:11434/v1")).toBe(true);
    expect(isValidApiUrl("https://api.example.com/v1")).toBe(true);
    expect(isValidApiUrl("localhost:11434/v1")).toBe(false);
  });

  test("saves AgentRouter gateway configuration without credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-test-"));
    const path = join(directory, "config.json");
    try {
      await saveGlobalConfig(
        {
          defaultProvider: "agentrouter",
          defaultModel: AGENTROUTER_DEFAULT_MODEL,
          providers: {
            agentrouter: {
              provider: "agentrouter",
              apiKeyRef: "agentrouter-default",
              baseUrl: AGENTROUTER_BASE_URL,
              defaultModel: AGENTROUTER_DEFAULT_MODEL,
            },
          },
        },
        path,
      );
      expect(await loadGlobalConfig(path)).toMatchObject({
        defaultProvider: "agentrouter",
        providers: {
          agentrouter: {
            apiKeyRef: "agentrouter-default",
            baseUrl: AGENTROUTER_BASE_URL,
          },
        },
      });
      expect(await readFile(path, "utf8")).not.toContain("test-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("gives a safe, actionable missing-key error", () => {
    const error = new MissingApiKeyError("anthropic");
    expect(error.message).toContain("chisel setup");
    expect(error.message).not.toContain("test-secret");
  });
});
