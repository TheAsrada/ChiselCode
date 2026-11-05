/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createChatGptExtension } from "../../src/extensions/builtins/chatgpt/index.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import type { ProviderProfile } from "../../src/providers/contracts.js";
import { builtinDefinitions } from "../../src/providers/definitions/index.js";
import { THEMES } from "../../src/ui/appearance.js";
import { ExtensionUiBinding } from "../../src/ui/extension-ui.js";
import {
  OpenTuiSettings,
  type OpenTuiSettingsActions,
} from "../../src/ui/opentui-settings.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import type { TuiSettingsValues } from "../../src/ui/settings-values.js";
import { TuiController } from "../../src/ui/tui-controller.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(ui: Setup) {
  await act(async () => {
    await ui.renderOnce();
    await ui.renderOnce();
  });
  return ui.captureCharFrame();
}
async function wait(ui: Setup, predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(ui.captureCharFrame());
    await act(async () => {
      await Bun.sleep(5);
      await ui.renderOnce();
    });
  }
  await frame(ui);
}
async function key(ui: Setup, name: string) {
  await act(async () => {
    ui.mockInput.pressKey(name);
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame(ui);
}
async function click(ui: Setup, id: string) {
  const target = ui.renderer.root.findDescendantById(id);
  if (!target) throw new Error(`Missing ${id}\n${ui.captureCharFrame()}`);
  await act(async () => {
    await ui.mockMouse.click(target.x + 1, target.y);
  });
  await frame(ui);
}
async function capture(ui: Setup, name: string) {
  const folder = process.env.CHISEL_CONNECTION_CAPTURES;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.txt`), ui.captureCharFrame());
  const spans = ui.captureSpans();
  await writeFile(
    join(folder, `${name}.json`),
    JSON.stringify({
      ...spans,
      lines: spans.lines.map((line) => ({
        spans: line.spans.map((span) => ({
          ...span,
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
        })),
      })),
    }),
  );
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chisel-connections-ui-"));
  let release!: () => void;
  let permit = new Promise<void>((resolve) => {
    release = resolve;
  });
  const secrets = new Map<string, string>();
  const token = `header.${Buffer.from(JSON.stringify({ email: "personal@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "personal" } })).toString("base64url")}.signature`;
  const extension = createChatGptExtension({
    lockDirectory: root,
    credentials: {
      async get(key) {
        return secrets.get(key);
      },
      async set(key, value) {
        secrets.set(key, value);
      },
      async delete(key) {
        secrets.delete(key);
      },
    },
    fetch: async (url, init) => {
      const path = new URL(
        typeof url === "string" || url instanceof URL ? url : url.url,
      ).pathname;
      if (path.endsWith("/usercode"))
        return Response.json({
          device_auth_id: "test",
          user_code: "TEST-1234",
          interval: 1,
        });
      if (path.endsWith("/deviceauth/token")) {
        await Promise.race([
          permit,
          new Promise((_, reject) =>
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              { once: true },
            ),
          ),
        ]);
        return Response.json({
          authorization_code: "grant",
          code_verifier: "verifier",
        });
      }
      if (path.endsWith("/oauth/token"))
        return Response.json({
          access_token: token,
          id_token: token,
          refresh_token: "test-refresh",
          expires_in: 3600,
        });
      if (path.endsWith("/models"))
        return Response.json({
          models: [
            {
              slug: "codex-personal",
              display_name: "Codex",
              visibility: "list",
              context_window: 128000,
            },
          ],
        });
      if (path.endsWith("/usage"))
        return Response.json({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 22,
              limit_window_seconds: 18000,
              reset_at: 1800000000,
            },
            secondary_window: {
              used_percent: 65,
              limit_window_seconds: 604800,
              reset_at: 1800200000,
            },
          },
        });
      throw new Error(path);
    },
  });
  const contribution = extension.providers![0]!;
  const connection = contribution.connection!;
  const profiles: Record<string, ProviderProfile> = {
    personal: {
      providerId: "chatgpt",
      label: "Личный",
      defaultModel: "codex-personal",
      apiKeyRef: "personal",
    },
    work: { providerId: "openai", label: "Рабочий API", defaultModel: "gpt-5" },
  };
  let current = "personal";
  const saved: TuiSettingsValues[] = [];
  const actions: OpenTuiSettingsActions = {
    catalog: async () => ({
      providers: [...builtinDefinitions, contribution.definition],
      profiles: { ...profiles },
    }),
    load: async (id = current) => {
      const p = profiles[id] ?? profiles.work!;
      return {
        values: {
          provider: p.providerId,
          profileId: id,
          label: p.label,
          model: p.defaultModel ?? "",
        },
        hasKey:
          p.providerId === "chatgpt"
            ? (await connection.status(id)).connected
            : true,
      };
    },
    hasKey: async (provider, id) =>
      provider === "chatgpt"
        ? !!id && (await connection.status(id)).connected
        : true,
    connect: (values, signal, challenge) =>
      connection.connect({ profileId: values.profileId!, signal, challenge }),
    disconnect: (values) => connection.disconnect(values.profileId!),
    removeProfile: async (id) => {
      delete profiles[id];
      current = Object.keys(profiles)[0] ?? "";
    },
    models: async (values) => {
      const adapter = contribution.create({
        definition: contribution.definition,
        profile: { providerId: "chatgpt" },
        profileId: values.profileId,
      });
      return { ok: true, models: await adapter.listModels!() };
    },
    check: async () => "+ Подключено",
    save: async (values) => {
      saved.push({ ...values });
      current = values.profileId!;
      profiles[current] = {
        providerId: values.provider,
        label: values.label,
        defaultModel: values.model,
      };
      return "saved";
    },
  };
  return {
    root,
    extension,
    actions,
    profiles,
    saved,
    release: () => release(),
    allow: () => {
      permit = Promise.resolve();
      release();
    },
  };
}

for (const theme of ["obsidian", "paper"] as const)
  test(`connection profiles, device flow and dynamic model selection in ${theme}`, async () => {
    const f = await fixture();
    const ui = await testRender(
      <OpenTuiSettings
        actions={f.actions}
        width={120}
        height={40}
        theme={theme}
        palette={THEMES[theme]}
        onClose={() => {}}
      />,
      { width: 120, height: 40 },
    );
    try {
      await wait(ui, () => ui.captureCharFrame().includes("Аккаунт"));
      await capture(ui, `${theme}-connection-120x40`);
      expect(ui.captureCharFrame()).not.toContain("API-ключ");
      await click(ui, "settings-profiles");
      expect(ui.captureCharFrame()).toContain("Рабочий API");
      expect(ui.captureCharFrame()).toContain("Личный");
      await capture(ui, `${theme}-profiles-120x40`);
      await click(ui, "settings-row-personal");
      await click(ui, "settings-row-login");
      await wait(ui, () => ui.captureCharFrame().includes("TEST-1234"));
      await capture(ui, `${theme}-login-120x40`);
      expect(ui.captureCharFrame()).toContain(
        "https://auth.openai.com/codex/device",
      );
      f.release();
      await wait(ui, () => ui.captureCharFrame().includes("Выберите модель"));
      await click(ui, "settings-row-codex-personal");
      await act(async () => {
        ui.mockInput.pressKey("s", { ctrl: true });
      });
      await wait(ui, () => f.saved.length === 1);
      expect(f.saved[0]?.provider).toBe("chatgpt");
      expect(f.saved[0]?.model).toBe("codex-personal");
      expect(f.saved[0]?.apiKey).toBeUndefined();
      expect(ui.captureCharFrame()).not.toContain("test-refresh");
    } finally {
      act(() => ui.renderer.destroy());
      await rm(f.root, { recursive: true, force: true });
    }
  });

test("Esc cancels a pending login and never applies its late result", async () => {
  const f = await fixture();
  const ui = await testRender(
    <OpenTuiSettings
      actions={f.actions}
      width={80}
      height={24}
      setup
      onClose={() => {}}
    />,
    { width: 80, height: 24 },
  );
  try {
    await wait(ui, () => ui.captureCharFrame().includes("Аккаунт"));
    await click(ui, "settings-row-login");
    await wait(ui, () => ui.captureCharFrame().includes("TEST-1234"));
    await key(ui, "ESCAPE");
    f.release();
    await frame(ui);
    expect(ui.captureCharFrame()).not.toContain("TEST-1234");
    expect(
      (await f.extension.providers![0]!.connection!.status("personal"))
        .connected,
    ).toBe(false);
    expect(f.saved).toHaveLength(0);
  } finally {
    act(() => ui.renderer.destroy());
    await rm(f.root, { recursive: true, force: true });
  }
});

test("switching accounts protects an edited profile and profile deletion requires confirmation", async () => {
  const f = await fixture();
  const ui = await testRender(
    <OpenTuiSettings
      actions={f.actions}
      width={120}
      height={40}
      onClose={() => {}}
    />,
    { width: 120, height: 40 },
  );
  try {
    await wait(ui, () => ui.captureCharFrame().includes("Аккаунт"));
    await click(ui, "settings-row-profile-label");
    await act(async () => {
      await ui.mockInput.pasteBracketedText("Изменён");
    });
    await key(ui, "RETURN");
    await click(ui, "settings-profiles");
    await click(ui, "settings-row-work");
    expect(ui.captureCharFrame()).toContain("Сохранить изменения профиля?");
    await click(ui, "settings-connection-cancel");
    expect(f.saved).toHaveLength(0);
    await click(ui, "settings-row-work");
    await click(ui, "settings-connection-save");
    await wait(ui, () => ui.captureCharFrame().includes("gpt-5"));
    expect(f.saved[0]?.profileId).toBe("personal");
    expect(f.saved[0]?.label).toContain("Изменён");
    await click(ui, "settings-row-delete-profile");
    expect(f.profiles.work).toBeDefined();
    await click(ui, "settings-connection-cancel");
    expect(f.profiles.work).toBeDefined();
    await click(ui, "settings-row-delete-profile");
    await click(ui, "settings-connection-discard");
    await wait(ui, () => !f.profiles.work);
    expect(f.profiles.personal).toBeDefined();
  } finally {
    act(() => ui.renderer.destroy());
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const [width, height] of [
  [80, 24],
  [60, 15],
  [32, 10],
])
  test(`profile navigation and recovery stay available at ${width}x${height}`, async () => {
    const f = await fixture();
    const ui = await testRender(
      <OpenTuiSettings
        actions={f.actions}
        width={width!}
        height={height!}
        setup
        onClose={() => {}}
      />,
      { width: width!, height: height! },
    );
    try {
      await wait(
        ui,
        () => !!ui.renderer.root.findDescendantById("settings-profiles"),
      );
      await click(ui, "settings-profiles");
      await capture(ui, `obsidian-profiles-${width}x${height}`);
      expect(ui.captureCharFrame()).toContain("Профили");
      await key(ui, "ARROW_DOWN");
      await key(ui, "RETURN");
      await wait(ui, () => ui.captureCharFrame().includes("gpt-5"));
      expect(ui.captureCharFrame().split("\n").length).toBeGreaterThan(0);
    } finally {
      act(() => ui.renderer.destroy());
      await rm(f.root, { recursive: true, force: true });
    }
  });

test("the standard extension owns quota UI and follows the conversation profile", async () => {
  const f = await fixture();
  f.allow();
  const host = new ExtensionHost([f.extension]);
  const scope = await host.open(f.root);
  const controller = new TuiController(f.root);
  controller.setActiveModel("chatgpt", "codex-personal", "personal");
  controller.append("Проверь проект и подключение", "user");
  controller.append("Готов к работе", "assistant");
  await f.extension.providers![0]!.connection!.connect({
    profileId: "personal",
    signal: new AbortController().signal,
    challenge() {},
  });
  const binding = new ExtensionUiBinding(controller, scope);
  const ui = await testRender(
    <OpenTuiSpike
      controller={controller}
      onSubmit={async () => {}}
      onExit={() => {}}
    />,
    { width: 120, height: 40 },
  );
  try {
    await wait(
      ui,
      () =>
        controller.snapshot.uiContributions?.some(
          (item) => item.snapshot.state === "ready",
        ) === true,
    );
    act(() => controller.setAgentSidebar("context", true));
    await wait(ui, () => ui.captureCharFrame().includes("78%"));
    await capture(ui, "obsidian-limits-120x40");
    expect(ui.captureCharFrame()).toContain("35%");
    expect(controller.snapshot.uiContributions?.[0]?.extensionId).toBe(
      "builtin.chatgpt",
    );
    act(() => controller.setActiveModel("openai", "gpt-5", "work"));
    await wait(
      ui,
      () =>
        controller.snapshot.uiContributions?.every(
          (item) => item.snapshot.visible === false,
        ) === true,
    );
    expect(ui.captureCharFrame()).not.toContain("78%");
  } finally {
    act(() => ui.renderer.destroy());
    binding.dispose();
    controller.dispose();
    await host.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});
