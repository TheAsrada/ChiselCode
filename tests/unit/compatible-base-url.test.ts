import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { AnthropicCompatibleAdapter } from "../../src/providers/anthropic.js";
import {
  normalizeAnthropicCompatibleBaseUrl,
  normalizeBaseUrlForProvider,
  normalizeOpenAiCompatibleBaseUrl,
} from "../../src/providers/base-url.js";
import {
  isTokenLimitError,
  OpenAICompatibleAdapter,
} from "../../src/providers/openai.js";

describe("compatible base URL normalization", () => {
  test("appends /v1 to a bare OpenAI-compatible host", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("https://agentrouter.org")).toBe(
      "https://agentrouter.org/v1",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://agentrouter.org/")).toBe(
      "https://agentrouter.org/v1",
    );
    expect(
      normalizeOpenAiCompatibleBaseUrl("  https://agentrouter.org///  "),
    ).toBe("https://agentrouter.org/v1");
  });

  test("keeps explicit OpenAI-compatible paths untouched", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("https://agentrouter.org/v1")).toBe(
      "https://agentrouter.org/v1",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("http://localhost:11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
    expect(
      normalizeOpenAiCompatibleBaseUrl("https://proxy.example.test/custom"),
    ).toBe("https://proxy.example.test/custom");
  });

  test("strips a trailing /v1 from Anthropic-compatible addresses", () => {
    expect(
      normalizeAnthropicCompatibleBaseUrl("https://agentrouter.org/v1"),
    ).toBe("https://agentrouter.org");
    expect(
      normalizeAnthropicCompatibleBaseUrl("https://agentrouter.org/v1/"),
    ).toBe("https://agentrouter.org");
    expect(normalizeAnthropicCompatibleBaseUrl("https://agentrouter.org")).toBe(
      "https://agentrouter.org",
    );
    expect(
      normalizeAnthropicCompatibleBaseUrl("https://proxy.example.test/api"),
    ).toBe("https://proxy.example.test/api");
  });

  test("dispatches normalization by provider", () => {
    expect(
      normalizeBaseUrlForProvider(
        "openai-compatible",
        "https://agentrouter.org",
      ),
    ).toBe("https://agentrouter.org/v1");
    expect(
      normalizeBaseUrlForProvider(
        "anthropic-compatible",
        "https://agentrouter.org/v1",
      ),
    ).toBe("https://agentrouter.org");
    expect(
      normalizeBaseUrlForProvider("openai", "https://agentrouter.org"),
    ).toBe("https://agentrouter.org");
    expect(normalizeBaseUrlForProvider("openai-compatible", undefined)).toBe(
      undefined,
    );
  });

  test("compatible adapters normalize the base URL they keep", () => {
    const openai = new OpenAICompatibleAdapter({
      apiKey: "test",
      baseUrl: "https://agentrouter.org/",
    });
    expect(
      (openai as unknown as { client: { baseURL: string } }).client.baseURL,
    ).toBe("https://agentrouter.org/v1");

    const anthropic = new AnthropicCompatibleAdapter({
      authToken: "test",
      baseUrl: "https://agentrouter.org/v1/",
    });
    expect(
      (anthropic as unknown as { client: { baseURL: string } }).client.baseURL,
    ).toBe("https://agentrouter.org");
  });

  test("compatible adapters still require a base URL", () => {
    expect(
      () => new OpenAICompatibleAdapter({ apiKey: "test", baseUrl: undefined }),
    ).toThrow("OpenAI-compatible providers require baseUrl.");
    expect(
      () =>
        new AnthropicCompatibleAdapter({
          authToken: "test",
          baseUrl: undefined,
        }),
    ).toThrow("Anthropic-compatible providers require baseUrl.");
  });
});

describe("token limit parameter fallback", () => {
  test("detects 400 errors about the token limit parameter", () => {
    const badRequest = new OpenAI.BadRequestError(
      400,
      {
        message: "unsupported parameter: max_completion_tokens",
        type: "invalid_request_error",
      },
      undefined,
      new Headers(),
    );
    expect(isTokenLimitError(badRequest)).toBe(true);

    const otherBadRequest = new OpenAI.BadRequestError(
      400,
      { message: "invalid model id", type: "invalid_request_error" },
      undefined,
      new Headers(),
    );
    expect(isTokenLimitError(otherBadRequest)).toBe(false);

    const auth = new OpenAI.AuthenticationError(
      401,
      {
        message: "invalid api key",
        type: "invalid_request_error",
      },
      undefined,
      new Headers(),
    );
    expect(isTokenLimitError(auth)).toBe(false);
    expect(isTokenLimitError(new Error("boom"))).toBe(false);
    expect(isTokenLimitError(undefined)).toBe(false);
  });
});
