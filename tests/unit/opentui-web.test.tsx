/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { THEMES } from "../../src/ui/appearance.js";
import { OpenTuiApproval } from "../../src/ui/opentui-approval.js";
import {
  OpenTuiSettings,
  type OpenTuiSettingsActions,
} from "../../src/ui/opentui-settings.js";
import { createWebToolProvider } from "../../src/web/provider.js";
import { SearchInputSchema, WebConfigSchema } from "../../src/web/schema.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
    await setup.renderOnce();
  });
}
async function key(setup: Setup, name: string) {
  await act(async () => {
    setup.mockInput.pressKey(name === "ENTER" ? "RETURN" : name);
  });
  await frame(setup);
}
async function click(setup: Setup, id: string) {
  const node = setup.renderer.root.findDescendantById(id);
  if (!node) throw new Error(`Missing ${id}`);
  await act(async () => {
    await setup.mockMouse.click(node.x + 1, node.y);
  });
  await frame(setup);
}
const actions = (): OpenTuiSettingsActions => ({
  load: async () => ({
    values: { provider: "anthropic", model: "fixture" },
    hasKey: true,
  }),
  hasKey: async () => true,
  save: async () => "saved",
  check: async () => "ok",
  models: async () => ({ ok: true, models: [] }),
});
for (const [width, height] of [
  [100, 34],
  [54, 22],
  [40, 16],
])
  test(`native Web settings render and operate at ${width}x${height}`, async () => {
    const api = actions();
    let config = WebConfigSchema.parse({});
    const saved: string[] = [];
    api.web = {
      load: async () => ({ config, hasKey: false }),
      save: async (value, key) => {
        config = value;
        saved.push(key ?? value.permissions.search);
        return { config, hasKey: Boolean(key) };
      },
    };
    let setup!: Setup;
    await act(async () => {
      setup = await testRender(
        <OpenTuiSettings
          actions={api}
          width={width ?? 100}
          height={height ?? 34}
          initialPage="web"
          onClose={() => {}}
        />,
        { width, height },
      );
    });
    try {
      await frame(setup);
      expect(setup.captureCharFrame()).toContain("Web");
      expect(setup.captureCharFrame()).not.toMatch(/[\u2500-\u259f]/u);
      expect(setup.captureCharFrame()).toContain("Спрашивать");
      expect(setup.captureCharFrame()).toContain("Авто");
      await click(setup, "settings-web-row-1");
      expect(saved).toEqual(["allow"]);
      await click(setup, "settings-web-row-3");
      expect(config.search.provider).toBe("exa");
      expect(setup.captureCharFrame()).toContain("Exa");
      await click(setup, "settings-web-row-3");
      expect(config.search.provider).toBe("parallel");
      expect(setup.captureCharFrame()).toContain("Parallel");
      expect(setup.captureCharFrame()).not.toContain("Brave API-ключ");
      await click(setup, "settings-web-row-3");
      expect(config.search.provider).toBe("brave");
      await click(setup, "settings-web-row-4");
      await act(async () => {
        await setup.mockInput.pasteBracketedText("brave-ui-secret-123456");
      });
      await frame(setup);
      expect(setup.captureCharFrame()).not.toContain("brave-ui-secret-123456");
      await key(setup, "ENTER");
      expect(saved).toContain("brave-ui-secret-123456");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
test("network approval shows URL and domain-scoped session choice without raw JSON", async () => {
  let session = 0;
  const setup = await testRender(
    <OpenTuiApproval
      request={{
        tool: "web_fetch",
        preview:
          "ChiselCode wants to open a public web page\nhttps://react.dev/reference/actions\nDomain: react.dev",
        network: {
          operation: "fetch",
          hostname: "react.dev",
          url: "https://react.dev/reference/actions",
        },
      }}
      width={90}
      height={30}
      palette={THEMES.obsidian}
      onSessionApprove={() => session++}
    />,
    { width: 90, height: 30 },
  );
  try {
    await frame(setup);
    expect(setup.captureCharFrame()).toContain(
      "https://react.dev/reference/actions",
    );
    expect(setup.captureCharFrame()).toContain("Домен на сессию");
    await click(setup, "approval-session");
    expect(session).toBe(1);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});
test("compact Auto search approval puts the query and candidate services before diagnostics", async () => {
  const provider = await createWebToolProvider(
    WebConfigSchema.parse({
      search: { apiKey: { envRef: "CHISEL_TEST_UNSET_SEARCH_KEY" } },
    }),
  );
  const handler = await provider.getHandler("web_search");
  const plan = await handler.prepare(
    {} as Parameters<typeof handler.prepare>[0],
    SearchInputSchema.parse({ query: "React Server Functions docs" }),
  );
  let setup!: Setup;
  await act(async () => {
    setup = await testRender(
      <OpenTuiApproval
        request={{
          tool: "web_search",
          preview: plan.preview,
          network: plan.network,
        }}
        width={40}
        height={16}
        palette={THEMES.obsidian}
        onSessionApprove={() => {}}
      />,
      { width: 40, height: 16 },
    );
  });
  try {
    await frame(setup);
    const text = setup.captureCharFrame();
    expect(text).toContain("React Server Functions");
    expect(text).toContain("Авто");
    expect(text).toContain("Exa / Parallel");
    expect(text).toContain("Разрешить");
    expect(text).not.toContain("web_search");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});
