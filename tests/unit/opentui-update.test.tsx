/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  type DownloadedAsset,
  type DownloadProgress,
  planSelfUpdate,
} from "../../src/commands/update.js";
import { type ThemeName, themePalette } from "../../src/ui/appearance.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { OpenTuiUpdate, updateNotice } from "../../src/ui/opentui-update.js";
import { UnicodeDecorationContext } from "../../src/ui/terminal-decoration.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";
import { UpdateController } from "../../src/ui/update-controller.js";

type Setup = Awaited<ReturnType<typeof testRender>>;

async function frame(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
}

async function key(setup: Setup, name: string) {
  await act(async () => {
    setup.mockInput.pressKey(name);
    if (name === "ESCAPE")
      await new Promise((resolve) => setTimeout(resolve, 120));
  });
  await frame(setup);
}

async function click(setup: Setup, id: string) {
  const target = setup.renderer.root.findDescendantById(id);
  if (!target) throw new Error(`Missing ${id}`);
  await act(async () => {
    await setup.mockMouse.click(target.x + 1, target.y);
  });
  await frame(setup);
}

function fixture() {
  let report: ((progress: DownloadProgress) => void) | undefined;
  let finish: ((asset: DownloadedAsset) => void) | undefined;
  let launches = 0;
  const updater = new UpdateController("0.6.11", {
    check: async () => ({
      current: "0.6.11",
      latest: "0.6.12",
      latestUrl: "https://github.com/TheAsrada/ChiselCode/releases/tag/v0.6.12",
      updateAvailable: true,
      assets: [
        {
          name: "ChiselCode-Setup-0.6.12.exe",
          url: "https://example.test/update.exe",
          size: 32 * 1024 * 1024,
          sha256: "f".repeat(64),
        },
      ],
    }),
    plan: (check, current) =>
      planSelfUpdate(check, current, "win32", "x64", "C:/app/chisel.exe"),
    download: (_url, _asset, options) => {
      report = options.onProgress;
      return new Promise((resolve, reject) => {
        finish = resolve;
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        );
      });
    },
    launch: async () => {
      launches++;
    },
    remove: async () => {},
  });
  return {
    updater,
    get launches() {
      return launches;
    },
    halfway: () =>
      report?.({
        phase: "downloading",
        bytes: 16 * 1024 * 1024,
        totalBytes: 32 * 1024 * 1024,
      }),
    finish: () =>
      finish?.({ path: "/temporary/update.exe", bytes: 32 * 1024 * 1024 }),
  };
}

for (const theme of ["obsidian", "graphite", "ember", "paper"] as ThemeName[]) {
  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 36],
  ]) {
    for (const unicode of [false, true]) {
      test(`update popup: ${theme}, ${width}x${height}, unicode=${unicode}`, async () => {
        const api = fixture();
        await api.updater.check();
        let closed = false;
        const setup = await testRender(
          <UnicodeDecorationContext value={unicode}>
            <OpenTuiUpdate
              updater={api.updater}
              width={width ?? 80}
              height={height ?? 24}
              palette={themePalette(theme)}
              onClose={() => {
                closed = true;
              }}
            />
          </UnicodeDecorationContext>,
          { width, height },
        );
        try {
          await frame(setup);
          expect(setup.captureCharFrame()).toContain("0.6.12");
          expect(setup.captureCharFrame()).toContain("Скачать");
          if (!unicode)
            expect(setup.captureCharFrame()).not.toMatch(/[\u2500-\u259f]/u);
          await key(setup, "RETURN");
          act(() => api.halfway());
          await frame(setup);
          expect(setup.captureCharFrame()).toContain("50%");
          expect(setup.captureCharFrame()).toContain("16,0 / 32,0 МБ");
          expect(api.launches).toBe(0);
          await act(async () => api.finish());
          await frame(setup);
          expect(setup.captureCharFrame()).toContain("Перезапустить");
          expect(api.launches).toBe(0);
          const popup = setup.renderer.root.findDescendantById("update-popup");
          const primary =
            setup.renderer.root.findDescendantById("update-primary");
          expect(popup).toBeTruthy();
          expect(primary).toBeTruthy();
          if (popup && primary) {
            expect(primary.x).toBeGreaterThanOrEqual(popup.x);
            expect(primary.y).toBeLessThan(popup.y + popup.height);
          }
          await click(setup, "update-primary");
          expect(api.launches).toBe(1);
          expect(closed).toBe(false);
        } finally {
          act(() => setup.renderer.destroy());
          await api.updater.dispose();
        }
      });
    }
  }
}

test("the home update notice opens a modal without losing an unsent draft", async () => {
  const api = fixture();
  await api.updater.check();
  const workspace = new TuiWorkspace(process.cwd());
  workspace.home.setDraft("неотправленный текст");
  const submitted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      updater={api.updater}
      onExit={() => {}}
      onSubmit={async (text) => {
        submitted.push(text);
      }}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("Доступно обновление v0.6.12");
    const editor = setup.renderer.currentFocusedEditor;
    await click(setup, "welcome-update");
    expect(setup.renderer.root.findDescendantById("update-popup")).toBeTruthy();
    expect(workspace.home.snapshot.draft).toBe("неотправленный текст");
    await key(setup, "ESCAPE");
    expect(setup.renderer.currentFocusedEditor).toBe(editor);
    expect(editor?.plainText).toBe("неотправленный текст");
    expect(submitted).toEqual([]);
    expect(workspace.home.snapshot.transcript).toHaveLength(0);
  } finally {
    act(() => setup.renderer.destroy());
    workspace.dispose();
    await api.updater.dispose();
  }
});

test("/update stays local and cancels a download without changing the transcript", async () => {
  const api = fixture();
  await api.updater.check();
  const workspace = new TuiWorkspace(process.cwd());
  workspace.newTab();
  const submitted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      updater={api.updater}
      onExit={() => {}}
      onSubmit={async (text) => {
        submitted.push(text);
      }}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    await act(async () => setup.mockInput.pasteBracketedText("/update"));
    await key(setup, "RETURN");
    expect(setup.renderer.root.findDescendantById("update-popup")).toBeTruthy();
    await key(setup, "RETURN");
    expect(api.updater.snapshot.phase).toBe("downloading");
    await key(setup, "ESCAPE");
    expect(api.updater.snapshot.phase).toBe("cancelled");
    expect(setup.renderer.root.findDescendantById("update-popup")).toBeFalsy();
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
    expect(workspace.controller.snapshot.transcript).toHaveLength(0);
    expect(submitted).toEqual([]);
    expect(api.launches).toBe(0);
  } finally {
    act(() => setup.renderer.destroy());
    workspace.dispose();
    await api.updater.dispose();
  }
});

test("home notifications ignore incomplete releases and show a prepared update", async () => {
  const api = fixture();
  expect(updateNotice(api.updater.snapshot)).toBeUndefined();
  await api.updater.check();
  expect(updateNotice(api.updater.snapshot)).toContain("Доступно обновление");
  const plan = api.updater.snapshot.plan;
  if (!plan) throw new Error("Missing update plan");
  expect(
    updateNotice({
      ...api.updater.snapshot,
      plan: { ...plan, assetReady: false },
    }),
  ).toBeUndefined();
  const downloading = api.updater.prepare();
  api.finish();
  await downloading;
  expect(updateNotice(api.updater.snapshot)).toContain("готово");
  await api.updater.dispose();
});
