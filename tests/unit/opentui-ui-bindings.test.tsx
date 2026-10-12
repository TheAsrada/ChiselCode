/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ExtensionHost } from "../../src/extensions/index.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";
import { WorkspaceCommands } from "../../src/ui/workspace-commands.js";
import { uiExtension } from "../fixtures/ui-extension.js";

test("native owner switches and twenty view cycles fence late data and keep shared listeners bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-ui-switch-"));
  const firstRoot = join(directory, "one");
  const otherRoot = join(directory, "two");
  await mkdir(firstRoot);
  await mkdir(otherRoot);
  const fixture = uiExtension();
  let release: (() => void) | undefined;
  let sourceAborted = false;
  const host = new ExtensionHost([
    fixture.extension,
    {
      id: "probe",
      activate(ctx) {
        ctx.ui.register({
          id: "owner",
          scope: "conversation",
          slot: "status",
          title: "Владелец",
          source: {
            snapshot: (binding) => ({
              revision: 1,
              state: "ready",
              detail: binding.conversationId,
            }),
          },
        });
        ctx.ui.registerView({
          id: "late",
          scope: "conversation",
          title: "Поздний ответ",
          page: (binding) =>
            new Promise((resolve) => {
              binding.signal.addEventListener(
                "abort",
                () => {
                  sourceAborted = true;
                },
                { once: true },
              );
              release = () =>
                resolve({
                  revision: 1,
                  state: "ready",
                  summary: "OLD OWNER MUST NOT APPEAR",
                });
            }),
        });
      },
    },
  ]);
  const workspace = new TuiWorkspace(firstRoot);
  const first = workspace.newTab(firstRoot);
  const firstKey = workspace.activeKey;
  const second = workspace.newTab(firstRoot);
  const secondKey = workspace.activeKey;
  const other = workspace.newTab(otherRoot);
  const otherKey = workspace.activeKey;
  first.setDraft("Черновик первого");
  second.setDraft("Черновик второго");
  other.setDraft("Черновик другого проекта");
  workspace.select(firstKey);
  const commands = new WorkspaceCommands(host);
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <OpenTuiSpike workspace={workspace} commandActions={commands} />,
      { width: 120, height: 40, exitOnCtrlC: false },
    );
  });
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() >= deadline)
        throw new Error("Native UI binding did not settle");
      await act(async () => {
        await Bun.sleep(10);
        await setup.renderOnce();
      });
    }
  }
  try {
    await until(
      () =>
        first.snapshot.uiContributions?.some(
          (item) =>
            item.key === "probe/owner" &&
            item.snapshot.detail === first.conversationId,
        ) === true,
    );
    const keyboard = setup.renderer.keyInput.listenerCount("keypress");
    const resize = setup.renderer.listenerCount("resize");
    for (let index = 0; index < 20; ++index) {
      await act(async () => {
        await first.uiBinding?.open("fixture.interface/report");
        await setup.renderOnce();
      });
      expect(first.snapshot.extensionView?.page?.rows).toHaveLength(64);
      await act(async () => {
        first.uiBinding?.close();
        workspace.select(index % 2 ? otherKey : secondKey);
        await setup.renderOnce();
      });
      const target = index % 2 ? other : second;
      await until(
        () =>
          target.snapshot.uiContributions?.some(
            (item) =>
              item.key === "probe/owner" &&
              item.snapshot.detail === target.conversationId,
          ) === true,
      );
      expect(target.snapshot.extensionView).toBeUndefined();
      expect(fixture.subscribers()).toBe(3);
      await act(async () => {
        workspace.select(firstKey);
        await setup.renderOnce();
      });
      await until(() => first.uiBinding?.subscription.isLive() === true);
      expect(setup.renderer.keyInput.listenerCount("keypress")).toBe(keyboard);
      expect(setup.renderer.listenerCount("resize")).toBe(resize);
    }
    await act(async () => {
      void first.uiBinding?.open("probe/late");
    });
    await until(() => !!release);
    await act(async () => {
      workspace.select(otherKey);
      await setup.renderOnce();
    });
    await until(() => other.uiBinding?.subscription.isLive() === true);
    await act(async () => {
      release?.();
      await setup.renderOnce();
    });
    expect(sourceAborted).toBe(true);
    expect(other.snapshot.extensionView).toBeUndefined();
    expect(setup.captureCharFrame()).not.toContain("OLD OWNER MUST NOT APPEAR");
    expect(first.snapshot.draft).toBe("Черновик первого");
    expect(second.snapshot.draft).toBe("Черновик второго");
    expect(other.snapshot.draft).toBe("Черновик другого проекта");
  } finally {
    act(() => setup.renderer.destroy());
    workspace.dispose();
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
