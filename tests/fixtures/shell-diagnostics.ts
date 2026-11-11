import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionToolRuntime } from "../../src/app/tool-runtime.js";
import type { BackgroundControls } from "../../src/background/binding.js";
import { loadGlobalConfig, loadProjectConfig } from "../../src/config/load.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { verifyShellDiagnostics } from "../helpers/shell-diagnostics.js";

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-shell-diagnostics-")),
);
for (const key of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(directory, "home");
const root = join(directory, "проект с пробелами");
await mkdir(root);
const lifetime = new AbortController();
const host = new ExtensionHost(defaultExtensions());
const scope = await host.open(root);
const store = await projectSessionStore(root);
const session = createSession(root, "openai", "fixture");
session.mode = "build";
await store.save(session);
let controls: BackgroundControls | undefined;
try {
  const tools = await createSessionToolRuntime({
    signal: new AbortController().signal,
    root,
    session,
    store,
    scope,
    config: await loadProjectConfig(root),
    global: await loadGlobalConfig(),
    mode: "build",
    approvalMode: "default",
    options: {
      interactive: true,
      allow: "run_shell",
      subagentOwner: {
        conversationId: session.id,
        generation: 0,
        signal: lifetime.signal,
        assertAvailable: () => scope.assertUsable(),
      },
    },
    events: new RuntimeEventBus(session.id),
    resolver: { requestApproval: async () => "approved" },
    onBackgroundControls: (value) => {
      controls = value;
    },
  });
  await tools.refresh();
  await verifyShellDiagnostics(
    root,
    async (call, signal) => {
      const [result] = await tools.scheduler.execute([call], signal);
      if (!result) throw new Error("Missing result");
      return result;
    },
    async (uri) => {
      const result = await tools.executor.execute({
        id: "read-diagnostic",
        name: "read_tool_result",
        input: { uri, limit: 2 },
      });
      if (result.isError) throw new Error(result.output);
      return result.output;
    },
  );
  console.log("Foreground shell diagnostics: passed");
} finally {
  lifetime.abort();
  await controls?.close();
  await scope.dispose();
  await host.dispose();
  await rm(directory, { recursive: true, force: true });
}
