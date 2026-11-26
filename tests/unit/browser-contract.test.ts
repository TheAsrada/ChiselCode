import { expect, test } from "bun:test";
import {
  BrowserConfigSchema,
  localUrl,
  ProjectBrowserConfigSchema,
} from "../../src/browser/config.js";
import { safeText } from "../../src/browser/page.js";
import {
  migrateConfig,
  withLegacyAccessors,
} from "../../src/config/migrate.js";
import { responsesInput } from "../../src/extensions/builtins/chatgpt/adapter.js";
import { builtinAvailability } from "../../src/extensions/settings-contributions.js";
import { ExtensionUiRegistry } from "../../src/extensions/ui.js";
import type { UiSnapshot } from "../../src/extensions/ui-types.js";
import { ProviderToolNames } from "../../src/providers/tool-names.js";
import { ToolImageOutput } from "../../src/tools/image-output.js";
import type { ProviderRequest } from "../../src/types/domain.js";

test("browser defaults on, keeps explicit disable on upgrade, and permits only a project ceiling", () => {
  expect(BrowserConfigSchema.parse({})).toEqual({
    enabled: true,
    origins: [],
    imageProfiles: [],
  });
  const old = migrateConfig({ providers: {}, browser: { enabled: false } });
  expect(old.browser?.enabled).toBe(false);
  expect(ProjectBrowserConfigSchema.safeParse({ enabled: true }).success).toBe(
    false,
  );
  expect(
    ProjectBrowserConfigSchema.safeParse({ imageProfiles: ["private"] })
      .success,
  ).toBe(false);
  const migrated = migrateConfig({ providers: {} });
  expect(
    builtinAvailability("builtin.browser", withLegacyAccessors(migrated)),
  ).toEqual({ enabled: true, effective: true });
});

test("browser targets resolve only numeric loopback and diagnostics omit query and terminal controls", () => {
  expect(localUrl("http://localhost:5173/form?q=private").origin).toBe(
    "http://127.0.0.1:5173",
  );
  expect(localUrl("http://[::1]:5173/").hostname).toBe("[::1]");
  for (const url of [
    "https://127.0.0.1:5173/",
    "http://localhost/",
    "http://localhost.evil:5173/",
    "http://10.0.0.1:5173/",
    "http://user:secret@127.0.0.1:5173",
    "file:///tmp/index.html",
  ])
    expect(() => localUrl(url)).toThrow();
  expect(safeText("GET http://127.0.0.1:5173/form?token=hidden#secret")).toBe(
    "GET http://127.0.0.1:5173/form",
  );
  expect(safeText("token=secret\u001b")).toBe("[redacted]");
});

test("ChatGPT subscription encodes a PNG only for the corresponding transient tool result", async () => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGOU67nzn4GBgYGJAQoAJcoCiXWN7cIAAAAASUVORK5CYII=",
    "base64",
  );
  const origin = "http://127.0.0.1:5173";
  let permitted = false;
  const output = new ToolImageOutput(
    async (target) => permitted && target === origin,
  );
  const request: ProviderRequest = {
    model: "gpt-6.2-sol",
    system: "Describe the pixel pattern.",
    tools: [],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "capture",
            name: "ext:builtin.browser:screenshot",
            input: { modelImage: true },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "other", content: "other text" },
          { type: "tool_result", toolUseId: "capture", content: "2 × 2 PNG" },
        ],
      },
    ],
  };
  const names = new ProviderToolNames(request.tools, request.messages);
  const image = { mimeType: "image/png" as const, bytes };
  expect(await output.offer("capture", origin, image)).toBe(false);
  permitted = true;
  expect(await output.offer("capture", origin, image)).toBe(true);
  permitted = false;
  expect(await output.take(request.messages)).toBeUndefined();
  permitted = true;
  expect(await output.offer("capture", origin, image)).toBe(true);
  expect(await output.offer("other", origin, image)).toBe(false);
  const toolImages = await output.take(request.messages);
  const wire = responsesInput({ ...request, toolImages }, names);
  expect(wire.at(-2)?.output).toBe("other text");
  expect(wire.at(-1)?.output).toEqual([
    { type: "input_text", text: "2 × 2 PNG" },
    {
      type: "input_image",
      image_url: `data:image/png;base64,${bytes.toString("base64")}`,
    },
  ]);
  expect(responsesInput(request, names).at(-1)?.output).toBe("2 × 2 PNG");
  expect(JSON.stringify(request.messages)).not.toContain("base64");
  expect(await output.take(request.messages)).toBeUndefined();
});

test("opt-in browser pane reserves no layout before the first snapshot", async () => {
  const lifetime = new AbortController();
  const registry = new ExtensionUiRegistry(".", lifetime.signal, () => {});
  const snapshot = Promise.withResolvers<UiSnapshot>();
  registry.register("builtin.browser", {
    id: "browser",
    slot: "pane",
    placement: "sidebar",
    title: "Browser",
    scope: "conversation",
    initiallyHidden: true,
    source: { snapshot: () => snapshot.promise },
  });
  registry.seal();
  const shown = Promise.withResolvers<void>();
  const subscription = registry.bind(
    {
      conversationId: "test",
      generation: 1,
      signal: lifetime.signal,
      read: {
        ownerSummary: () => ({
          background: { active: 0, errors: 0, awaitingApproval: 0 },
          agents: { active: 0, total: 0, errors: 0 },
        }),
        subscribeOwner: () => ({ dispose() {} }),
      },
    },
    (items) => {
      if (items.length) shown.resolve();
    },
  );
  try {
    expect(subscription.items).toEqual([]);
    snapshot.resolve({
      revision: 1,
      state: "ready",
      render: { mode: "replace", content: { type: "text", text: "Browser" } },
    });
    await shown.promise;
    expect(subscription.items[0]?.snapshot.state).toBe("ready");
  } finally {
    registry.dispose();
  }
});
