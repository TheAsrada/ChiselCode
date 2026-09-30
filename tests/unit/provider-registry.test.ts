import { expect, test } from "bun:test";
import { anthropic } from "../../src/providers/definitions/anthropic.js";
import { builtinDefinitions } from "../../src/providers/definitions/index.js";
import { DriverRegistry } from "../../src/providers/drivers/index.js";
import {
  ProviderRegistry,
  providerDefinitionSchema,
} from "../../src/providers/registry.js";

test("built-in definitions validate, stable ordering and source", () => {
  const registry = new ProviderRegistry();
  for (const d of builtinDefinitions) {
    expect(providerDefinitionSchema.safeParse(d).success).toBe(true);
    registry.register(d);
  }
  expect(registry.list()).toHaveLength(5);
  expect(registry.source("openai")).toEqual({ type: "builtin" });
  expect(registry.search("messages").map((d) => d.id)).toContain(
    "anthropic-compatible",
  );
  expect(() => registry.register(anthropic)).toThrow("Duplicate");
  expect(() => registry.require("missing")).toThrow("unavailable");
});
test("registry scales to 500 definitions and checks drivers and namespace", () => {
  const r = new ProviderRegistry();
  for (let i = 0; i < 500; i++)
    r.register(
      {
        ...anthropic,
        id: `test/provider-${i}`,
        label: `Provider ${i}`,
      },
      {
        type: "user-manifest",
        directory: "test",
        manifestPath: "test/provider.json",
      },
    );
  expect(r.list()).toHaveLength(500);
  expect(r.search("provider-499")).toHaveLength(1);
  expect(() =>
    r.register(anthropic, {
      type: "user-manifest",
      directory: "test",
      manifestPath: "test/provider.json",
    }),
  ).toThrow();
  expect(() =>
    new ProviderRegistry(new DriverRegistry()).register(anthropic),
  ).toThrow("Unknown driver");
});
