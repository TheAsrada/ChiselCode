import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { previousWindowsUpdateFailure } from "../../src/commands/update.js";
import { completeInteractiveExit } from "../../src/ui/interactive-exit.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";
import { loadTerminalDraft } from "../../src/ui/terminal-drafts.js";

if (process.argv.includes("--inspect-update-failure")) {
  console.log(await previousWindowsUpdateFailure());
  process.exit(0);
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const project = process.env.CHISEL_UPDATE_PROJECT;
const installer = process.env.CHISEL_UPDATE_TEST_INSTALLER;
const cleanup = process.env.CHISEL_UPDATE_CLEANUP_MARKER;
assert.ok(project && installer && cleanup);
const payload = await readFile(installer);
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (
    url === "https://api.github.com/repos/TheAsrada/ChiselCode/releases/latest"
  )
    return Response.json({
      tag_name: "v9.9.9",
      assets: [
        {
          name: "ChiselCode-Setup-9.9.9.exe",
          size: payload.length,
          digest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
          browser_download_url: "https://fixture.invalid/installer.exe",
        },
      ],
    });
  if (url === "https://fixture.invalid/installer.exe")
    return new Response(payload);
  throw new Error(`Unexpected network access: ${url}`);
}) as typeof fetch;
const configPath = join(project, "config.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    profiles: {},
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
const ui = await createTestRenderer({ width: 120, height: 36 });
const until = async (ready: () => boolean, message: string) => {
  const deadline = Date.now() + 20000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, message);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 15));
      await ui.renderOnce();
    });
  }
};
const click = async (id: string) => {
  const target = ui.renderer.root.findDescendantById(id);
  assert.ok(target, id);
  await act(async () => {
    await ui.mockMouse.click(target.x + 1, target.y);
  });
};
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: project, configPath, externalExtensions: false },
      undefined,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
  });
  await until(() => !!ui.renderer.currentFocusedEditor, "No native editor");
  await act(async () => {
    await ui.mockInput.pasteBracketedText("Черновик перед обновлением");
  });
  await until(
    () => !!ui.renderer.root.findDescendantById("welcome-update"),
    "No update notice",
  );
  await click("welcome-update");
  await until(
    () => !!ui.renderer.root.findDescendantById("update-primary"),
    "No update popup",
  );
  await click("update-primary");
  await until(
    () => ui.captureCharFrame().includes("Перезапустить"),
    "Installer not prepared",
  );
  const captures = process.env.CHISEL_UPDATE_CAPTURES;
  if (captures) {
    await mkdir(captures, { recursive: true });
    await writeFile(join(captures, "ready.txt"), ui.captureCharFrame());
    await writeFile(
      join(captures, "ready.json"),
      JSON.stringify({
        ...ui.captureSpans(),
        lines: ui.captureSpans().lines.map((line) => ({
          spans: line.spans.map((span) => ({
            ...span,
            fg: span.fg.toInts(),
            bg: span.bg.toInts(),
          })),
        })),
      }),
    );
  }
  await click("update-primary");
  const reason = await application;
  assert.equal(reason, "update");
  assert.equal(await loadTerminalDraft(project), "Черновик перед обновлением");
  await writeFile(
    cleanup,
    JSON.stringify({ reason, draft: "Черновик перед обновлением" }),
  );
  globalThis.fetch = originalFetch;
  // Same boundary as cli.ts, with a pause that would reproduce the old hang.
  await completeInteractiveExit(reason, async () => {
    throw new Error("Update entered the Explorer/--pause wait");
  });
} catch (error) {
  ui.renderer.destroy();
  throw error;
}
